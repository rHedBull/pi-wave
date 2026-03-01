/**
 * Feature executor — runs a single feature's task DAG with sub-worktree isolation.
 *
 * For parallel tasks at the same DAG level:
 *   - Creates sub-worktrees branching from the feature branch
 *   - Runs tasks in parallel, each in its own sub-worktree
 *   - Merges sub-worktrees back into the feature branch
 *
 * For sequential tasks (single task at a DAG level):
 *   - Runs directly in the feature worktree (no sub-worktree overhead)
 */

import {
	commitTaskOutput,
	createSubWorktrees,
	mergeSubWorktrees,
} from "../subagent/git-worktree.js";
import { buildDAG, mapConcurrent } from "./dag.js";
import {
	checkDeclaredFiles,
	extractFinalOutput,
	extractSpecSections,
	runSubagent,
} from "./helpers.js";
import type {
	Feature,
	FeatureResult,
	FeatureWorktree,
	FileAccessRules,
	Task,
	TaskResult,
} from "./types.js";

// ── Public Interface ───────────────────────────────────────────────

export interface FeatureExecutorOptions {
	feature: Feature;
	featureWorktree: FeatureWorktree | null; // null if no git
	waveNum: number;
	specContent: string;
	/** Complete data schemas section from the plan — passed verbatim to every agent. */
	dataSchemas: string;
	protectedPaths: string[];
	cwd: string; // fallback cwd if no worktree
	maxConcurrency: number;
	signal?: AbortSignal;
	/** Task IDs to skip (already completed in a previous run). */
	skipTaskIds?: Set<string>;
	onTaskStart?: (task: Task) => void;
	onTaskEnd?: (task: Task, result: TaskResult) => void;
	onFixCycleStart?: (task: Task) => void;
	onStallRetry?: (task: Task, reason: string) => void;
}

// ── Execute Feature ────────────────────────────────────────────────

export async function executeFeature(opts: FeatureExecutorOptions): Promise<FeatureResult> {
	const {
		feature,
		featureWorktree,
		waveNum,
		specContent,
		dataSchemas,
		protectedPaths,
		cwd,
		maxConcurrency,
		signal,
		skipTaskIds = new Set(),
		onTaskStart,
		onTaskEnd,
		onFixCycleStart,
		onStallRetry,
	} = opts;

	const featureCwd = featureWorktree?.dir ?? cwd;
	const taskResults: TaskResult[] = [];
	const failedIds = new Set<string>();

	const levels = buildDAG(feature.tasks);

	for (const level of levels) {
		if (level.tasks.length === 0) continue;

		// Check if all tasks in this level should be skipped (dependency failed)
		const runnableTasks = level.tasks.filter(
			(t) => !t.depends.some((d) => failedIds.has(d)),
		);
		const skippedTasks = level.tasks.filter(
			(t) => t.depends.some((d) => failedIds.has(d)),
		);

		// Mark skipped tasks
		for (const task of skippedTasks) {
			const skipped: TaskResult = {
				id: task.id,
				title: task.title,
				agent: task.agent,
				exitCode: -1,
				output: "Skipped: dependency failed",
				stderr: "",
				durationMs: 0,
			};
			failedIds.add(task.id);
			taskResults.push(skipped);
			onTaskEnd?.(task, skipped);
		}

		if (runnableTasks.length === 0) continue;

		// Decide isolation strategy
		const useSubWorktrees =
			runnableTasks.length > 1 && featureWorktree !== null;

		let subWorktrees: import("./types.js").SubWorktree[] = [];

		if (useSubWorktrees) {
			subWorktrees = createSubWorktrees(
				featureWorktree!,
				waveNum,
				runnableTasks.map((t) => t.id),
			);
			// If sub-worktree creation failed, fall back to sequential in feature worktree
		}

		const actuallyParallel = subWorktrees.length === runnableTasks.length;
		const subWorktreeMap = new Map(subWorktrees.map((sw) => [sw.taskId, sw]));

		const levelResults = await mapConcurrent(
			runnableTasks,
			actuallyParallel ? maxConcurrency : 1,
			async (task) => {
				// Skip tasks already completed in a previous run
				if (skipTaskIds.has(task.id)) {
					const skipped: TaskResult = {
						id: task.id,
						title: task.title,
						agent: task.agent,
						exitCode: 0,
						output: "↩ Resumed — already completed in previous run",
						stderr: "",
						durationMs: 0,
					};
					onTaskStart?.(task);
					onTaskEnd?.(task, skipped);
					return skipped;
				}

				onTaskStart?.(task);
				const start = Date.now();

				// Determine working directory
				let taskCwd = featureCwd;
				if (actuallyParallel) {
					const sw = subWorktreeMap.get(task.id);
					if (sw) taskCwd = sw.dir;
				}

				// Collect all files from the feature for verifier context
				const featureFiles = task.agent === "wave-verifier"
					? feature.tasks.filter(t => t.agent !== "wave-verifier").flatMap(t => t.files)
					: undefined;

				const result = await runSingleTask(task, taskCwd, specContent, dataSchemas, protectedPaths, signal, onStallRetry, featureFiles);
				const elapsed = Date.now() - start;

				let taskResult: TaskResult = {
					...result,
					durationMs: elapsed,
				};

				// Post-task file existence check for worker/test-writer tasks
				if (result.exitCode === 0 && task.agent !== "wave-verifier" && task.files.length > 0) {
					const missingFiles = checkDeclaredFiles(task.files, taskCwd);
					if (missingFiles.length > 0) {
						taskResult = {
							...taskResult,
							exitCode: 1,
							output: taskResult.output +
								`\n\n⚠️ POST-CHECK FAILED: Task declared these output files but they were not created:\n` +
								missingFiles.map(f => `  - ${f}`).join("\n") +
								`\n\nThe agent exited successfully but did not produce the expected files.`,
						};
					}
				}

				// Fix cycle for verifier failures (max 1 retry)
				if (task.agent === "wave-verifier" && result.exitCode !== 0) {
					onFixCycleStart?.(task);
					const fixResult = await runFixCycle(
						task,
						result,
						feature,
						taskCwd,
						specContent,
						dataSchemas,
						protectedPaths,
						signal,
					);
					if (fixResult) {
						taskResult = { ...fixResult, durationMs: Date.now() - start };
					}
				}

				// Per-task commit — sequential tasks in feature worktree (or base branch)
				// Sub-worktree tasks are committed during mergeSubWorktrees instead.
				if (taskResult.exitCode === 0 && !actuallyParallel) {
					commitTaskOutput(taskCwd, task.id, task.title, task.agent);
				}

				if (taskResult.exitCode !== 0) {
					failedIds.add(task.id);
				}

				onTaskEnd?.(task, taskResult);
				return taskResult;
			},
		);

		taskResults.push(...levelResults);

		// Merge sub-worktrees back into feature branch if we used them
		if (actuallyParallel && subWorktrees.length > 0) {
			mergeSubWorktrees(
				featureWorktree!,
				subWorktrees,
				levelResults.map((r) => ({ taskId: r.id, exitCode: r.exitCode, title: r.title, agent: r.agent })),
			);
		}
	}

	const passed = taskResults.every((r) => r.exitCode === 0 || r.exitCode === -1 && r.output === "Skipped: dependency failed" && false);
	// Feature passes only if no task actually failed (skipped from failed deps counts as failure)
	const allPassed = !taskResults.some((r) => r.exitCode !== 0);

	return {
		name: feature.name,
		branch: featureWorktree?.branch ?? "",
		taskResults,
		passed: allPassed,
	};
}

// ── Run a Single Task ──────────────────────────────────────────────

async function runSingleTask(
	task: Task,
	cwd: string,
	specContent: string,
	dataSchemas: string,
	protectedPaths: string[],
	signal?: AbortSignal,
	onStallRetry?: (task: Task, reason: string) => void,
	/** All files from the feature (for verifier context) */
	allFeatureFiles?: string[],
): Promise<Omit<TaskResult, "durationMs">> {
	const agentName = task.agent || "worker";
	const specContext = extractSpecSections(specContent, task.specRefs);
	const schemasBlock = dataSchemas
		? `\n## Data Schemas (authoritative — use these exact names)\n${dataSchemas}\n`
		: "";
	let agentTask: string;

	if (agentName === "test-writer") {
		agentTask = `You are writing tests as part of a TDD implementation plan.
${schemasBlock}
## Spec Reference
${specContext}

## Your Task
**${task.id}: ${task.title}**
Files to create/modify: ${task.files.join(", ")}
${task.specRefs.length > 0 ? `Spec refs: ${task.specRefs.join(", ")}` : ""}

${task.description}

IMPORTANT:
- Only create/modify TEST files listed for this task
- Tests should FAIL right now (implementation doesn't exist yet)
- Tests define the expected behavior — they are the contract
- Follow existing test patterns in the project
- Do not touch implementation files
- Use exact field names, column names, and type names from the Data Schemas section above
- You may be working in a git worktree. Use relative paths.`;
	} else if (agentName === "wave-verifier") {
		const featureFilesBlock = allFeatureFiles && allFeatureFiles.length > 0
			? `\n## Required Files (MUST ALL EXIST)\nThese files should have been created by prior tasks. Verify EVERY one exists before running tests:\n${allFeatureFiles.map(f => `- \`${f}\``).join("\n")}\n`
			: "";
		agentTask = `You are verifying completed work.
${schemasBlock}
## Spec Reference
${specContext}

## Your Task
**${task.id}: ${task.title}**
${task.files.length > 0 ? `Files to check: ${task.files.join(", ")}` : ""}
${task.specRefs.length > 0 ? `Spec refs: ${task.specRefs.join(", ")}` : ""}
${featureFilesBlock}
${task.description}

IMPORTANT — verify in this order:
1. **File existence** — check that ALL required files listed above actually exist on disk. If ANY are missing, immediately report status "fail" with the list of missing files. Do NOT proceed to tests.
2. **Syntax/compilation** — run the compiler/linter (e.g., \`cargo build\`, \`npx tsc --noEmit\`). If it fails, report "fail".
3. **Tests** — run the test suite. If tests fail, report "fail".
4. **Completeness** — verify the implementation matches the task descriptions (correct types, methods, signatures).
- Do NOT modify any files — only read and run checks
- If working in a git worktree, run tests relative to the worktree root`;
	} else {
		const testContext =
			task.testFiles.length > 0
				? `\nTests to satisfy: ${task.testFiles.join(", ")}\nYour implementation MUST make these tests pass.`
				: "";
		agentTask = `You are implementing code as part of a TDD plan. Tests may have already been written — your job is to make them pass.
${schemasBlock}
## Spec Reference
${specContext}

## Your Task
**${task.id}: ${task.title}**
Files: ${task.files.join(", ")}
${task.specRefs.length > 0 ? `Spec refs: ${task.specRefs.join(", ")}` : ""}${testContext}

${task.description}

IMPORTANT:
- Only modify the IMPLEMENTATION files listed for this task
- Do NOT modify test files
- Your code must make the existing tests pass
- Follow the spec requirements exactly
- Use exact field names, column names, and type names from the Data Schemas section above — they are authoritative and override any names in the spec
- Do not touch files outside your task scope
- You may be working in a git worktree. Use relative paths.`;
	}

	// Build file access rules
	let fileRules: FileAccessRules | undefined;

	if (agentName === "test-writer") {
		fileRules = {
			allowWrite: [...task.files],
			protectedPaths,
			safeBashOnly: true,
		};
	} else if (agentName === "wave-verifier") {
		fileRules = {
			readOnly: true,
			protectedPaths,
			safeBashOnly: false, // needs to run test commands
		};
	} else {
		const blocked = task.testFiles || [];
		fileRules = {
			allowWrite: task.files.filter((f) => !blocked.some((b) => f === b)),
			protectedPaths,
		};
	}

	let result = await runSubagent(agentName, agentTask, cwd, signal, fileRules);

	// Stall retry: if agent got stuck in a loop, interrupt and retry with guidance
	if (result.stall) {
		onStallRetry?.(task, result.stall.reason);
		const stallContext = [
			`\n\n⚠️ IMPORTANT: A previous attempt at this task got stuck.`,
			`Reason: ${result.stall.reason}`,
			`Recent activity before interruption:`,
			...result.stall.recentActivity.map((a) => `  - ${a}`),
			`\nYou MUST take a different approach. Do not repeat the same actions.`,
			`The previous agent's partial work may already be on disk — check what exists before starting.`,
		].join("\n");
		result = await runSubagent(agentName, agentTask + stallContext, cwd, signal, fileRules);
	}

	const output = extractFinalOutput(result.stdout);

	return {
		id: task.id,
		title: task.title,
		agent: agentName,
		exitCode: result.exitCode,
		output: result.timedOut ? `⏰ Task timed out\n${output}` : (output || "(no output)"),
		stderr: result.stderr,
		timedOut: result.timedOut,
	};
}

// ── Fix Cycle ──────────────────────────────────────────────────────

/**
 * When a verifier fails, attempt one fix cycle:
 * 1. Run a fix agent with the verifier output + spec context
 * 2. Re-run the verifier
 *
 * Returns the re-verification result, or null if the fix didn't help.
 */
async function runFixCycle(
	verifierTask: Task,
	verifierResult: Omit<TaskResult, "durationMs">,
	feature: Feature,
	cwd: string,
	specContent: string,
	dataSchemas: string,
	protectedPaths: string[],
	signal?: AbortSignal,
): Promise<Omit<TaskResult, "durationMs"> | null> {
	// Gather all writable files in this feature for the fix agent
	const featureFiles = feature.tasks.flatMap((t) => t.files);
	const schemasBlock = dataSchemas
		? `\n## Data Schemas (authoritative — use these exact names)\n${dataSchemas}\n`
		: "";

	const fixTask = `Fix the issues found during verification:
${schemasBlock}
## Verification Output
${verifierResult.output}

## Spec Context
${extractSpecSections(specContent, verifierTask.specRefs)}

## Files You Can Modify
${featureFiles.join(", ")}

Fix the issues and ensure all tests pass. Use exact names from Data Schemas above. You may be working in a git worktree — use relative paths.`;

	await runSubagent("worker", fixTask, cwd, signal, {
		allowWrite: featureFiles,
		protectedPaths,
	});

	// Re-run verifier (with feature files context)
	const allFeatureFiles = feature.tasks.filter(t => t.agent !== "wave-verifier").flatMap(t => t.files);
	const reResult = await runSingleTask(verifierTask, cwd, specContent, dataSchemas, protectedPaths, signal, undefined, allFeatureFiles);

	// Check if re-verification passed
	let passed = reResult.exitCode === 0;
	if (!passed) {
		try {
			const jsonMatch = reResult.output.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, reResult.output];
			const v = JSON.parse(jsonMatch[1]!.trim());
			passed = v.readyForNextWave === true || v.status === "pass";
		} catch {
			passed = !reResult.output.toLowerCase().includes('"status": "fail"');
		}
	}

	if (passed) {
		return { ...reResult, exitCode: 0 };
	}

	return null; // Fix didn't help
}
