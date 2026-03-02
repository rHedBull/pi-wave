/**
 * Shared wave execution loop used by both /waves-execute and /waves-continue.
 *
 * Handles: wave iteration, widget updates, progress callbacks,
 * failure reporting, execution logging, state persistence, final summary.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Container, Text } from "@mariozechner/pi-tui";
import {
	advanceToWave,
	completedTaskIds,
	deleteState,
	markTaskDone,
	markTaskFailed,
	markTaskSkipped,
	writeState,
} from "./state.js";
import type { ExecutionState, MergeResult, Plan, WaveResult } from "./types.js";
import { executeWave } from "./wave-executor.js";
import { createTaskTracker, extractBriefError, formatElapsed, taskLine } from "./widget.js";

// ── Config ─────────────────────────────────────────────────────────

export interface RunConfig {
	plan: Plan;
	planFile: string;
	specContent: string;
	cwd: string;
	startWave: number;
	skipSet: Set<string>;
	execState: ExecutionState;
	logPath: string;
	logLines: string[];
	taskLogDir: string;
	protectedPaths: string[];
	maxConcurrency: number;
	isResume: boolean;
	/** The pi extension API (for sendMessage) */
	pi: ExtensionAPI;
	/** The command context (for ui.setWidget, ui.setStatus, ui.theme, cwd) */
	ctx: any;
}

// ── Runner ─────────────────────────────────────────────────────────

export async function runWaveExecution(cfg: RunConfig): Promise<void> {
	const {
		plan, planFile, specContent, cwd, startWave, skipSet, execState,
		logPath, logLines, taskLogDir, protectedPaths,
		maxConcurrency, isResume, pi, ctx,
	} = cfg;

	const totalTasks = plan.waves.reduce(
		(s, w) => s + w.foundation.length + w.features.reduce((fs2, f) => fs2 + f.tasks.length, 0) + w.integration.length,
		0,
	);

	const controller = new AbortController();
	const waveResults: WaveResult[] = [];
	let allPassed = true;
	let totalCompleted = 0;
	const resumeTag = isResume ? " (resumed)" : "";

	const writeLog = () => {
		fs.mkdirSync(path.dirname(logPath), { recursive: true });
		fs.writeFileSync(logPath, logLines.join("\n"), "utf-8");
	};

	// ── Wave Loop ────────────────────────────────────────────────

	for (let wi = startWave; wi < plan.waves.length; wi++) {
		const wave = plan.waves[wi];
		const waveLabel = `Wave ${wi + 1}/${plan.waves.length}: ${wave.name}`;
		const waveTasks = [
			...wave.foundation,
			...wave.features.flatMap((f) => f.tasks),
			...wave.integration,
		];

		advanceToWave(execState, wi);
		ctx.ui.setStatus("waves", ctx.ui.theme.fg("accent", `⚡ ${waveLabel}${resumeTag}`));
		logLines.push(`## ${waveLabel}`, "");

		// Progress tracking
		let completed = 0;
		const tracker = createTaskTracker(waveTasks);

		// Mark already-completed tasks (resume only)
		for (const t of waveTasks) {
			if (skipSet.has(t.id)) tracker.statuses.set(t.id, "done");
		}

		let currentPhase: string | null = null;
		const mergeResults: MergeResult[] = [];

		// ── Widget ─────────────────────────────────────────────

		const updateWidget = () => {
			ctx.ui.setWidget("wave-progress", (_tui: any, theme: any) => {
				const container = new Container();
				container.addChild(new Text(
					theme.fg("accent", `⚡ ${waveLabel}${resumeTag} — ${completed}/${waveTasks.length} done`),
					1, 0,
				));

				// Foundation
				if (wave.foundation.length > 0) {
					container.addChild(new Text(theme.fg("dim", "  Foundation:"), 1, 0));
					for (const t of wave.foundation) {
						container.addChild(new Text(`    ${taskLine(ctx.ui.theme, t, tracker)}`, 1, 0));
					}
				}

				// Features
				for (const feature of wave.features) {
					if (feature.name !== "default") {
						container.addChild(new Text(theme.fg("dim", `  Feature: ${feature.name}`), 1, 0));
					}
					for (const t of feature.tasks) {
						const indent = feature.name !== "default" ? "    " : "  ";
						container.addChild(new Text(`${indent}${taskLine(ctx.ui.theme, t, tracker)}`, 1, 0));
					}
				}

				// Merge
				if (currentPhase === "merge" && mergeResults.length === 0) {
					container.addChild(new Text(theme.fg("dim", "  Merge:"), 1, 0));
					container.addChild(new Text(`    ${theme.fg("warning", "⏳")} Merging feature branches...`, 1, 0));
				} else if (mergeResults.length > 0) {
					container.addChild(new Text(theme.fg("dim", "  Merge:"), 1, 0));
					for (const mr of mergeResults) {
						const icon = mr.success
							? (mr.hadChanges ? theme.fg("success", "✓") : theme.fg("muted", "⏭"))
							: theme.fg("error", "✗");
						const label = mr.hadChanges
							? `${mr.source} → ${mr.target}`
							: `${mr.source} (no changes)`;
						container.addChild(new Text(`    ${icon} ${label}`, 1, 0));
					}
				}

				// Integration
				if (wave.integration.length > 0) {
					container.addChild(new Text(theme.fg("dim", "  Integration:"), 1, 0));
					for (const t of wave.integration) {
						container.addChild(new Text(`    ${taskLine(ctx.ui.theme, t, tracker)}`, 1, 0));
					}
				}

				const overallDone = totalCompleted + completed;
				container.addChild(new Text("", 0, 0));
				container.addChild(new Text(theme.fg("dim", `Overall: ${overallDone}/${totalTasks} tasks`), 1, 0));
				return container;
			});
		};

		updateWidget();
		const refreshTimer = setInterval(updateWidget, 2000);

		// ── Execute ────────────────────────────────────────────

		const currentSkipSet = completedTaskIds(execState);

		const waveResult = await executeWave({
			wave,
			waveNum: wi + 1,
			specContent,
			dataSchemas: plan.dataSchemas,
			protectedPaths,
			cwd,
			maxConcurrency,
			signal: controller.signal,
			skipTaskIds: currentSkipSet,
			taskLogDir,
			onProgress: (update) => {
				currentPhase = update.phase;
				updateWidget();
			},
			onTaskStart: (_phase, task) => {
				tracker.statuses.set(task.id, "running");
				tracker.startTimes.set(task.id, Date.now());
				updateWidget();
			},
			onTaskEnd: (_phase, task, result) => {
				const status =
					result.timedOut ? "timeout" :
					result.exitCode === 0 ? "done" :
					result.exitCode === -1 ? "skipped" : "failed";
				tracker.statuses.set(task.id, status);

				// Duration
				const startTime = tracker.startTimes.get(task.id);
				if (startTime) tracker.durations.set(task.id, Date.now() - startTime);

				// Error reason
				if (result.exitCode !== 0 && result.exitCode !== -1) {
					tracker.errors.set(task.id, extractBriefError(result));
				}

				// Fix cycle outcome
				if (tracker.fixCycles.has(task.id)) {
					tracker.fixCycleResults.set(task.id, result.exitCode === 0);
					tracker.fixCycles.delete(task.id);
				}

				completed++;

				// Persist for resume
				if (result.exitCode === 0) markTaskDone(execState, task.id);
				else if (result.exitCode === -1) markTaskSkipped(execState, task.id);
				else markTaskFailed(execState, task.id);
				writeState(planFile, execState);
				updateWidget();
			},
			onFixCycleStart: (_phase, task) => {
				tracker.fixCycles.add(task.id);
				updateWidget();
			},
			onStallRetry: (_phase, task, reason) => {
				tracker.stallRetries.add(task.id);
				tracker.stallReasons.set(task.id, reason);
				tracker.startTimes.set(task.id, Date.now());
				updateWidget();
			},
			onMergeResult: (result) => {
				mergeResults.push(result);
				updateWidget();
			},
			onLog: (line) => logLines.push(line),
		});

		clearInterval(refreshTimer);
		totalCompleted += completed;
		waveResults.push(waveResult);

		// ── Report ─────────────────────────────────────────────

		if (!waveResult.passed) {
			allPassed = false;
			reportWaveFailure(pi, wave.name, waveResult, tracker);
			writeLog();
			break; // Stop at first failed wave
		} else {
			const allResults = [
				...waveResult.foundationResults,
				...waveResult.featureResults.flatMap((f) => f.taskResults),
				...waveResult.integrationResults,
			];
			const passCount = allResults.filter((r) => r.exitCode === 0).length;
			pi.sendMessage(
				{ customType: "wave-pass", content: `✅ **${wave.name}** — ${passCount}/${allResults.length} tasks passed`, display: true },
				{ triggerTurn: false },
			);
		}

		writeLog();
	}

	// ── Final Summary ────────────────────────────────────────────

	ctx.ui.setWidget("wave-progress", undefined);

	logLines.push("---", "", `Finished: ${new Date().toISOString()}`);
	const stoppedEarly = !allPassed && waveResults.length < plan.waves.length - startWave;
	logLines.push(`Result: ${allPassed ? "SUCCESS" : stoppedEarly ? "STOPPED — wave failed" : "COMPLETED WITH ISSUES"}`);
	writeLog();

	if (allPassed) deleteState(planFile);

	const icon = allPassed ? "✅" : "❌";
	const verb = isResume
		? (allPassed ? "Resume Complete" : "Resume Stopped")
		: (allPassed ? "Execution Complete" : stoppedEarly ? "Execution Stopped" : "Execution Complete (with issues)");

	let finalSummary = `# ${icon} ${verb}\n\n`;
	finalSummary += `**Goal:** ${plan.goal}\n`;
	finalSummary += `**Tasks:** ${totalCompleted}/${totalTasks}\n`;
	if (!isResume) {
		finalSummary += `**Waves:** ${waveResults.length}/${plan.waves.length}${stoppedEarly ? " (stopped at failure)" : ""}\n`;
	}
	finalSummary += "\n";

	for (const wr of waveResults) {
		const allResults = [
			...wr.foundationResults,
			...wr.featureResults.flatMap((f) => f.taskResults),
			...wr.integrationResults,
		];
		const passed = allResults.filter((r) => r.exitCode === 0).length;
		const wIcon = wr.passed ? "✅" : "❌";
		const featureInfo = wr.featureResults.length > 0
			? ` (${wr.featureResults.filter((f) => f.passed).length}/${wr.featureResults.length} features)`
			: "";
		finalSummary += `${wIcon} **${wr.wave}**: ${passed}/${allResults.length} tasks${featureInfo}\n`;
	}

	if (!allPassed) {
		finalSummary += `\nRun \`/waves-continue\` to retry after fixing issues.`;
	}
	finalSummary += `\n📄 Execution log: \`${path.relative(cwd, logPath)}\``;
	finalSummary += `\n📂 Task logs: \`${path.relative(cwd, taskLogDir)}/\``;

	pi.sendMessage(
		{ customType: "wave-complete", content: finalSummary, display: true },
		{ triggerTurn: false },
	);

	const statusMsg = allPassed
		? ctx.ui.theme.fg("success", `✅ ${isResume ? "Resume" : "Done"} — ${totalCompleted} tasks`)
		: ctx.ui.theme.fg("error", `❌ ${isResume ? "Resume stopped" : "Stopped"} — wave ${startWave + waveResults.length} failed. /waves-continue to retry`);
	ctx.ui.setStatus("waves", statusMsg);
	setTimeout(() => ctx.ui.setStatus("waves", undefined), 15000);
}

// ── Failure Reporting ──────────────────────────────────────────────

function reportWaveFailure(
	pi: ExtensionAPI,
	waveName: string,
	waveResult: WaveResult,
	tracker: ReturnType<typeof createTaskTracker>,
): void {
	const allResults = [
		...waveResult.foundationResults,
		...waveResult.featureResults.flatMap((f) => f.taskResults),
		...waveResult.integrationResults,
	];

	// Failed tasks
	const failedTasks = allResults.filter((r) => r.exitCode !== 0 && r.exitCode !== -1);
	if (failedTasks.length > 0) {
		const failMsg = failedTasks.map((t) => {
			const err = tracker.errors.get(t.id) || extractBriefError(t);
			const stallReason = tracker.stallReasons.get(t.id);
			const fixResult = tracker.fixCycleResults.get(t.id);
			let detail = `  - **${t.id}**: ${t.title}`;
			detail += `\n    Error: ${err}`;
			if (stallReason) detail += `\n    Stall: ${stallReason}`;
			if (fixResult === false) detail += `\n    Fix cycle: attempted and failed`;
			if (t.durationMs) detail += `\n    Duration: ${formatElapsed(t.durationMs)}`;
			return detail;
		}).join("\n");
		pi.sendMessage(
			{ customType: "wave-task-failures", content: `❌ **${waveName}** failed:\n\n${failMsg}`, display: true },
			{ triggerTurn: false },
		);
	}

	// Skipped tasks (downstream of failures)
	const skippedTasks = allResults.filter((r) => r.exitCode === -1);
	if (skippedTasks.length > 0) {
		const skipMsg = skippedTasks.map((t) => `  - ${t.id}: ${t.title}`).join("\n");
		pi.sendMessage(
			{ customType: "wave-task-skipped", content: `⏭ **${waveName}** — ${skippedTasks.length} task(s) skipped (dependency failed):\n${skipMsg}`, display: true },
			{ triggerTurn: false },
		);
	}

	// Failed features with per-task breakdown
	const failedFeatures = waveResult.featureResults.filter((f) => !f.passed);
	if (failedFeatures.length > 0) {
		const fMsg = failedFeatures.map((f) => {
			const failedInFeature = f.taskResults.filter((t) => t.exitCode !== 0 && t.exitCode !== -1);
			const taskDetails = failedInFeature.map((t) => {
				const err = tracker.errors.get(t.id) || extractBriefError(t);
				return `    - ${t.id}: ${err}`;
			}).join("\n");
			return `  - Feature "${f.name}":\n${taskDetails || "    (unknown failure)"}`;
		}).join("\n");
		pi.sendMessage(
			{ customType: "wave-feature-failures", content: `⚠️ **${waveName}** — ${failedFeatures.length} feature(s) failed:\n${fMsg}`, display: true },
			{ triggerTurn: false },
		);
	}
}
