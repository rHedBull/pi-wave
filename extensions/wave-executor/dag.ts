/**
 * DAG scheduler — dependency resolution, topological ordering, and execution.
 *
 * Validates task dependencies form a DAG (no cycles), builds topologically
 * sorted levels, and executes tasks level-by-level with parallelism within levels.
 */

import type { DAGLevel, Plan, Task, TaskResult } from "./types.js";

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

// ── Plan-Level Validation ──────────────────────────────────────────

/**
 * Validate an entire plan's DAG structure:
 * - Per-section DAG validation (cycles, missing refs within scope)
 * - Cross-section dependency detection (foundation/feature/integration are separate scopes)
 * - Duplicate task ID detection across the entire plan
 * - Feature file overlap detection (parallel features must not write to same files)
 *
 * Returns all errors found (not just the first one).
 */
export function validatePlan(plan: Plan): { valid: boolean; errors: string[] } {
	const errors: string[] = [];

	for (const wave of plan.waves) {
		const waveLabel = `Wave "${wave.name}"`;

		// Collect all task IDs in the wave, grouped by section
		const sectionTasks = new Map<string, Set<string>>();

		// Foundation
		const foundationIds = new Set(wave.foundation.map((t) => t.id));
		sectionTasks.set("foundation", foundationIds);

		// Features
		for (const feature of wave.features) {
			const featureIds = new Set(feature.tasks.map((t) => t.id));
			sectionTasks.set(`feature:${feature.name}`, featureIds);
		}

		// Integration
		const integrationIds = new Set(wave.integration.map((t) => t.id));
		sectionTasks.set("integration", integrationIds);

		// All task IDs in this wave (for cross-section detection)
		const allWaveIds = new Map<string, string>(); // task ID → section label
		for (const [section, ids] of sectionTasks) {
			for (const id of ids) {
				if (allWaveIds.has(id)) {
					errors.push(
						`${waveLabel}: Duplicate task ID "${id}" — found in both ${allWaveIds.get(id)} and ${section}`,
					);
				}
				allWaveIds.set(id, section);
			}
		}

		// Per-section DAG validation + cross-section dependency check
		const validateSection = (tasks: Task[], sectionLabel: string, sectionIds: Set<string>) => {
			// Standard DAG validation (cycles + missing refs within scope)
			if (tasks.length > 0) {
				const v = validateDAG(tasks);
				if (!v.valid) {
					errors.push(`${waveLabel} ${sectionLabel}: ${v.error}`);
				}
			}

			// Cross-section dependency check
			for (const task of tasks) {
				for (const dep of task.depends) {
					if (!sectionIds.has(dep) && allWaveIds.has(dep)) {
						const depSection = allWaveIds.get(dep)!;
						errors.push(
							`${waveLabel} ${sectionLabel}: Task "${task.id}" depends on "${dep}" which is in ${depSection}. ` +
							`Dependencies must be within the same section — the executor handles cross-section ordering automatically.`,
						);
					}
				}
			}
		};

		validateSection(wave.foundation, "foundation", foundationIds);
		for (const feature of wave.features) {
			const featureIds = sectionTasks.get(`feature:${feature.name}`)!;
			validateSection(feature.tasks, `feature "${feature.name}"`, featureIds);
		}
		validateSection(wave.integration, "integration", integrationIds);

		// Feature file overlap detection
		const fileOwnership = new Map<string, string[]>(); // file → [feature names]
		for (const feature of wave.features) {
			const featureFiles = new Set<string>();
			for (const task of feature.tasks) {
				for (const file of task.files) {
					featureFiles.add(file);
				}
			}
			// Also include feature-level files
			for (const file of feature.files) {
				featureFiles.add(file);
			}
			for (const file of featureFiles) {
				if (!fileOwnership.has(file)) fileOwnership.set(file, []);
				fileOwnership.get(file)!.push(feature.name);
			}
		}
		for (const [file, features] of fileOwnership) {
			if (features.length > 1) {
				errors.push(
					`${waveLabel}: File "${file}" is written by multiple parallel features: ${features.join(", ")}. ` +
					`Move shared files to Foundation or split into separate waves.`,
				);
			}
		}
	}

	return { valid: errors.length === 0, errors };
}

// ── Comprehensive Plan Validation ──────────────────────────────────

/**
 * Comprehensive plan validation for use after LLM writes a plan.
 *
 * Runs all of validatePlan() plus additional content checks:
 * - Task ID convention (w{N}-{feat}-t{N})
 * - Empty/missing descriptions
 * - Worker/test-writer tasks without files
 * - Empty sections (waves with no features, features with no tasks)
 * - Missing Data Schemas section
 * - Verifier task presence per feature/foundation
 * - Dangling depends references (typos pointing to non-existent IDs)
 *
 * Returns structured result with errors (blocking) and warnings (informational).
 */
export function validatePlanComprehensive(plan: Plan): {
	valid: boolean;
	errors: string[];
	warnings: string[];
	stats: {
		waves: number;
		features: number;
		tasks: number;
		testTasks: number;
		workerTasks: number;
		verifierTasks: number;
	};
} {
	// Start with structural validation
	const structural = validatePlan(plan);
	const errors = [...structural.errors];
	const warnings: string[] = [];

	// Stats
	let totalFeatures = 0;
	let totalTasks = 0;
	let testTasks = 0;
	let workerTasks = 0;
	let verifierTasks = 0;

	// Task ID convention regex
	const taskIdPattern = /^w\d+-[\w]+-t\d+$/;

	// Collect ALL task IDs across entire plan for dangling reference detection
	const allPlanTaskIds = new Set<string>();
	for (const wave of plan.waves) {
		for (const t of wave.foundation) allPlanTaskIds.add(t.id);
		for (const f of wave.features) {
			for (const t of f.tasks) allPlanTaskIds.add(t.id);
		}
		for (const t of wave.integration) allPlanTaskIds.add(t.id);
	}

	// Check Data Schemas section
	if (!plan.dataSchemas || plan.dataSchemas.trim().length === 0) {
		warnings.push("Plan has no ## Data Schemas section. Parallel agents may use inconsistent names.");
	}

	// Empty plan
	if (plan.waves.length === 0) {
		errors.push("Plan has no waves.");
		return { valid: false, errors, warnings, stats: { waves: 0, features: 0, tasks: 0, testTasks: 0, workerTasks: 0, verifierTasks: 0 } };
	}

	// No goal
	if (!plan.goal || plan.goal.trim().length === 0) {
		warnings.push("Plan has no ## Goal.");
	}

	for (let wi = 0; wi < plan.waves.length; wi++) {
		const wave = plan.waves[wi];
		const waveLabel = `Wave ${wi + 1} "${wave.name}"`;

		// Empty wave
		const waveTotalTasks = wave.foundation.length
			+ wave.features.reduce((s, f) => s + f.tasks.length, 0)
			+ wave.integration.length;
		if (waveTotalTasks === 0) {
			errors.push(`${waveLabel}: has no tasks at all.`);
			continue;
		}

		// Features check
		const realFeatures = wave.features.filter(f => f.name !== "default");
		totalFeatures += realFeatures.length || wave.features.length;

		if (wave.features.length === 0) {
			warnings.push(`${waveLabel}: has no features section.`);
		}

		// Check each task in all sections
		const checkTask = (task: Task, sectionLabel: string) => {
			totalTasks++;
			if (task.agent === "test-writer") testTasks++;
			else if (task.agent === "wave-verifier") verifierTasks++;
			else workerTasks++;

			// Task ID convention
			if (!taskIdPattern.test(task.id)) {
				warnings.push(`${waveLabel} ${sectionLabel}: Task "${task.id}" doesn't follow convention w{N}-{feat}-t{N}.`);
			}

			// Valid agent name
			const validAgents = ["worker", "test-writer", "wave-verifier"];
			if (!validAgents.includes(task.agent)) {
				warnings.push(`${waveLabel} ${sectionLabel}: Task "${task.id}" has unknown agent "${task.agent}".`);
			}

			// Empty description
			if (!task.description || task.description.trim().length === 0) {
				errors.push(`${waveLabel} ${sectionLabel}: Task "${task.id}" has no description.`);
			}

			// Worker/test-writer without files
			if ((task.agent === "worker" || task.agent === "test-writer") && task.files.length === 0) {
				errors.push(`${waveLabel} ${sectionLabel}: Task "${task.id}" (${task.agent}) has no files declared.`);
			}

			// Dangling depends — references an ID that exists in the plan but in a DIFFERENT section
			// (This is already caught by validatePlan's cross-section check, but we add a
			//  check for total typos — depends on something that doesn't exist ANYWHERE)
			for (const dep of task.depends) {
				if (!allPlanTaskIds.has(dep)) {
					errors.push(
						`${waveLabel} ${sectionLabel}: Task "${task.id}" depends on "${dep}" which doesn't exist anywhere in the plan. Likely a typo.`,
					);
				}
			}
		};

		// Foundation
		for (const task of wave.foundation) checkTask(task, "foundation");

		// Check foundation has a verifier if it has content tasks
		const foundationContentTasks = wave.foundation.filter(t => t.agent !== "wave-verifier");
		const foundationVerifiers = wave.foundation.filter(t => t.agent === "wave-verifier");
		if (foundationContentTasks.length > 0 && foundationVerifiers.length === 0) {
			warnings.push(`${waveLabel} foundation: has ${foundationContentTasks.length} content task(s) but no wave-verifier.`);
		}

		// Features
		for (const feature of wave.features) {
			if (feature.name === "default") continue;

			if (feature.tasks.length === 0) {
				errors.push(`${waveLabel} feature "${feature.name}": has no tasks.`);
				continue;
			}

			for (const task of feature.tasks) checkTask(task, `feature "${feature.name}"`);

			// Check feature has a verifier
			const featureVerifiers = feature.tasks.filter(t => t.agent === "wave-verifier");
			if (featureVerifiers.length === 0) {
				warnings.push(`${waveLabel} feature "${feature.name}": has no wave-verifier task.`);
			}
		}

		// Integration
		for (const task of wave.integration) checkTask(task, "integration");

		// Check integration has a verifier if it has content
		if (wave.integration.length > 0) {
			const intVerifiers = wave.integration.filter(t => t.agent === "wave-verifier");
			if (intVerifiers.length === 0) {
				warnings.push(`${waveLabel} integration: has tasks but no wave-verifier.`);
			}
		}
	}

	return {
		valid: errors.length === 0,
		errors,
		warnings,
		stats: {
			waves: plan.waves.length,
			features: totalFeatures,
			tasks: totalTasks,
			testTasks,
			workerTasks,
			verifierTasks,
		},
	};
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
