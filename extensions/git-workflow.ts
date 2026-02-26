/**
 * Git workflow helpers for feature development.
 *
 * - /feature-branch <description> — create and checkout a pi/* feature branch
 * - /feature-done — show summary of current feature branch and next steps
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { execSync } from "node:child_process";

function git(args: string, cwd: string): string {
	return execSync(`git ${args}`, { cwd, stdio: "pipe", timeout: 10000 })
		.toString()
		.trim();
}

function isGitRepo(cwd: string): boolean {
	try {
		git("rev-parse --is-inside-work-tree", cwd);
		return true;
	} catch {
		return false;
	}
}

function toBranchName(description: string): string {
	return (
		"pi/" +
		description
			.toLowerCase()
			.replace(/[^a-z0-9\s-]/g, "")
			.replace(/\s+/g, "-")
			.replace(/-+/g, "-")
			.replace(/^-|-$/g, "")
			.slice(0, 50)
	);
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("feature-branch", {
		description: "Create a feature branch (pi/<name>) for isolated development",
		handler: async (args, ctx) => {
			if (!args?.trim()) {
				ctx.ui.notify("Usage: /feature-branch <short description>", "error");
				return;
			}

			if (!isGitRepo(ctx.cwd)) {
				ctx.ui.notify("Not in a git repository.", "error");
				return;
			}

			const branchName = toBranchName(args);

			try {
				const currentBranch = git("branch --show-current", ctx.cwd);

				// Already on this branch?
				if (currentBranch === branchName) {
					ctx.ui.notify(`Already on ${branchName}`, "info");
					return;
				}

				// Already on a pi/* branch?
				if (currentBranch.startsWith("pi/")) {
					const ok = await ctx.ui.confirm(
						"Switch branches?",
						`Currently on ${currentBranch}.\nSwitch to ${branchName}?`,
					);
					if (!ok) return;
				}

				// Check for uncommitted changes
				const status = git("status --porcelain", ctx.cwd);
				if (status) {
					const ok = await ctx.ui.confirm(
						"Uncommitted changes",
						"You have uncommitted changes. They will be carried to the new branch.\nContinue?",
					);
					if (!ok) return;
				}

				// Check if branch already exists
				try {
					git(`show-ref --verify refs/heads/${branchName}`, ctx.cwd);
					// Branch exists — check it out
					git(`checkout ${branchName}`, ctx.cwd);
					ctx.ui.notify(`Switched to existing branch: ${branchName}`, "info");
				} catch {
					// Branch doesn't exist — create it
					git(`checkout -b ${branchName}`, ctx.cwd);
					ctx.ui.notify(`Created branch: ${branchName}`, "success");
				}
			} catch (e: any) {
				ctx.ui.notify(`Failed: ${e.message}`, "error");
			}
		},
	});

	pi.registerCommand("feature-done", {
		description: "Show feature branch summary and next steps",
		handler: async (_args, ctx) => {
			if (!isGitRepo(ctx.cwd)) {
				ctx.ui.notify("Not in a git repository.", "error");
				return;
			}

			try {
				const branch = git("branch --show-current", ctx.cwd);

				if (!branch.startsWith("pi/")) {
					ctx.ui.notify(
						`Not on a feature branch (current: ${branch || "detached HEAD"})`,
						"warning",
					);
					return;
				}

				// Find the base branch (main or master)
				let base = "main";
				try {
					git("show-ref --verify refs/heads/main", ctx.cwd);
				} catch {
					try {
						git("show-ref --verify refs/heads/master", ctx.cwd);
						base = "master";
					} catch {
						base = "main"; // Assume main even if not found
					}
				}

				const commits = git(`log ${base}..HEAD --oneline`, ctx.cwd);
				const commitCount = commits ? commits.split("\n").length : 0;

				let diffStat = "";
				try {
					diffStat = git(`diff --stat ${base}..HEAD`, ctx.cwd);
				} catch {}

				const lines = [
					`Branch: ${branch}`,
					`Base: ${base}`,
					`Commits: ${commitCount}`,
					"",
					diffStat || "(no changes)",
					"",
					"Next steps:",
					"  /commit-push-pr  — push and create a PR",
					`  git diff ${base}..HEAD  — review all changes`,
					`  git checkout ${base}  — switch back without merging`,
					`  git checkout ${base} && git merge ${branch}  — merge locally`,
				];

				ctx.ui.notify(lines.join("\n"), "info");
			} catch (e: any) {
				ctx.ui.notify(`Failed: ${e.message}`, "error");
			}
		},
	});
}
