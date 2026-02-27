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
	createSubWorktrees,
	mergeSubWorktrees,
} from "../subagent/git-worktree.js";
import { buildDAG, mapConcurrent } from "./dag.js";
import {
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
	protectedPaths: string[];
	cwd: string; // fallback cwd if no worktree
	maxConcurrency: number;
	signal?: AbortSignal;
	onTaskStart?: (task: Task) => void;
	onTaskEnd?: (task: Task, result: TaskResult) => void;
}

// ── Execute Feature ────────────────────────────────────────────────

export async function executeFeature(opts: FeatureExecutorOptions): Promise<FeatureResult> {
	const {
		feature,
		featureWorktree,
		waveNum,
		specContent,
		protectedPaths,
		cwd,
		maxConcurrency,
		signal,
		onTaskStart,
		onTaskEnd,
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
				onTaskStart?.(task);
				const start = Date.now();

				// Determine working directory
				let taskCwd = featureCwd;
				if (actuallyParallel) {
					const sw = subWorktreeMap.get(task.id);
					if (sw) taskCwd = sw.dir;
				}

				const result = await runSingleTask(task, taskCwd, specContent, protectedPaths, signal);
				const elapsed = Date.now() - start;

				let taskResult: TaskResult = {
					...result,
					durationMs: elapsed,
				};

				// Fix cycle for verifier failures (max 1 retry)
				if (task.agent === "wave-verifier" && result.exitCode !== 0) {
					const fixResult = await runFixCycle(
						task,
						result,
						feature,
						taskCwd,
						specContent,
						protectedPaths,
						signal,
					);
					if (fixResult) {
						taskResult = { ...fixResult, durationMs: Date.now() - start };
					}
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
				levelResults.map((r) => ({ taskId: r.id, exitCode: r.exitCode })),
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
	protectedPaths: string[],
	signal?: AbortSignal,
): Promise<Omit<TaskResult, "durationMs">> {
	const agentName = task.agent || "worker";
	const specContext = extractSpecSections(specContent, task.specRefs);
	let agentTask: string;

	if (agentName === "test-writer") {
		agentTask = `You are writing tests as part of a TDD implementation plan.

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
- You may be working in a git worktree. Use relative paths.`;
	} else if (agentName === "wave-verifier") {
		agentTask = `You are verifying completed work.

## Spec Reference
${specContext}

## Your Task
**${task.id}: ${task.title}**
${task.files.length > 0 ? `Files to check: ${task.files.join(", ")}` : ""}
${task.specRefs.length > 0 ? `Spec refs: ${task.specRefs.join(", ")}` : ""}

${task.description}

IMPORTANT:
- Run the test suite and report results
- Check for type errors, lint issues
- Do NOT modify any files — only read and run checks
- If working in a git worktree, run tests relative to the worktree root`;
	} else {
		const testContext =
			task.testFiles.length > 0
				? `\nTests to satisfy: ${task.testFiles.join(", ")}\nYour implementation MUST make these tests pass.`
				: "";
		agentTask = `You are implementing code as part of a TDD plan. Tests may have already been written — your job is to make them pass.

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

	const result = await runSubagent(agentName, agentTask, cwd, signal, fileRules);
	const output = extractFinalOutput(result.stdout);

	return {
		id: task.id,
		title: task.title,
		agent: agentName,
		exitCode: result.exitCode,
		output: output || "(no output)",
		stderr: result.stderr,
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
	protectedPaths: string[],
	signal?: AbortSignal,
): Promise<Omit<TaskResult, "durationMs"> | null> {
	// Gather all writable files in this feature for the fix agent
	const featureFiles = feature.tasks.flatMap((t) => t.files);

	const fixTask = `Fix the issues found during verification:

## Verification Output
${verifierResult.output}

## Spec Context
${extractSpecSections(specContent, verifierTask.specRefs)}

## Files You Can Modify
${featureFiles.join(", ")}

Fix the issues and ensure all tests pass. You may be working in a git worktree — use relative paths.`;

	await runSubagent("worker", fixTask, cwd, signal, {
		allowWrite: featureFiles,
		protectedPaths,
	});

	// Re-run verifier
	const reResult = await runSingleTask(verifierTask, cwd, specContent, protectedPaths, signal);

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
