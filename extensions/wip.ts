/**
 * WIP & Ideas Extension
 *
 * Persistent project memory that survives across sessions:
 *
 *   /wip                    — show current work-in-progress
 *   /wip <description>      — set what you're working on right now
 *   /wip clear              — clear WIP (you're done / switching context)
 *   /wip next               — pop the top idea from backlog into WIP
 *
 *   /ideas                  — show the backlog
 *   /ideas add <idea>       — add an idea / todo
 *   /ideas done <n>         — mark idea #n as done (removes it)
 *   /ideas promote <n>      — move idea #n to WIP
 *   /ideas edit             — open full backlog in editor
 *
 * On session start: shows WIP status + idea count as a widget.
 * Stored in .pi/WIP.md and .pi/IDEAS.md — commit these to share with your team.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

// ── File paths ─────────────────────────────────────────────────────

function wipPath(cwd: string): string {
	return path.join(cwd, ".pi", "WIP.md");
}

function ideasPath(cwd: string): string {
	return path.join(cwd, ".pi", "IDEAS.md");
}

function ensurePiDir(cwd: string): void {
	const dir = path.join(cwd, ".pi");
	if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// ── WIP ────────────────────────────────────────────────────────────

interface WipEntry {
	description: string;
	since: string;
	context?: string;
}

function readWip(cwd: string): WipEntry | null {
	const file = wipPath(cwd);
	if (!fs.existsSync(file)) return null;
	const content = fs.readFileSync(file, "utf-8").trim();
	if (!content) return null;

	// Parse: first line is description, rest is context
	const lines = content.split("\n");
	let description = "";
	let since = "";
	let context = "";

	for (const line of lines) {
		if (line.startsWith("# WIP:")) {
			description = line.replace("# WIP:", "").trim();
		} else if (line.startsWith("_Since:")) {
			since = line.replace("_Since:", "").replace(/_/g, "").trim();
		} else if (line.trim() && !line.startsWith("#")) {
			context += line + "\n";
		}
	}

	if (!description) return null;
	return { description, since, context: context.trim() || undefined };
}

function writeWip(cwd: string, entry: WipEntry | null): void {
	ensurePiDir(cwd);
	const file = wipPath(cwd);
	if (!entry) {
		if (fs.existsSync(file)) fs.writeFileSync(file, "", "utf-8");
		return;
	}
	let content = `# WIP: ${entry.description}\n\n`;
	content += `_Since: ${entry.since}_\n`;
	if (entry.context) {
		content += `\n${entry.context}\n`;
	}
	fs.writeFileSync(file, content, "utf-8");
}

// ── IDEAS ──────────────────────────────────────────────────────────

interface Idea {
	text: string;
	added: string;
	tags: string[];
}

function readIdeas(cwd: string): Idea[] {
	const file = ideasPath(cwd);
	if (!fs.existsSync(file)) return [];
	const content = fs.readFileSync(file, "utf-8");
	const ideas: Idea[] = [];

	for (const line of content.split("\n")) {
		// Format: - [ ] idea text (#tag1 #tag2) — 2026-02-26
		const match = line.match(/^- \[[ x]\]\s+(.+?)(?:\s+—\s+(.+))?$/);
		if (match) {
			const raw = match[1];
			const added = match[2]?.trim() || "";
			// Extract tags
			const tags: string[] = [];
			const text = raw.replace(/#(\w[\w-]*)/g, (_m, tag) => {
				tags.push(tag);
				return "";
			}).trim();
			ideas.push({ text, added, tags });
		}
	}

	return ideas;
}

function writeIdeas(cwd: string, ideas: Idea[]): void {
	ensurePiDir(cwd);
	const file = ideasPath(cwd);
	let content = "# Ideas & Backlog\n\n";
	if (ideas.length === 0) {
		content += "_No ideas yet. Add one with `/ideas add <idea>`_\n";
	} else {
		for (const idea of ideas) {
			const tagStr = idea.tags.length > 0 ? " " + idea.tags.map((t) => `#${t}`).join(" ") : "";
			const dateStr = idea.added ? ` — ${idea.added}` : "";
			content += `- [ ] ${idea.text}${tagStr}${dateStr}\n`;
		}
	}
	fs.writeFileSync(file, content, "utf-8");
}

function todayStr(): string {
	return new Date().toISOString().slice(0, 10);
}

// ── Widget ─────────────────────────────────────────────────────────

function updateWidget(ctx: ExtensionContext): void {
	const wip = readWip(ctx.cwd);
	const ideas = readIdeas(ctx.cwd);

	if (!wip && ideas.length === 0) {
		ctx.ui.setWidget("wip", undefined);
		return;
	}

	const lines: string[] = [];

	if (wip) {
		const age = wip.since ? timeSince(wip.since) : "";
		lines.push(
			ctx.ui.theme.fg("warning", "▶ WIP: ") +
			ctx.ui.theme.fg("text", wip.description) +
			(age ? ctx.ui.theme.fg("dim", ` (${age})`) : ""),
		);
	}

	if (ideas.length > 0) {
		const top = ideas.slice(0, 3);
		const remaining = ideas.length - top.length;
		lines.push(
			ctx.ui.theme.fg("muted", `💡 ${ideas.length} idea${ideas.length !== 1 ? "s" : ""}:`) +
			" " +
			top.map((i) => ctx.ui.theme.fg("dim", i.text.slice(0, 40))).join(ctx.ui.theme.fg("muted", " · ")) +
			(remaining > 0 ? ctx.ui.theme.fg("dim", ` +${remaining} more`) : ""),
		);
	}

	ctx.ui.setWidget("wip", lines);
}

function timeSince(dateStr: string): string {
	try {
		const then = new Date(dateStr).getTime();
		const now = Date.now();
		const days = Math.floor((now - then) / (1000 * 60 * 60 * 24));
		if (days === 0) return "today";
		if (days === 1) return "yesterday";
		if (days < 7) return `${days} days ago`;
		if (days < 30) return `${Math.floor(days / 7)} week${Math.floor(days / 7) > 1 ? "s" : ""} ago`;
		return `${Math.floor(days / 30)} month${Math.floor(days / 30) > 1 ? "s" : ""} ago`;
	} catch {
		return "";
	}
}

function ensureGitignore(cwd: string): void {
	const gitignore = path.join(cwd, ".gitignore");
	const patterns = ["WIP.md", "IDEAS.md"];
	try {
		if (!fs.existsSync(gitignore)) return; // not a git repo concern
		const content = fs.readFileSync(gitignore, "utf-8");
		const missing = patterns.filter((p) => !content.includes(p));
		if (missing.length > 0) {
			fs.appendFileSync(gitignore, `\n# pi wip & ideas (personal, not committed by default)\n${missing.join("\n")}\n`);
		}
	} catch {}
}

// ── Extension ──────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {

	// Show WIP on session start, ensure gitignored
	pi.on("session_start", async (_event, ctx) => {
		ensureGitignore(ctx.cwd);
		updateWidget(ctx);
	});

	// ── /wip ───────────────────────────────────────────────────────

	pi.registerCommand("wip", {
		description: "Show or set work-in-progress: /wip, /wip <desc>, /wip clear, /wip next",
		handler: async (args, ctx) => {
			const trimmed = args?.trim() || "";

			if (!trimmed) {
				// Show current WIP
				const wip = readWip(ctx.cwd);
				if (!wip) {
					ctx.ui.notify("No WIP set. Use /wip <description> to set one.", "info");
				} else {
					let msg = `▶ **WIP:** ${wip.description}`;
					if (wip.since) msg += `\n_Since: ${wip.since} (${timeSince(wip.since)})_`;
					if (wip.context) msg += `\n\n${wip.context}`;
					pi.sendMessage(
						{ customType: "wip-status", content: msg, display: true },
						{ triggerTurn: false },
					);
				}
				updateWidget(ctx);
				return;
			}

			if (trimmed === "clear") {
				writeWip(ctx.cwd, null);
				ctx.ui.notify("WIP cleared.", "info");
				updateWidget(ctx);
				return;
			}

			if (trimmed === "next") {
				const ideas = readIdeas(ctx.cwd);
				if (ideas.length === 0) {
					ctx.ui.notify("No ideas in backlog. Add some with /ideas add <idea>", "info");
					return;
				}

				// Let user pick which idea to promote
				const options = ideas.map((idea, i) => `${i + 1}. ${idea.text}`);
				const choice = await ctx.ui.select("Promote which idea to WIP?", options);
				if (!choice) return;

				const idx = parseInt(choice) - 1;
				if (idx < 0 || idx >= ideas.length) return;

				const idea = ideas[idx];
				// Add context?
				const context = await ctx.ui.input("Any context to add? (or leave blank)");

				writeWip(ctx.cwd, {
					description: idea.text,
					since: todayStr(),
					context: context?.trim() || undefined,
				});

				// Remove from ideas
				ideas.splice(idx, 1);
				writeIdeas(ctx.cwd, ideas);

				ctx.ui.notify(`WIP set: ${idea.text}`, "info");
				updateWidget(ctx);
				return;
			}

			// Set WIP with optional context
			const context = await ctx.ui.input("Any context? (key files, approach, blockers — or leave blank)");

			writeWip(ctx.cwd, {
				description: trimmed,
				since: todayStr(),
				context: context?.trim() || undefined,
			});

			ctx.ui.notify(`WIP set: ${trimmed}`, "info");
			updateWidget(ctx);
		},
	});

	// ── /ideas ─────────────────────────────────────────────────────

	pi.registerCommand("ideas", {
		description: "Manage backlog: /ideas, /ideas add <text>, /ideas done <n>, /ideas promote <n>",
		handler: async (args, ctx) => {
			const trimmed = args?.trim() || "";

			if (!trimmed) {
				// Show all ideas
				const ideas = readIdeas(ctx.cwd);
				if (ideas.length === 0) {
					ctx.ui.notify("No ideas yet. Use /ideas add <idea> to add one.", "info");
					return;
				}

				let msg = `# 💡 Ideas & Backlog (${ideas.length})\n\n`;
				for (let i = 0; i < ideas.length; i++) {
					const idea = ideas[i];
					const tags = idea.tags.length > 0 ? " " + idea.tags.map((t) => `\`#${t}\``).join(" ") : "";
					const age = idea.added ? ` — ${idea.added}` : "";
					msg += `${i + 1}. ${idea.text}${tags}${age}\n`;
				}
				msg += `\n\`/ideas add <text>\` · \`/ideas done <n>\` · \`/ideas promote <n>\``;

				pi.sendMessage(
					{ customType: "ideas-list", content: msg, display: true },
					{ triggerTurn: false },
				);
				return;
			}

			// /ideas add <text>
			if (trimmed.startsWith("add ")) {
				const text = trimmed.slice(4).trim();
				if (!text) {
					ctx.ui.notify("Usage: /ideas add <idea text>", "error");
					return;
				}

				const ideas = readIdeas(ctx.cwd);
				const tags: string[] = [];
				const cleanText = text.replace(/#(\w[\w-]*)/g, (_m: string, tag: string) => {
					tags.push(tag);
					return "";
				}).trim();

				ideas.push({ text: cleanText, added: todayStr(), tags });
				writeIdeas(ctx.cwd, ideas);

				ctx.ui.notify(`Added idea #${ideas.length}: ${cleanText}`, "info");
				updateWidget(ctx);
				return;
			}

			// /ideas done <n>
			if (trimmed.startsWith("done ")) {
				const n = parseInt(trimmed.slice(5).trim());
				const ideas = readIdeas(ctx.cwd);

				if (isNaN(n) || n < 1 || n > ideas.length) {
					ctx.ui.notify(`Invalid number. Range: 1-${ideas.length}`, "error");
					return;
				}

				const removed = ideas.splice(n - 1, 1)[0];
				writeIdeas(ctx.cwd, ideas);

				ctx.ui.notify(`✓ Done: ${removed.text}`, "info");
				updateWidget(ctx);
				return;
			}

			// /ideas promote <n>
			if (trimmed.startsWith("promote ")) {
				const n = parseInt(trimmed.slice(8).trim());
				const ideas = readIdeas(ctx.cwd);

				if (isNaN(n) || n < 1 || n > ideas.length) {
					ctx.ui.notify(`Invalid number. Range: 1-${ideas.length}`, "error");
					return;
				}

				const idea = ideas[n - 1];
				const context = await ctx.ui.input("Any context to add? (or leave blank)");

				writeWip(ctx.cwd, {
					description: idea.text,
					since: todayStr(),
					context: context?.trim() || undefined,
				});

				ideas.splice(n - 1, 1);
				writeIdeas(ctx.cwd, ideas);

				ctx.ui.notify(`WIP set: ${idea.text}`, "info");
				updateWidget(ctx);
				return;
			}

			// /ideas edit — open in editor
			if (trimmed === "edit") {
				const ideas = readIdeas(ctx.cwd);
				const text = ideas.map((i, idx) => {
					const tags = i.tags.length > 0 ? " " + i.tags.map((t) => `#${t}`).join(" ") : "";
					return `${idx + 1}. ${i.text}${tags}`;
				}).join("\n") || "(empty — add ideas, one per line)";

				const edited = await ctx.ui.editor("Edit backlog (one idea per line, #tags supported):", text);
				if (edited === undefined) return;

				// Parse edited text back into ideas
				const newIdeas: Idea[] = [];
				for (const line of edited.split("\n")) {
					const clean = line.replace(/^\d+\.\s*/, "").trim();
					if (!clean) continue;
					const tags: string[] = [];
					const ideaText = clean.replace(/#(\w[\w-]*)/g, (_m: string, tag: string) => {
						tags.push(tag);
						return "";
					}).trim();
					if (ideaText) {
						// Preserve date if it was an existing idea
						const existing = ideas.find((i) => i.text === ideaText);
						newIdeas.push({ text: ideaText, added: existing?.added || todayStr(), tags });
					}
				}

				writeIdeas(ctx.cwd, newIdeas);
				ctx.ui.notify(`Backlog updated: ${newIdeas.length} ideas`, "info");
				updateWidget(ctx);
				return;
			}

			// Treat anything else as a quick add
			const ideas = readIdeas(ctx.cwd);
			const tags: string[] = [];
			const cleanText = trimmed.replace(/#(\w[\w-]*)/g, (_m: string, tag: string) => {
				tags.push(tag);
				return "";
			}).trim();

			ideas.push({ text: cleanText, added: todayStr(), tags });
			writeIdeas(ctx.cwd, ideas);

			ctx.ui.notify(`Added idea #${ideas.length}: ${cleanText}`, "info");
			updateWidget(ctx);
		},
	});
}
