/**
 * Wave executor — runs a complete wave: foundation → features → merge → integration.
 *
 * Foundation: sequential tasks on the base branch, committed before features start
 * Features: parallel execution, each in its own git worktree
 * Merge: feature branches merge into base
 * Integration: sequential tasks on the merged result
 */

import {
	checkpointChanges,
	cleanupAll,
	createFeatureWorktree,
	getCurrentBranch,
	getRepoRoot,
	hasUncommittedChanges,
	isGitRepo,
	mergeFeatureBranches,
} from "../subagent/git-worktree.js";
import { executeDAG, mapConcurrent } from "./dag.js";
import { executeFeature } from "./feature-executor.js";
import {
	extractFinalOutput,
	extractSpecSections,
	runSubagent,
} from "./helpers.js";
import type {
	FeatureResult,
	FeatureWorktree,
	MergeResult,
	ProgressUpdate,
	Task,
	TaskResult,
	Wave,
	WaveResult,
} from "./types.js";

// ── Public Interface ───────────────────────────────────────────────

export interface WaveExecutorOptions {
	wave: Wave;
	waveNum: number;
	specContent: string;
	protectedPaths: string[];
	cwd: string;
	maxConcurrency: number;
	signal?: AbortSignal;
	/** Task IDs to skip (already completed in a previous run). */
	skipTaskIds?: Set<string>;
	/** Whether foundation was already committed in a previous run of this wave. */
	skipFoundationCommit?: boolean;
	/** Whether features were already merged in a previous run of this wave. */
	skipFeatureMerge?: boolean;
	onProgress?: (update: ProgressUpdate) => void;
	onTaskStart?: (phase: string, task: Task) => void;
	onTaskEnd?: (phase: string, task: Task, result: TaskResult) => void;
	onFixCycleStart?: (phase: string, task: Task) => void;
	onStallRetry?: (phase: string, task: Task, reason: string) => void;
	onMergeResult?: (result: MergeResult) => void;
	onLog?: (line: string) => void;
}

// ── Execute Wave ───────────────────────────────────────────────────

export async function executeWave(opts: WaveExecutorOptions): Promise<WaveResult> {
	const {
		wave,
		waveNum,
		specContent,
		protectedPaths,
		cwd,
		maxConcurrency,
		signal,
		skipTaskIds = new Set(),
		skipFoundationCommit = false,
		skipFeatureMerge = false,
		onProgress,
		onTaskStart,
		onTaskEnd,
		onFixCycleStart,
		onStallRetry,
		onMergeResult,
		onLog,
	} = opts;

	const foundationResults: TaskResult[] = [];
	const featureResults: FeatureResult[] = [];
	const integrationResults: TaskResult[] = [];

	const useGit = isGitRepo(cwd);
	let repoRoot: string | null = null;
	let checkpointSha: string | null = null;

	if (useGit) {
		repoRoot = getRepoRoot(cwd);
	}

	// Track all created worktrees for emergency cleanup
	const allFeatureWorktrees: FeatureWorktree[] = [];

	try {
		// ── Skip helper: wraps a task runner to short-circuit completed tasks ──

		const wrapWithSkip = (
			phase: string,
			actualRun: (task: Task) => Promise<TaskResult>,
		) => {
			return async (task: Task): Promise<TaskResult> => {
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
					onTaskStart?.(phase, task);
					onTaskEnd?.(phase, task, skipped);
					logTaskResult(onLog, task, skipped);
					return skipped;
				}
				return actualRun(task);
			};
		};

		// ── 1. Foundation Phase ─────────────────────────────────────

		if (wave.foundation.length > 0) {
			onProgress?.({ phase: "foundation", currentTasks: wave.foundation.map((t) => ({ id: t.id, status: "pending" })) });
			onLog?.("### Foundation");

			const fResults = await executeDAG(
				wave.foundation,
				wrapWithSkip("foundation", async (task) => {
					onTaskStart?.("foundation", task);
					const start = Date.now();
					const result = await runTaskOnBase(task, cwd, specContent, protectedPaths, signal,
						(t, reason) => onStallRetry?.("foundation", t, reason));
					const taskResult: TaskResult = { ...result, durationMs: Date.now() - start };
					onTaskEnd?.("foundation", task, taskResult);
					logTaskResult(onLog, task, taskResult);
					return taskResult;
				}),
				maxConcurrency,
			);
			foundationResults.push(...fResults);

			const foundationFailed = fResults.some((r) => r.exitCode !== 0);
			if (foundationFailed) {
				onLog?.("\nFoundation FAILED — skipping features and integration\n");
				return {
					wave: wave.name,
					foundationResults,
					featureResults,
					integrationResults,
					passed: false,
				};
			}

			// Commit foundation to base branch (skip if already committed in previous run)
			if (useGit && repoRoot && !skipFoundationCommit) {
				try {
					if (hasUncommittedChanges(repoRoot)) {
						const { execSync } = await import("node:child_process");
						execSync("git add -A", { cwd: repoRoot, stdio: "pipe" });
						execSync(
							`git commit -m "pi: wave ${waveNum} foundation"`,
							{ cwd: repoRoot, stdio: "pipe" },
						);
					}
				} catch {
					// Commit failure is non-fatal — features still run
				}
			}

			onLog?.("");
		}

		// ── 2. Feature Phase ───────────────────────────────────────

		if (wave.features.length > 0) {
			const featureStatuses = wave.features.map((f) => ({
				name: f.name,
				status: "pending" as "pending" | "running" | "done" | "failed",
			}));
			onProgress?.({ phase: "features", features: featureStatuses });
			onLog?.("### Features");

			// Single feature with name "default" → no git isolation needed
			const isSingleDefault =
				wave.features.length === 1 && wave.features[0].name === "default";

			// Create feature worktrees (if git and multiple features)
			const featureWorktreeMap = new Map<string, FeatureWorktree | null>();

			if (useGit && !isSingleDefault) {
				for (const feature of wave.features) {
					const wt = createFeatureWorktree(repoRoot!, waveNum, feature.name);
					featureWorktreeMap.set(feature.name, wt);
					if (wt) allFeatureWorktrees.push(wt);
				}
			}

			// Execute features in parallel
			const perFeatureConcurrency = Math.max(
				2,
				Math.ceil(maxConcurrency / wave.features.length),
			);

			const fResults = await mapConcurrent(
				wave.features,
				// If not using git isolation, run features sequentially to avoid file conflicts
				useGit && !isSingleDefault ? wave.features.length : 1,
				async (feature, idx) => {
					featureStatuses[idx].status = "running";
					onProgress?.({ phase: "features", features: featureStatuses });
					onLog?.(`\n#### Feature: ${feature.name}`);

					const featureWorktree = featureWorktreeMap.get(feature.name) ?? null;

					const result = await executeFeature({
						feature,
						featureWorktree,
						waveNum,
						specContent,
						protectedPaths,
						cwd,
						maxConcurrency: perFeatureConcurrency,
						signal,
						skipTaskIds,
						onTaskStart: (task) => onTaskStart?.(`feature:${feature.name}`, task),
						onTaskEnd: (task, tr) => {
							onTaskEnd?.(`feature:${feature.name}`, task, tr);
							logTaskResult(onLog, task, tr);
						},
						onFixCycleStart: (task) => onFixCycleStart?.(`feature:${feature.name}`, task),
						onStallRetry: (task, reason) => onStallRetry?.(`feature:${feature.name}`, task, reason),
					});

					featureStatuses[idx].status = result.passed ? "done" : "failed";
					onProgress?.({ phase: "features", features: featureStatuses });

					return result;
				},
			);

			featureResults.push(...fResults);
			onLog?.("");

			// ── 3. Merge Phase ─────────────────────────────────────

			if (useGit && !isSingleDefault && allFeatureWorktrees.length > 0) {
				onProgress?.({ phase: "merge" });
				onLog?.("### Merge");

				const mergeResults = mergeFeatureBranches(
					repoRoot!,
					allFeatureWorktrees,
					fResults.map((r) => ({ featureName: r.name, passed: r.passed })),
				);

				for (const mr of mergeResults) onMergeResult?.(mr);
				logMergeResults(onLog, mergeResults);

				const mergeConflicts = mergeResults.filter((m) => !m.success && m.hadChanges);
				if (mergeConflicts.length > 0) {
					onLog?.("\nMerge conflicts detected — skipping integration\n");
					return {
						wave: wave.name,
						foundationResults,
						featureResults,
						integrationResults,
						passed: false,
					};
				}

				onLog?.("");
			}

			// Check if any feature failed
			const anyFeatureFailed = fResults.some((r) => !r.passed);
			if (anyFeatureFailed) {
				onLog?.("\nOne or more features failed — skipping integration\n");
				return {
					wave: wave.name,
					foundationResults,
					featureResults,
					integrationResults,
					passed: false,
				};
			}
		}

		// ── 4. Integration Phase ───────────────────────────────────

		if (wave.integration.length > 0) {
			onProgress?.({
				phase: "integration",
				currentTasks: wave.integration.map((t) => ({ id: t.id, status: "pending" })),
			});
			onLog?.("### Integration");

			const iResults = await executeDAG(
				wave.integration,
				wrapWithSkip("integration", async (task) => {
					onTaskStart?.("integration", task);
					const start = Date.now();
					const result = await runTaskOnBase(task, cwd, specContent, protectedPaths, signal,
						(t, reason) => onStallRetry?.("integration", t, reason));
					let taskResult: TaskResult = { ...result, durationMs: Date.now() - start };

					// Fix cycle for integration verifier failures
					if (task.agent === "wave-verifier" && result.exitCode !== 0) {
						onFixCycleStart?.("integration", task);
						const fixResult = await runIntegrationFixCycle(
							task,
							result,
							wave,
							cwd,
							specContent,
							protectedPaths,
							signal,
						);
						if (fixResult) {
							taskResult = { ...fixResult, durationMs: Date.now() - start };
						}
					}

					onTaskEnd?.("integration", task, taskResult);
					logTaskResult(onLog, task, taskResult);
					return taskResult;
				}),
				maxConcurrency,
			);
			integrationResults.push(...iResults);

			onLog?.("");
		}

		const passed =
			foundationResults.every((r) => r.exitCode === 0) &&
			featureResults.every((r) => r.passed) &&
			integrationResults.every((r) => r.exitCode === 0);

		return {
			wave: wave.name,
			foundationResults,
			featureResults,
			integrationResults,
			passed,
		};
	} catch (e: any) {
		// Emergency cleanup
		if (repoRoot && allFeatureWorktrees.length > 0) {
			cleanupAll(repoRoot, allFeatureWorktrees, []);
		}
		throw e;
	}
}

// ── Run Task on Base Branch ────────────────────────────────────────

async function runTaskOnBase(
	task: Task,
	cwd: string,
	specContent: string,
	protectedPaths: string[],
	signal?: AbortSignal,
	onStallRetry?: (task: Task, reason: string) => void,
): Promise<Omit<TaskResult, "durationMs">> {
	const agentName = task.agent || "worker";
	const specContext = extractSpecSections(specContent, task.specRefs);

	let agentTask: string;

	if (agentName === "wave-verifier") {
		agentTask = `You are verifying completed work.

## Spec Reference
${specContext}

## Your Task
**${task.id}: ${task.title}**
${task.files.length > 0 ? `Files to check: ${task.files.join(", ")}` : ""}

${task.description}

IMPORTANT:
- Run the test suite and report results
- Check for type errors, lint issues
- Do NOT modify any files`;
	} else if (agentName === "test-writer") {
		agentTask = `You are writing tests.

## Spec Reference
${specContext}

## Your Task
**${task.id}: ${task.title}**
Files: ${task.files.join(", ")}

${task.description}

IMPORTANT:
- Only create/modify TEST files listed for this task
- Follow existing test patterns`;
	} else {
		const testContext =
			task.testFiles.length > 0
				? `\nTests to satisfy: ${task.testFiles.join(", ")}\nYour implementation MUST make these tests pass.`
				: "";
		agentTask = `You are implementing code.

## Spec Reference
${specContext}

## Your Task
**${task.id}: ${task.title}**
Files: ${task.files.join(", ")}${testContext}

${task.description}

IMPORTANT:
- Only modify files listed for this task
- Follow the spec requirements exactly`;
	}

	// File access rules
	let fileRules: import("./types.js").FileAccessRules | undefined;

	if (agentName === "test-writer") {
		fileRules = { allowWrite: [...task.files], protectedPaths, safeBashOnly: true };
	} else if (agentName === "wave-verifier") {
		fileRules = { readOnly: true, protectedPaths, safeBashOnly: false };
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

// ── Integration Fix Cycle ──────────────────────────────────────────

async function runIntegrationFixCycle(
	verifierTask: Task,
	verifierResult: Omit<TaskResult, "durationMs">,
	wave: Wave,
	cwd: string,
	specContent: string,
	protectedPaths: string[],
	signal?: AbortSignal,
): Promise<Omit<TaskResult, "durationMs"> | null> {
	// Integration fix agent gets access to all files
	const allFiles = [
		...wave.foundation.flatMap((t) => t.files),
		...wave.features.flatMap((f) => f.tasks.flatMap((t) => t.files)),
		...wave.integration.flatMap((t) => t.files),
	];

	const fixTask = `Fix the issues found during integration verification:

## Verification Output
${verifierResult.output}

## Spec Context
${extractSpecSections(specContent, verifierTask.specRefs)}

## Files You Can Modify
${allFiles.join(", ")}

Fix the issues and ensure all tests pass.`;

	await runSubagent("worker", fixTask, cwd, signal, {
		allowWrite: allFiles,
		protectedPaths,
	});

	// Re-verify (no stall callback — this is already inside a fix cycle)
	const reResult = await runTaskOnBase(verifierTask, cwd, specContent, protectedPaths, signal);

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

	return passed ? { ...reResult, exitCode: 0 } : null;
}

// ── Logging Helpers ────────────────────────────────────────────────

function logTaskResult(
	onLog: ((line: string) => void) | undefined,
	task: Task,
	result: TaskResult,
): void {
	if (!onLog) return;
	const icon = result.timedOut ? "⏰" : result.exitCode === 0 ? "✅" : result.exitCode === -1 ? "⏭️" : "❌";
	const agentEmoji =
		task.agent === "test-writer" ? "🧪" : task.agent === "wave-verifier" ? "🔍" : "🔨";
	const suffix = result.timedOut ? " **TIMED OUT**" : "";
	onLog(`${icon} ${agentEmoji} **${task.id}** [${task.agent}]: ${task.title} (${(result.durationMs / 1000).toFixed(1)}s)${suffix}`);
	if (result.exitCode !== 0 && result.exitCode !== -1) {
		onLog(`   Error: ${result.stderr.slice(0, 200)}`);
	}
}

function logMergeResults(
	onLog: ((line: string) => void) | undefined,
	results: MergeResult[],
): void {
	if (!onLog) return;
	for (const r of results) {
		if (r.success && r.hadChanges) {
			onLog(`✅ Merged: ${r.source} → ${r.target}`);
		} else if (r.success && !r.hadChanges) {
			onLog(`⏭️ No changes: ${r.source}`);
		} else if (r.error) {
			onLog(`❌ ${r.error}`);
		}
	}
}
