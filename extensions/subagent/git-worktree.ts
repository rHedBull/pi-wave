/**
 * Git worktree isolation for feature-parallel wave execution.
 *
 * Two tiers of isolation:
 * 1. Feature worktrees — one per feature, branching from post-foundation commit
 * 2. Sub-worktrees — for parallel tasks within a feature, branching from feature branch
 *
 * After completion, branches merge back in order: sub → feature → base.
 */

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { FeatureWorktree, MergeResult, SubWorktree } from "../wave-executor/types.js";

// ── Git helpers (kept from original) ─────────────────────────────────────

function git(args: string, cwd: string): string {
	return execSync(`git ${args}`, { cwd, stdio: "pipe", timeout: 30000 }).toString().trim();
}

export function isGitRepo(dir: string): boolean {
	try {
		git("rev-parse --is-inside-work-tree", dir);
		return true;
	} catch {
		return false;
	}
}

export function getRepoRoot(dir: string): string {
	return git("rev-parse --show-toplevel", dir);
}

export function getCurrentBranch(dir: string): string {
	return git("branch --show-current", dir);
}

export function hasUncommittedChanges(dir: string): boolean {
	return git("status --porcelain", dir).length > 0;
}

// ── Slug helper ──────────────────────────────────────────────────────────

function branchSlug(name: string): string {
	return name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 50);
}

// ── Checkpoint / Restore ─────────────────────────────────────────────────

/**
 * Checkpoint uncommitted changes by committing them.
 * Returns the commit SHA, or null if the working tree was clean.
 */
export function checkpointChanges(repoRoot: string): string | null {
	try {
		if (!hasUncommittedChanges(repoRoot)) return null;

		git("add -A", repoRoot);
		git('commit -m "pi: checkpoint before wave execution"', repoRoot);
		return git("rev-parse HEAD", repoRoot);
	} catch {
		return null;
	}
}

/**
 * Restore to pre-checkpoint state (soft reset if checkpoint was made).
 */
export function restoreCheckpoint(repoRoot: string, checkpointSha: string | null): void {
	if (!checkpointSha) return;
	try {
		git(`reset --soft ${checkpointSha}~1`, repoRoot);
	} catch {
		// If reset fails, leave the checkpoint commit — safer than losing work
	}
}

// ── Feature Worktrees ────────────────────────────────────────────────────

/**
 * Create a feature worktree branching from current HEAD.
 * Branch: wave-{waveNum}/{featureName}
 *
 * Returns null if not a git repo or creation fails.
 */
export function createFeatureWorktree(
	repoRoot: string,
	waveNum: number,
	featureName: string,
): FeatureWorktree | null {
	try {
		if (!isGitRepo(repoRoot)) return null;

		const slug = branchSlug(featureName);
		const branch = `wave-${waveNum}/${slug}`;
		const tmpBase = path.join(os.tmpdir(), `pi-feature-wt-${Date.now()}-${slug}`);

		fs.mkdirSync(tmpBase, { recursive: true });
		git(`worktree add -b "${branch}" "${tmpBase}"`, repoRoot);

		return {
			featureName,
			branch,
			dir: tmpBase,
			repoRoot,
		};
	} catch {
		return null;
	}
}

/**
 * Create sub-worktrees for parallel tasks within a feature.
 * Each branches from the feature branch's current state.
 * Branch: wave-{waveNum}/{featureName}--{taskId}
 * (double-dash separator avoids git ref hierarchy conflict with the feature branch)
 *
 * Returns empty array if creation fails.
 */
export function createSubWorktrees(
	featureWorktree: FeatureWorktree,
	waveNum: number,
	taskIds: string[],
): SubWorktree[] {
	const subWorktrees: SubWorktree[] = [];
	const featureSlug = branchSlug(featureWorktree.featureName);

	try {
		// Commit any uncommitted changes in the feature worktree first
		// so sub-worktrees branch from the latest state
		if (hasUncommittedChanges(featureWorktree.dir)) {
			git("add -A", featureWorktree.dir);
			git('commit -m "pi: snapshot before sub-worktree split"', featureWorktree.dir);
		}

		for (const taskId of taskIds) {
			const taskSlug = branchSlug(taskId);
			const branch = `wave-${waveNum}/${featureSlug}--${taskSlug}`;
			const dir = path.join(os.tmpdir(), `pi-sub-wt-${Date.now()}-${taskSlug}`);

			fs.mkdirSync(dir, { recursive: true });

			// Branch from the feature branch
			git(
				`worktree add -b "${branch}" "${dir}" "${featureWorktree.branch}"`,
				featureWorktree.repoRoot,
			);

			subWorktrees.push({
				taskId,
				branch,
				dir,
				parentBranch: featureWorktree.branch,
			});
		}
	} catch (e: any) {
		// Partial creation — clean up what we made and return empty
		for (const sw of subWorktrees) {
			try {
				git(`worktree remove --force "${sw.dir}"`, featureWorktree.repoRoot);
			} catch {}
			tryDeleteBranch(featureWorktree.repoRoot, sw.branch);
		}
		return [];
	}

	return subWorktrees;
}

// ── Merge Sub-worktrees → Feature Branch ─────────────────────────────────

/**
 * Merge sub-worktrees back into the feature branch, then clean up.
 * Only merges sub-worktrees whose tasks succeeded.
 *
 * Returns merge results for each sub-worktree.
 */
export function mergeSubWorktrees(
	featureWorktree: FeatureWorktree,
	subWorktrees: SubWorktree[],
	results: { taskId: string; exitCode: number }[],
): MergeResult[] {
	const mergeResults: MergeResult[] = [];
	const resultMap = new Map(results.map((r) => [r.taskId, r]));

	// 1. Commit changes in each successful sub-worktree
	for (const sw of subWorktrees) {
		const result = resultMap.get(sw.taskId);
		if (result && result.exitCode === 0) {
			try {
				if (hasUncommittedChanges(sw.dir)) {
					git("add -A", sw.dir);
					git(`commit -m "pi: ${sw.taskId}"`, sw.dir);
				}
			} catch {
				// Commit failure — branch stays as-is
			}
		}
	}

	// 2. Remove all sub-worktrees (frees dirs, keeps branches)
	for (const sw of subWorktrees) {
		removeWorktree(featureWorktree.repoRoot, sw.dir);
	}

	// 3. Merge successful branches into the feature branch
	for (const sw of subWorktrees) {
		const result = resultMap.get(sw.taskId);

		if (!result || result.exitCode !== 0) {
			tryDeleteBranch(featureWorktree.repoRoot, sw.branch);
			mergeResults.push({
				source: sw.branch,
				target: featureWorktree.branch,
				success: false,
				hadChanges: false,
				error: "Task failed — not merged",
			});
			continue;
		}

		// Check if branch has changes relative to parent
		try {
			const diff = git(
				`log "${featureWorktree.branch}..${sw.branch}" --oneline`,
				featureWorktree.repoRoot,
			);
			if (!diff) {
				tryDeleteBranch(featureWorktree.repoRoot, sw.branch);
				mergeResults.push({
					source: sw.branch,
					target: featureWorktree.branch,
					success: true,
					hadChanges: false,
				});
				continue;
			}
		} catch {}

		// Merge into feature worktree
		try {
			git(
				`-C "${featureWorktree.dir}" merge --no-ff "${sw.branch}" -m "pi: merge ${sw.taskId}"`,
				featureWorktree.repoRoot,
			);
			tryDeleteBranch(featureWorktree.repoRoot, sw.branch);
			mergeResults.push({
				source: sw.branch,
				target: featureWorktree.branch,
				success: true,
				hadChanges: true,
			});
		} catch {
			// Merge conflict — abort and keep branch
			try {
				git(`-C "${featureWorktree.dir}" merge --abort`, featureWorktree.repoRoot);
			} catch {}
			mergeResults.push({
				source: sw.branch,
				target: featureWorktree.branch,
				success: false,
				hadChanges: true,
				error: `Merge conflict — branch "${sw.branch}" preserved for manual resolution`,
			});
		}
	}

	return mergeResults;
}

// ── Merge Feature Branches → Base ────────────────────────────────────────

/**
 * Merge feature branches into the base branch, then clean up.
 * Only merges features that passed.
 *
 * Returns merge results for each feature.
 */
export function mergeFeatureBranches(
	repoRoot: string,
	featureWorktrees: FeatureWorktree[],
	results: { featureName: string; passed: boolean }[],
): MergeResult[] {
	const mergeResults: MergeResult[] = [];
	const resultMap = new Map(results.map((r) => [r.featureName, r]));
	const baseBranch = getCurrentBranch(repoRoot);

	// 1. Commit changes in each successful feature worktree
	for (const fw of featureWorktrees) {
		const result = resultMap.get(fw.featureName);
		if (result && result.passed) {
			try {
				if (hasUncommittedChanges(fw.dir)) {
					git("add -A", fw.dir);
					git(`commit -m "pi: finalize ${fw.featureName}"`, fw.dir);
				}
			} catch {}
		}
	}

	// 2. Remove all feature worktrees (frees dirs, keeps branches)
	for (const fw of featureWorktrees) {
		removeWorktree(repoRoot, fw.dir);
	}

	// 3. Merge successful feature branches into base
	for (const fw of featureWorktrees) {
		const result = resultMap.get(fw.featureName);

		if (!result || !result.passed) {
			tryDeleteBranch(repoRoot, fw.branch);
			mergeResults.push({
				source: fw.branch,
				target: baseBranch,
				success: false,
				hadChanges: false,
				error: "Feature failed — not merged",
			});
			continue;
		}

		// Check if branch has changes
		try {
			const diff = git(`log "${baseBranch}..${fw.branch}" --oneline`, repoRoot);
			if (!diff) {
				tryDeleteBranch(repoRoot, fw.branch);
				mergeResults.push({
					source: fw.branch,
					target: baseBranch,
					success: true,
					hadChanges: false,
				});
				continue;
			}
		} catch {}

		// Merge
		try {
			git(
				`merge --no-ff "${fw.branch}" -m "pi: merge feature ${fw.featureName}"`,
				repoRoot,
			);
			tryDeleteBranch(repoRoot, fw.branch);
			mergeResults.push({
				source: fw.branch,
				target: baseBranch,
				success: true,
				hadChanges: true,
			});
		} catch {
			try {
				git("merge --abort", repoRoot);
			} catch {}
			mergeResults.push({
				source: fw.branch,
				target: baseBranch,
				success: false,
				hadChanges: true,
				error: `Merge conflict — branch "${fw.branch}" preserved for manual resolution`,
			});
		}
	}

	return mergeResults;
}

// ── Cleanup ──────────────────────────────────────────────────────────────

/**
 * Emergency cleanup — remove all worktrees and branches.
 * Best-effort, won't throw.
 */
export function cleanupAll(
	repoRoot: string,
	featureWorktrees: FeatureWorktree[],
	subWorktrees: SubWorktree[],
): void {
	// Clean up sub-worktrees first
	for (const sw of subWorktrees) {
		removeWorktree(repoRoot, sw.dir);
		tryDeleteBranch(repoRoot, sw.branch);
	}

	// Then feature worktrees
	for (const fw of featureWorktrees) {
		removeWorktree(repoRoot, fw.dir);
		tryDeleteBranch(repoRoot, fw.branch);
	}

	// Prune stale worktree entries
	try {
		git("worktree prune", repoRoot);
	} catch {}
}

// ── Internal helpers ─────────────────────────────────────────────────────

function removeWorktree(repoRoot: string, dir: string): void {
	try {
		git(`worktree remove --force "${dir}"`, repoRoot);
	} catch {
		try {
			fs.rmSync(dir, { recursive: true, force: true });
			git("worktree prune", repoRoot);
		} catch {}
	}
}

function tryDeleteBranch(repoRoot: string, branch: string): void {
	try {
		git(`branch -D "${branch}"`, repoRoot);
	} catch {}
}
