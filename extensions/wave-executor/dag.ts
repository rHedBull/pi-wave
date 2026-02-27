/**
 * DAG scheduler — dependency resolution, topological ordering, and execution.
 *
 * Validates task dependencies form a DAG (no cycles), builds topologically
 * sorted levels, and executes tasks level-by-level with parallelism within levels.
 */

import type { DAGLevel, Task, TaskResult } from "./types.js";

// ── Validation ─────────────────────────────────────────────────────

/**
 * Validate that task dependencies form a valid DAG:
 * - All dependency references point to existing task IDs
 * - No circular dependencies (Kahn's algorithm)
 */
export function validateDAG(tasks: Task[]): { valid: boolean; error?: string } {
	const taskIds = new Set(tasks.map((t) => t.id));

	// Check all dependency references exist
	for (const task of tasks) {
		for (const dep of task.depends) {
			if (!taskIds.has(dep)) {
				return {
					valid: false,
					error: `Task "${task.id}" depends on "${dep}" which does not exist`,
				};
			}
		}
		// Self-dependency check
		if (task.depends.includes(task.id)) {
			return {
				valid: false,
				error: `Task "${task.id}" depends on itself`,
			};
		}
	}

	// Cycle detection via Kahn's algorithm
	const inDegree = new Map<string, number>();
	const adjacency = new Map<string, string[]>();

	for (const task of tasks) {
		inDegree.set(task.id, task.depends.length);
		if (!adjacency.has(task.id)) adjacency.set(task.id, []);
	}

	// Build adjacency: dep → [tasks that depend on it]
	for (const task of tasks) {
		for (const dep of task.depends) {
			const list = adjacency.get(dep);
			if (list) list.push(task.id);
		}
	}

	const queue: string[] = [];
	for (const [id, deg] of inDegree) {
		if (deg === 0) queue.push(id);
	}

	let sorted = 0;
	while (queue.length > 0) {
		const id = queue.shift()!;
		sorted++;
		for (const dependent of adjacency.get(id) || []) {
			const newDeg = (inDegree.get(dependent) || 0) - 1;
			inDegree.set(dependent, newDeg);
			if (newDeg === 0) queue.push(dependent);
		}
	}

	if (sorted !== tasks.length) {
		return {
			valid: false,
			error: `Circular dependency detected among tasks: ${tasks
				.filter((t) => (inDegree.get(t.id) || 0) > 0)
				.map((t) => t.id)
				.join(", ")}`,
		};
	}

	return { valid: true };
}

// ── Build DAG Levels ───────────────────────────────────────────────

/**
 * Build topologically sorted levels from tasks.
 *
 * Level 0: tasks with no dependencies
 * Level 1: tasks whose deps are all in level 0
 * Level N: tasks whose deps are all in levels < N
 *
 * Each level has `parallel: true` if it contains more than one task.
 */
export function buildDAG(tasks: Task[]): DAGLevel[] {
	if (tasks.length === 0) return [];

	const taskMap = new Map<string, Task>();
	for (const t of tasks) taskMap.set(t.id, t);

	const assigned = new Map<string, number>(); // task ID → level number
	const levels: DAGLevel[] = [];

	// Assign levels iteratively
	let remaining = [...tasks];
	let levelNum = 0;

	while (remaining.length > 0) {
		const thisLevel: Task[] = [];
		const nextRemaining: Task[] = [];

		for (const task of remaining) {
			// A task is ready if all its deps have been assigned in a PREVIOUS level
			const allDepsAssigned = task.depends.every((d) => assigned.has(d));
			if (allDepsAssigned) {
				thisLevel.push(task);
			} else {
				nextRemaining.push(task);
			}
		}

		if (thisLevel.length === 0) {
			// This shouldn't happen if validateDAG passed, but guard against it
			break;
		}

		// Mark all tasks in this level as assigned AFTER the full level is determined
		for (const task of thisLevel) {
			assigned.set(task.id, levelNum);
		}

		levels.push({
			tasks: thisLevel,
			parallel: thisLevel.length > 1,
		});

		remaining = nextRemaining;
		levelNum++;
	}

	return levels;
}

// ── Concurrent Execution Helper ────────────────────────────────────

/**
 * Run items concurrently with a limit on simultaneous operations.
 */
export async function mapConcurrent<T, R>(
	items: T[],
	concurrency: number,
	fn: (item: T, idx: number) => Promise<R>,
): Promise<R[]> {
	const results: R[] = new Array(items.length);
	let next = 0;
	const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
		while (true) {
			const i = next++;
			if (i >= items.length) return;
			results[i] = await fn(items[i], i);
		}
	});
	await Promise.all(workers);
	return results;
}

// ── DAG Execution ──────────────────────────────────────────────────

/**
 * Execute tasks respecting DAG order.
 *
 * - Tasks at the same level with parallel=true run concurrently
 * - If a task fails, all downstream dependents are skipped (marked as skipped)
 * - maxConcurrency limits simultaneous runTask calls across all levels
 *
 * Returns results for all tasks (including skipped ones).
 */
export async function executeDAG(
	tasks: Task[],
	runTask: (task: Task) => Promise<TaskResult>,
	maxConcurrency: number,
): Promise<TaskResult[]> {
	const levels = buildDAG(tasks);
	const resultMap = new Map<string, TaskResult>();
	const failedIds = new Set<string>();

	// Build transitive dependency map for skip detection
	const dependsOn = new Map<string, Set<string>>();
	for (const task of tasks) {
		dependsOn.set(task.id, new Set(task.depends));
	}

	/**
	 * Check if a task should be skipped because one of its
	 * dependencies (direct or transitive) failed.
	 */
	function shouldSkip(task: Task): boolean {
		// Check direct dependencies
		for (const dep of task.depends) {
			if (failedIds.has(dep)) return true;
		}
		return false;
	}

	for (const level of levels) {
		const levelResults = await mapConcurrent(
			level.tasks,
			maxConcurrency,
			async (task) => {
				// Skip if any dependency failed
				if (shouldSkip(task)) {
					const skipped: TaskResult = {
						id: task.id,
						title: task.title,
						agent: task.agent,
						exitCode: -1,
						output: "Skipped: dependency failed",
						stderr: "",
						durationMs: 0,
					};
					failedIds.add(task.id); // propagate skip as failure for downstream
					return skipped;
				}

				const result = await runTask(task);

				if (result.exitCode !== 0) {
					failedIds.add(task.id);
				}

				return result;
			},
		);

		for (const result of levelResults) {
			resultMap.set(result.id, result);
		}
	}

	// Return results in original task order
	return tasks.map((t) => resultMap.get(t.id)!);
}
