/**
 * Handoff Extension
 *
 * When context is running out or you want to switch sessions:
 *   /handoff           — summarize current work + write HANDOFF.md
 *   /pickup [file]     — start a new session from a handoff file
 *
 * The handoff file captures:
 * - What was being worked on
 * - What's done, what's not
 * - Key files touched/relevant
 * - Exact next steps to continue
 *
 * Written to .pi/waves/<project>/HANDOFF.md if in a wave project,
 * or .pi/HANDOFF-<timestamp>.md otherwise.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

// ── Helpers ────────────────────────────────────────────────────────

type ContentBlock = { type?: string; text?: string; name?: string; arguments?: Record<string, unknown> };
type SessionEntry = { type: string; customType?: string; message?: { role?: string; content?: unknown; toolName?: string } };

function extractText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((p: any) => p?.type === "text" && typeof p.text === "string")
		.map((p: any) => p.text)
		.join("\n");
}

function extractToolCalls(content: unknown): string[] {
	if (!Array.isArray(content)) return [];
	return content
		.filter((p: any) => p?.type === "toolCall" && typeof p.name === "string")
		.map((p: any) => {
			const args = p.arguments ?? {};
			if (p.name === "bash") return `bash: ${(args.command || "").toString().slice(0, 100)}`;
			if (p.name === "write" || p.name === "edit") return `${p.name}: ${args.path || ""}`;
			if (p.name === "read") return `read: ${args.path || ""}`;
			return `${p.name}: ${JSON.stringify(args).slice(0, 80)}`;
		});
}

function buildConversationSummary(entries: SessionEntry[], lastN: number = 30): string {
	// Take the last N entries to stay focused on recent work
	const recent = entries.slice(-lastN);
	const sections: string[] = [];

	for (const entry of recent) {
		if (entry.type !== "message" || !entry.message?.role) continue;
		const role = entry.message.role;

		if (role === "user") {
			const text = extractText(entry.message.content).trim();
			if (text) sections.push(`User: ${text.slice(0, 500)}`);
		} else if (role === "assistant") {
			const text = extractText(entry.message.content).trim();
			const tools = extractToolCalls(entry.message.content);
			if (text) sections.push(`Assistant: ${text.slice(0, 500)}`);
			if (tools.length > 0) sections.push(`Tools: ${tools.join(", ")}`);
		} else if (role === "toolResult") {
			// Skip tool results to keep it concise
		}
	}

	return sections.join("\n");
}

function findActiveWaveProject(cwd: string): string | null {
	const wavesDir = path.join(cwd, ".pi", "waves");
	if (!fs.existsSync(wavesDir)) return null;

	// Find the most recently modified wave project
	try {
		const dirs = fs.readdirSync(wavesDir, { withFileTypes: true })
			.filter((d) => d.isDirectory())
			.map((d) => ({
				name: d.name,
				mtime: fs.statSync(path.join(wavesDir, d.name)).mtimeMs,
			}))
			.sort((a, b) => b.mtime - a.mtime);
		return dirs.length > 0 ? dirs[0].name : null;
	} catch {
		return null;
	}
}

// ── Extension ──────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {

	pi.registerCommand("handoff", {
		description: "Create a handoff file to continue work in a new session",
		handler: async (args, ctx) => {
			const entries = ctx.sessionManager.getBranch() as SessionEntry[];

			if (entries.length < 3) {
				ctx.ui.notify("Not enough conversation to create a handoff.", "info");
				return;
			}

			// Ask what's unfinished
			const status = await ctx.ui.select("What's the status of current work?", [
				"In progress — was actively working on something",
				"Blocked — hit an issue, need a different approach",
				"Partially done — some parts finished, some remain",
				"Exploring — was investigating, haven't started implementing",
			]);

			if (!status) return;

			const nextSteps = await ctx.ui.input("What should the next session focus on? (or leave blank for auto-detect)");

			// Build the conversation context
			const conversationContext = buildConversationSummary(entries);

			// Gather file context — find recently touched files from tool calls
			const touchedFiles = new Set<string>();
			const readFiles = new Set<string>();
			for (const entry of entries.slice(-50)) {
				if (entry.type !== "message" || !entry.message) continue;
				const content = entry.message.content;
				if (!Array.isArray(content)) continue;
				for (const block of content) {
					if (block?.type !== "toolCall") continue;
					const args2 = (block as any).arguments ?? {};
					const filePath = args2.path || args2.file_path;
					if (!filePath) continue;
					if (block.name === "write" || block.name === "edit") touchedFiles.add(filePath);
					if (block.name === "read") readFiles.add(filePath);
				}
			}

			// Check for active wave project
			const waveProject = findActiveWaveProject(ctx.cwd);
			let waveContext = "";
			if (waveProject) {
				const specFile = path.join(ctx.cwd, ".pi", "waves", waveProject, "SPEC.md");
				const planFile = path.join(ctx.cwd, ".pi", "waves", waveProject, "PLAN.md");
				const logFile = path.join(ctx.cwd, ".pi", "waves", waveProject, "EXECUTION.md");
				if (fs.existsSync(specFile)) waveContext += `\nWave project: ${waveProject}`;
				if (fs.existsSync(specFile)) waveContext += `\nSpec: .pi/waves/${waveProject}/SPEC.md`;
				if (fs.existsSync(planFile)) waveContext += `\nPlan: .pi/waves/${waveProject}/PLAN.md`;
				if (fs.existsSync(logFile)) waveContext += `\nExecution log: .pi/waves/${waveProject}/EXECUTION.md`;
			}

			// Build handoff document
			const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
			let handoff = `# Handoff — ${timestamp}\n\n`;
			handoff += `## Status\n${status}\n\n`;

			if (nextSteps?.trim()) {
				handoff += `## Next Steps (from user)\n${nextSteps.trim()}\n\n`;
			}

			if (waveContext) {
				handoff += `## Wave Project${waveContext}\n\n`;
			}

			if (touchedFiles.size > 0) {
				handoff += `## Files Modified\n`;
				for (const f of touchedFiles) handoff += `- \`${f}\`\n`;
				handoff += "\n";
			}

			if (readFiles.size > 0) {
				const relevantReads = [...readFiles].filter((f) => !touchedFiles.has(f)).slice(0, 15);
				if (relevantReads.length > 0) {
					handoff += `## Key Files Read\n`;
					for (const f of relevantReads) handoff += `- \`${f}\`\n`;
					handoff += "\n";
				}
			}

			handoff += `## Recent Conversation Context\n\`\`\`\n${conversationContext.slice(-3000)}\n\`\`\`\n\n`;
			handoff += `## How to Continue\n`;
			handoff += `Start a new pi session and run:\n`;
			handoff += `\`\`\`\n/pickup <path-to-this-file>\n\`\`\`\n`;
			handoff += `Or paste this file's content as context.\n`;

			// Determine output path
			let outputPath: string;
			if (waveProject) {
				outputPath = path.join(ctx.cwd, ".pi", "waves", waveProject, `HANDOFF-${timestamp}.md`);
			} else {
				const piDir = path.join(ctx.cwd, ".pi");
				if (!fs.existsSync(piDir)) fs.mkdirSync(piDir, { recursive: true });
				outputPath = path.join(piDir, `HANDOFF-${timestamp}.md`);
			}

			fs.writeFileSync(outputPath, handoff, "utf-8");
			const relPath = path.relative(ctx.cwd, outputPath);

			pi.sendMessage(
				{
					customType: "handoff",
					content: `📋 **Handoff created** → \`${relPath}\`\n\nIn a new session, run \`/pickup ${relPath}\` to continue.`,
					display: true,
				},
				{ triggerTurn: false },
			);

			ctx.ui.notify(`Handoff → ${relPath}`, "info");
		},
	});

	pi.registerCommand("pickup", {
		description: "Continue from a handoff file (e.g. /pickup .pi/HANDOFF-2026-02-26.md)",
		handler: async (args, ctx) => {
			if (!args?.trim()) {
				// Find most recent handoff file
				const candidates: { path: string; mtime: number }[] = [];

				// Check .pi/ for handoffs
				const piDir = path.join(ctx.cwd, ".pi");
				if (fs.existsSync(piDir)) {
					for (const f of fs.readdirSync(piDir)) {
						if (f.startsWith("HANDOFF-") && f.endsWith(".md")) {
							const p = path.join(piDir, f);
							candidates.push({ path: p, mtime: fs.statSync(p).mtimeMs });
						}
					}
				}

				// Check .pi/waves/*/
				const wavesDir = path.join(ctx.cwd, ".pi", "waves");
				if (fs.existsSync(wavesDir)) {
					for (const dir of fs.readdirSync(wavesDir, { withFileTypes: true })) {
						if (!dir.isDirectory()) continue;
						const d = path.join(wavesDir, dir.name);
						for (const f of fs.readdirSync(d)) {
							if (f.startsWith("HANDOFF-") && f.endsWith(".md")) {
								const p = path.join(d, f);
								candidates.push({ path: p, mtime: fs.statSync(p).mtimeMs });
							}
						}
					}
				}

				if (candidates.length === 0) {
					ctx.ui.notify("No handoff files found. Usage: /pickup <path>", "info");
					return;
				}

				// Let user pick
				candidates.sort((a, b) => b.mtime - a.mtime);
				const options = candidates.map((c) => path.relative(ctx.cwd, c.path));
				const choice = await ctx.ui.select("Pick a handoff to continue from:", options);
				if (!choice) return;
				args = choice;
			}

			const filePath = path.resolve(ctx.cwd, args.trim());
			if (!fs.existsSync(filePath)) {
				ctx.ui.notify(`File not found: ${args.trim()}`, "error");
				return;
			}

			const content = fs.readFileSync(filePath, "utf-8");

			// Send the handoff content as context for the LLM
			pi.sendUserMessage(
				`I'm picking up from a previous session. Here's the handoff document:\n\n${content}\n\nPlease review this handoff and continue the work. Start by understanding what was done, what's remaining, and then proceed with the next steps.`,
			);
		},
	});
}
