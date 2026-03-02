/**
 * Progress widget helpers for wave execution display.
 *
 * TaskTracker holds per-task state (status, duration, errors, stalls, fix cycles).
 * taskLine() renders a single task as a themed string for the progress widget.
 */

import type { Task, TaskResult } from "./types.js";

// ── Task Tracker ───────────────────────────────────────────────────

/** Per-task tracking state for rich progress display. */
export interface TaskTracker {
	statuses: Map<string, string>;
	startTimes: Map<string, number>;
	durations: Map<string, number>;       // elapsed ms for completed tasks
	errors: Map<string, string>;          // brief error reason for failed tasks
	stallReasons: Map<string, string>;    // stall detection reason
	fixCycles: Set<string>;               // tasks currently in fix cycle
	fixCycleResults: Map<string, boolean>; // fix cycle outcomes (true = succeeded)
	stallRetries: Set<string>;            // tasks currently retrying after stall
}

export function createTaskTracker(tasks: Task[]): TaskTracker {
	const statuses = new Map<string, string>();
	for (const t of tasks) statuses.set(t.id, "pending");
	return {
		statuses,
		startTimes: new Map(),
		durations: new Map(),
		errors: new Map(),
		stallReasons: new Map(),
		fixCycles: new Set(),
		fixCycleResults: new Map(),
		stallRetries: new Set(),
	};
}

// ── Error Extraction ───────────────────────────────────────────────

/**
 * Extract a brief, human-readable error reason from a task result.
 * Used for widget display and failure messages. Max ~100 chars.
 */
export function extractBriefError(result: TaskResult): string {
	if (result.timedOut) return "timed out";

	// Post-check failure (missing files)
	const postCheck = result.output.match(/POST-CHECK FAILED:\s*([^\n]+)/);
	if (postCheck) return postCheck[1].trim().slice(0, 100);

	// Stall
	const stallMatch = result.stderr.match(/Agent stalled:\s*(.+)/);
	if (stallMatch) return `stall: ${stallMatch[1].trim().slice(0, 80)}`;

	// First meaningful line of stderr
	if (result.stderr) {
		const lines = result.stderr.split("\n").filter((l) => l.trim());
		const meaningful = lines.find((l) => !l.startsWith("Task timed out"));
		if (meaningful) return meaningful.trim().slice(0, 100);
	}

	// Look for failure-related lines in output
	const outputLines = result.output.split("\n");
	const failLine = outputLines.find((l) =>
		/\bfail|error|exception|assert|missing|not found/i.test(l) && l.trim().length > 5,
	);
	if (failLine) return failLine.trim().slice(0, 100);

	return "exit code " + result.exitCode;
}

// ── Display Helpers ────────────────────────────────────────────────

export function statusIcon(theme: any, status: string): string {
	switch (status) {
		case "done": return theme.fg("success", "✓");
		case "failed": return theme.fg("error", "✗");
		case "timeout": return theme.fg("error", "⏰");
		case "running": return theme.fg("warning", "⏳");
		case "retrying": return theme.fg("warning", "🔄");
		case "fixing": return theme.fg("warning", "🔧");
		case "skipped": return theme.fg("muted", "⏭");
		default: return theme.fg("muted", "○");
	}
}

export function agentTag(t: Task): string {
	return t.agent === "test-writer" ? "🧪" : t.agent === "wave-verifier" ? "🔍" : "🔨";
}

export function formatElapsed(ms: number): string {
	const seconds = Math.floor(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const secs = seconds % 60;
	return `${minutes}m ${secs.toString().padStart(2, "0")}s`;
}

export function taskLine(theme: any, t: Task, tracker: TaskTracker): string {
	const status = tracker.statuses.get(t.id) ?? "pending";
	const isFixing = tracker.fixCycles.has(t.id);
	const isRetrying = tracker.stallRetries.has(t.id);
	const effectiveStatus = isRetrying ? "retrying" : isFixing ? "fixing" : status;
	const icon = statusIcon(theme, effectiveStatus);
	const tag = agentTag(t);
	let line = `${icon} ${tag} ${t.id}: ${t.title}`;

	// Elapsed time — running (live) or completed (final)
	if (status === "running") {
		const startTime = tracker.startTimes.get(t.id);
		if (startTime) {
			line += theme.fg("dim", ` (${formatElapsed(Date.now() - startTime)})`);
		}
	} else if (tracker.durations.has(t.id)) {
		line += theme.fg("dim", ` (${formatElapsed(tracker.durations.get(t.id)!)})`);
	}

	// Status annotations
	if (status === "running" && isRetrying) {
		const reason = tracker.stallReasons.get(t.id);
		line += theme.fg("warning", ` [stall → retry${reason ? ": " + reason.slice(0, 50) : ""}]`);
	} else if (status === "running" && isFixing) {
		line += theme.fg("warning", " [fix cycle]");
	} else if (status === "failed" || status === "timeout") {
		const err = tracker.errors.get(t.id);
		if (err) line += theme.fg("error", ` — ${err}`);
		const fixResult = tracker.fixCycleResults.get(t.id);
		if (fixResult === false) line += theme.fg("error", " [fix failed]");
	} else if (status === "done") {
		const fixResult = tracker.fixCycleResults.get(t.id);
		if (fixResult === true) line += theme.fg("success", " [fix succeeded]");
	} else if (status === "skipped") {
		line += theme.fg("muted", " (dep failed)");
	}

	return line;
}
