/**
 * Git worktree isolation for parallel subagent tasks.
 *
 * When multiple agents need to write files in parallel, each gets its own
 * git worktree (a separate working directory on a unique branch). After
 * completion, branches are merged back to the base branch.
 *
 * Read-only parallel agents skip this entirely — no overhead.
 */

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface WorktreeInfo {
	taskId: string;
	branch: string;
	dir: string;
	agent: string;
	taskPreview: string;
}

export interface ParallelIsolation {
	worktrees: WorktreeInfo[];
	repoRoot: string;
	baseBranch: string;
	checkpointSha: string | null;
	tmpBase: string;
}

export interface MergeResult {
	taskId: string;
	branch: string;
	success: boolean;
	hadChanges: boolean;
	error?: string;
}

// ── Git helpers ──────────────────────────────────────────────────────────────

function git(args: string, cwd: string): string {
	return execSync(`git ${args}`, { cwd, stdio: "pipe", timeout: 30000 }).toString().trim();
}

function isGitRepo(dir: string): boolean {
	try {
		git("rev-parse --is-inside-work-tree", dir);
		return true;
	} catch {
		return false;
	}
}

function getRepoRoot(dir: string): string {
	return git("rev-parse --show-toplevel", dir);
}

function getCurrentBranch(dir: string): string {
	return git("branch --show-current", dir);
}

function hasUncommittedChanges(dir: string): boolean {
	return git("status --porcelain", dir).length > 0;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Determine if a parallel task set needs worktree isolation.
 * Returns true if any task uses an agent with write capabilities.
 */
export function needsIsolation(
	tasks: { agent: string }[],
	isWriteAgent: (agentName: string) => boolean,
): boolean {
	return tasks.some((t) => isWriteAgent(t.agent));
}

/**
 * Set up worktrees for parallel tasks.
 * - If working tree is dirty, creates a checkpoint commit
 * - Creates a worktree + branch per task
 * Returns null if not in a git repo or setup fails.
 */
export function prepareParallelIsolation(
	cwd: string,
	tasks: { agent: string; task: string }[],
	isWriteAgent: (agentName: string) => boolean,
): ParallelIsolation | null {
	if (!needsIsolation(tasks, isWriteAgent)) return null;
	if (!isGitRepo(cwd)) return null;

	try {
		const repoRoot = getRepoRoot(cwd);
		const baseBranch = getCurrentBranch(repoRoot);
		const timestamp = Date.now();
		let checkpointSha: string | null = null;

		// If there are uncommitted changes, create a checkpoint commit
		// so worktrees branch from the current state (including uncommitted work)
		if (hasUncommittedChanges(repoRoot)) {
			git("add -A", repoRoot);
			git('commit -m "pi: checkpoint before parallel wave"', repoRoot);
			checkpointSha = git("rev-parse HEAD", repoRoot);
		}

		const tmpBase = path.join(os.tmpdir(), `pi-worktrees-${timestamp}`);
		fs.mkdirSync(tmpBase, { recursive: true });

		const worktrees: WorktreeInfo[] = [];

		for (let i = 0; i < tasks.length; i++) {
			const task = tasks[i];
			const taskId = `${task.agent}-${i}`;
			const branch = `pi-wt/${timestamp}/${taskId}`;
			const dir = path.join(tmpBase, taskId);
			const taskPreview =
				task.task.length > 60 ? task.task.slice(0, 60) + "..." : task.task;

			git(`worktree add -b "${branch}" "${dir}"`, repoRoot);
			worktrees.push({ taskId, branch, dir, agent: task.agent, taskPreview });
		}

		return { worktrees, repoRoot, baseBranch, checkpointSha, tmpBase };
	} catch (e: any) {
		// If setup fails, clean up anything partially created and return null
		// (caller falls back to shared directory)
		return null;
	}
}

/**
 * Get the working directory for a task.
 * Returns the worktree dir if isolation is active, undefined otherwise.
 */
export function getTaskCwd(
	isolation: ParallelIsolation | null,
	index: number,
): string | undefined {
	if (!isolation) return undefined;
	return isolation.worktrees[index]?.dir;
}

/**
 * After parallel tasks complete:
 * 1. Commit any uncommitted changes in each successful worktree
 * 2. Remove all worktrees
 * 3. Merge successful branches back to the base branch
 * 4. Clean up branches and temp dirs
 *
 * Returns a human-readable summary of what happened.
 */
export function finalizeParallelIsolation(
	isolation: ParallelIsolation | null,
	results: { exitCode: number; agent: string; task: string }[],
): { summary: string; mergeResults: MergeResult[] } {
	if (!isolation) return { summary: "", mergeResults: [] };

	const mergeResults: MergeResult[] = [];

	try {
		// 1. Commit changes in worktrees (while they still exist)
		for (let i = 0; i < isolation.worktrees.length; i++) {
			const wt = isolation.worktrees[i];
			const result = results[i];
			if (result && result.exitCode === 0) {
				try {
					const status = git("status --porcelain", wt.dir);
					if (status) {
						const msg = `pi: ${wt.agent} — ${wt.taskPreview}`.replace(/"/g, '\\"');
						git("add -A", wt.dir);
						git(`commit -m "${msg}"`, wt.dir);
					}
				} catch {
					// If commit fails, the branch has no new changes — that's ok
				}
			}
		}

		// 2. Remove all worktrees (frees directories, keeps branches)
		for (const wt of isolation.worktrees) {
			try {
				git(`worktree remove --force "${wt.dir}"`, isolation.repoRoot);
			} catch {
				try {
					fs.rmSync(wt.dir, { recursive: true, force: true });
					git("worktree prune", isolation.repoRoot);
				} catch {}
			}
		}

		// Clean up tmp base directory
		try {
			fs.rmSync(isolation.tmpBase, { recursive: true, force: true });
		} catch {}

		// 3. Merge successful branches into base branch
		for (let i = 0; i < isolation.worktrees.length; i++) {
			const wt = isolation.worktrees[i];
			const result = results[i];

			if (!result || result.exitCode !== 0) {
				// Failed task — delete branch, don't merge
				tryDeleteBranch(isolation.repoRoot, wt.branch);
				mergeResults.push({
					taskId: wt.taskId,
					branch: wt.branch,
					success: false,
					hadChanges: false,
					error: "Task failed",
				});
				continue;
			}

			// Check if branch has any new commits relative to base
			try {
				const diff = git(
					`log ${isolation.baseBranch}..${wt.branch} --oneline`,
					isolation.repoRoot,
				);
				if (!diff) {
					// No changes on this branch — skip merge
					tryDeleteBranch(isolation.repoRoot, wt.branch);
					mergeResults.push({
						taskId: wt.taskId,
						branch: wt.branch,
						success: true,
						hadChanges: false,
					});
					continue;
				}
			} catch {}

			// Attempt merge
			try {
				git(
					`merge --no-ff "${wt.branch}" -m "pi: merge ${wt.agent} (${wt.taskId})"`,
					isolation.repoRoot,
				);
				tryDeleteBranch(isolation.repoRoot, wt.branch);
				mergeResults.push({
					taskId: wt.taskId,
					branch: wt.branch,
					success: true,
					hadChanges: true,
				});
			} catch (e: any) {
				// Merge conflict — abort and keep branch for inspection
				try {
					git("merge --abort", isolation.repoRoot);
				} catch {}
				mergeResults.push({
					taskId: wt.taskId,
					branch: wt.branch,
					success: false,
					hadChanges: true,
					error: `Merge conflict — branch ${wt.branch} preserved for manual resolution`,
				});
			}
		}
	} catch (e: any) {
		// Catastrophic failure — try emergency cleanup
		emergencyCleanup(isolation);
		return {
			summary: `Git isolation error: ${e.message}`,
			mergeResults,
		};
	}

	// Build summary
	const merged = mergeResults.filter((m) => m.success && m.hadChanges).length;
	const noChanges = mergeResults.filter((m) => m.success && !m.hadChanges).length;
	const conflicts = mergeResults.filter(
		(m) => !m.success && m.error && !m.error.includes("Task failed"),
	);
	const failed = mergeResults.filter(
		(m) => !m.success && m.error?.includes("Task failed"),
	).length;

	const parts: string[] = [];
	if (merged > 0) parts.push(`${merged} merged`);
	if (noChanges > 0) parts.push(`${noChanges} no changes`);
	if (failed > 0) parts.push(`${failed} task(s) failed`);
	if (conflicts.length > 0) {
		parts.push(`${conflicts.length} merge conflict(s)`);
		for (const c of conflicts) {
			parts.push(`  ⚠ ${c.error}`);
		}
	}

	const summary = parts.length > 0 ? `\n\nGit isolation: ${parts.join(", ")}` : "";
	return { summary, mergeResults };
}

/**
 * Emergency cleanup — remove all worktrees and branches, best effort.
 */
export function emergencyCleanup(isolation: ParallelIsolation): void {
	for (const wt of isolation.worktrees) {
		try {
			git(`worktree remove --force "${wt.dir}"`, isolation.repoRoot);
		} catch {
			try {
				fs.rmSync(wt.dir, { recursive: true, force: true });
			} catch {}
		}
		tryDeleteBranch(isolation.repoRoot, wt.branch);
	}
	try {
		git("worktree prune", isolation.repoRoot);
	} catch {}
	try {
		fs.rmSync(isolation.tmpBase, { recursive: true, force: true });
	} catch {}
}

function tryDeleteBranch(repoRoot: string, branch: string): void {
	try {
		git(`branch -D "${branch}"`, repoRoot);
	} catch {}
}
