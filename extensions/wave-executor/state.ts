/**
 * Execution state persistence — tracks completed tasks for resume.
 *
 * State file lives alongside the plan file: {plan-file}.state.json
 * Only tasks with status "done" are skipped on resume.
 * Failed/skipped tasks always re-run.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExecutionState } from "./types.js";

// ── State File Path ────────────────────────────────────────────────

/** Derive state file path from plan file path: plan.md → plan.md.state.json */
export function stateFilePath(planFile: string): string {
	return planFile + ".state.json";
}

// ── Read / Write ───────────────────────────────────────────────────

export function readState(planFile: string): ExecutionState | null {
	const statePath = stateFilePath(planFile);
	if (!fs.existsSync(statePath)) return null;
	try {
		const raw = fs.readFileSync(statePath, "utf-8");
		return JSON.parse(raw) as ExecutionState;
	} catch {
		return null;
	}
}

export function writeState(planFile: string, state: ExecutionState): void {
	const statePath = stateFilePath(planFile);
	state.updatedAt = new Date().toISOString();
	fs.writeFileSync(statePath, JSON.stringify(state, null, 2), "utf-8");
}

// ── State Helpers ──────────────────────────────────────────────────

export function createInitialState(planFile: string): ExecutionState {
	return {
		planFile: path.basename(planFile),
		startedAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		currentWave: 0,
		taskStates: {},
		foundationCommitted: false,
		featuresMerged: false,
	};
}

export function markTaskDone(state: ExecutionState, taskId: string): void {
	state.taskStates[taskId] = "done";
}

export function markTaskFailed(state: ExecutionState, taskId: string): void {
	state.taskStates[taskId] = "failed";
}

export function markTaskSkipped(state: ExecutionState, taskId: string): void {
	state.taskStates[taskId] = "skipped";
}

/** Reset state for a new wave — clear per-wave flags, keep completed tasks from prior waves. */
export function advanceToWave(state: ExecutionState, waveIndex: number): void {
	state.currentWave = waveIndex;
	state.foundationCommitted = false;
	state.featuresMerged = false;
}

/** Get the set of task IDs that completed successfully and should be skipped on resume. */
export function completedTaskIds(state: ExecutionState): Set<string> {
	const ids = new Set<string>();
	for (const [id, status] of Object.entries(state.taskStates)) {
		if (status === "done") ids.add(id);
	}
	return ids;
}

/** Remove state for all tasks in a specific wave (for re-running a wave cleanly). */
export function clearWaveTasks(state: ExecutionState, taskIds: string[]): void {
	for (const id of taskIds) {
		delete state.taskStates[id];
	}
}

export function deleteState(planFile: string): void {
	const statePath = stateFilePath(planFile);
	if (fs.existsSync(statePath)) {
		fs.unlinkSync(statePath);
	}
}
