/**
 * Shared TypeScript interfaces for the wave execution system.
 *
 * Used by: plan-parser, dag, feature-executor, wave-executor, index, git-worktree
 */

// ── Plan Structure ─────────────────────────────────────────────────

export interface Plan {
	goal: string;
	waves: Wave[];
}

export interface Wave {
	name: string;
	description: string;
	foundation: Task[];
	features: Feature[];
	integration: Task[];
}

export interface Feature {
	name: string;
	files: string[];
	tasks: Task[];
}

export interface Task {
	id: string;
	title: string;
	agent: string; // "test-writer" | "worker" | "wave-verifier"
	files: string[];
	depends: string[];
	specRefs: string[];
	testFiles: string[];
	description: string;
}

// ── Execution Results ──────────────────────────────────────────────

export interface TaskResult {
	id: string;
	title: string;
	agent: string;
	exitCode: number;
	output: string;
	stderr: string;
	durationMs: number;
	timedOut?: boolean;
}

export interface FeatureResult {
	name: string;
	branch: string;
	taskResults: TaskResult[];
	passed: boolean;
	error?: string;
}

export interface WaveResult {
	wave: string;
	foundationResults: TaskResult[];
	featureResults: FeatureResult[];
	integrationResults: TaskResult[];
	passed: boolean;
}

// ── DAG ────────────────────────────────────────────────────────────

export interface DAGLevel {
	tasks: Task[];
	parallel: boolean; // true if >1 task at this level
}

// ── Git Worktree ───────────────────────────────────────────────────

export interface FeatureWorktree {
	featureName: string;
	branch: string; // wave-{N}/{feature-name}
	dir: string;
	repoRoot: string;
}

export interface SubWorktree {
	taskId: string;
	branch: string; // wave-{N}/{feature-name}/{task-id}
	dir: string;
	parentBranch: string; // feature branch
}

export interface MergeResult {
	source: string; // branch name
	target: string; // branch merged into
	success: boolean;
	hadChanges: boolean;
	error?: string;
}

// ── File Access Enforcement ────────────────────────────────────────

export interface FileAccessRules {
	/** Files/patterns the agent is allowed to write/edit */
	allowWrite?: string[];
	/** Files/patterns the agent is allowed to read (empty = allow all reads) */
	allowRead?: string[];
	/** Files that must NEVER be written/edited, even if in allowWrite */
	protectedPaths?: string[];
	/** Block all write/edit operations */
	readOnly?: boolean;
	/** Block bash commands that could modify files */
	safeBashOnly?: boolean;
}

// ── Execution State (for resume) ───────────────────────────────────

export interface ExecutionState {
	/** Relative path to the plan file */
	planFile: string;
	/** When execution first started */
	startedAt: string;
	/** When state was last updated */
	updatedAt: string;
	/** 0-indexed wave currently in progress (or last attempted) */
	currentWave: number;
	/** Per-task completion status. Only "done" tasks are skipped on resume. */
	taskStates: Record<string, "done" | "failed" | "skipped">;
	/** Whether foundation was committed to git in the current wave */
	foundationCommitted: boolean;
	/** Whether feature branches were merged in the current wave */
	featuresMerged: boolean;
}

// ── Progress ───────────────────────────────────────────────────────

export interface ProgressUpdate {
	phase: "foundation" | "features" | "merge" | "integration";
	features?: { name: string; status: "pending" | "running" | "done" | "failed" }[];
	currentTasks?: { id: string; status: "pending" | "running" | "done" | "failed" | "skipped" }[];
}
