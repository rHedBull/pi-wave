/**
 * Update Docs Extension
 *
 * Provides two ways to trigger documentation updates:
 *
 * 1. Manual: `/update-docs [scope]` command
 *    - Triggers the update-docs skill to analyze and update documentation
 *    - Optional scope: a module/service name, or "all"
 *
 * 2. Hook: after each agent turn, detects source file changes and offers to update docs
 *    - Checks git diff for modified source files
 *    - Prompts the user to confirm before triggering
 *    - Skips if only docs/tests/config files changed
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

// Files that are never considered "source changes" worth updating docs for
const IGNORE_PATTERNS = [
	/\.md$/,
	/^\.pi\//,
	/^\.agents\//,
	/^\.git\//,
	/node_modules\//,
	/\.pytest_cache\//,
	/__pycache__\//,
	/\.gitignore$/,
	/\.gitattributes$/,
	/package-lock\.json$/,
	/yarn\.lock$/,
	/pnpm-lock\.yaml$/,
	/poetry\.lock$/,
	/\.pyc$/,
	/\.env$/,
	/\.env\./,
	/\.DS_Store$/,
	/thumbs\.db$/i,
];

// Test file patterns — changes here don't need doc updates
const TEST_PATTERNS = [
	/[/\\]tests?[/\\]/,
	/[/\\]__tests__[/\\]/,
	/[/\\]spec[/\\]/,
	/\.test\.[^/]+$/,
	/\.spec\.[^/]+$/,
	/_test\.[^/]+$/,
	/test_[^/]+\.[^/]+$/,
	/conftest\.py$/,
];

function isIgnored(path: string): boolean {
	return IGNORE_PATTERNS.some((p) => p.test(path)) || TEST_PATTERNS.some((p) => p.test(path));
}

function detectScope(files: string[]): string {
	// Extract top-level directories from changed files
	const dirs = new Set<string>();
	for (const f of files) {
		const parts = f.split("/");
		if (parts.length > 1) {
			dirs.add(parts[0]);
		}
	}
	return dirs.size > 0 ? [...dirs].join(", ") : "root";
}

export default function (pi: ExtensionAPI) {
	let promptedThisCycle = false;

	pi.on("agent_start", async () => {
		promptedThisCycle = false;
	});

	// --- Manual trigger: /update-docs command ---
	pi.registerCommand("update-docs", {
		description: "Update project documentation to match current code",
		handler: async (args, ctx) => {
			const scope = args?.trim() || "";
			const scopeMsg = scope ? `\n\nFocus on: ${scope}` : "";

			ctx.ui.notify("Triggering docs update...", "info");

			pi.sendUserMessage(
				`Follow the update-docs skill workflow now. Read the skill file first, then execute every step.${scopeMsg}\n\n/skill:update-docs`
			);
		},
	});

	// --- Automatic hook: detect source changes after agent work ---
	pi.on("agent_end", async (_event, ctx) => {
		if (promptedThisCycle) return;
		if (!ctx.hasUI) return;

		try {
			const { stdout, code } = await pi.exec("git", ["diff", "--name-only", "HEAD"], {
				timeout: 5000,
			});

			if (code !== 0 || !stdout.trim()) return;

			const changedFiles = stdout.trim().split("\n").filter(Boolean);
			const sourceFiles = changedFiles.filter((f) => !isIgnored(f));

			if (sourceFiles.length === 0) return;

			// If docs were already touched, don't nag — they may have just been updated
			const changedDocs = changedFiles.filter((f) => f.endsWith(".md"));
			if (changedDocs.length > 0) return;

			const scope = detectScope(sourceFiles);
			promptedThisCycle = true;

			const confirmed = await ctx.ui.confirm(
				"Update docs?",
				`Source files changed in: ${scope}\n` +
					`Files: ${sourceFiles.slice(0, 5).join(", ")}` +
					(sourceFiles.length > 5 ? ` (+${sourceFiles.length - 5} more)` : "") +
					`\n\nUpdate documentation to match?`,
				{ timeout: 15000 }
			);

			if (confirmed) {
				pi.sendUserMessage(
					`Follow the update-docs skill workflow now. Read the skill file first, then execute every step. Focus on: ${scope}\n\n/skill:update-docs`,
					{ deliverAs: "followUp" }
				);
			}
		} catch (_e) {
			// Git not available or not a repo — silently skip
		}
	});
}
