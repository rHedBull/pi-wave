/**
 * Wave Executor Extension
 *
 * Three-phase workflow with reviewable files:
 *
 *   /waves-spec <task>    — Scout + brainstorm → creates SPEC.md
 *   /waves-plan           — Reads SPEC.md → creates PLAN.md (wave-based tasks)
 *   /waves-execute        — Reads SPEC.md + PLAN.md → wave-executes with verification
 *
 * Files are written to .pi/waves/ in the project directory so you can
 * review, edit, and version control them before executing.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

// ── Config ─────────────────────────────────────────────────────────

const MAX_CONCURRENCY = 6;
const MAX_RETRIES_PER_WAVE = 1;

// ── Types ──────────────────────────────────────────────────────────

interface Task {
	id: string;
	title: string;
	agent: string;
	files: string[];
	specRefs: string[];
	testFiles: string[];
	description: string;
}

interface Wave {
	name: string;
	description: string;
	tasks: Task[];
}

interface Plan {
	goal: string;
	waves: Wave[];
}

interface TaskResult {
	id: string;
	title: string;
	exitCode: number;
	output: string;
	stderr: string;
}

interface WaveResult {
	wave: string;
	taskResults: TaskResult[];
	verificationPassed: boolean;
	verificationOutput: string;
}

// ── Helpers ────────────────────────────────────────────────────────

function wavesBaseDir(cwd: string): string {
	return path.join(cwd, ".pi", "waves");
}

function slugify(text: string): string {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 60);
}

function waveProjectDir(cwd: string, name: string): string {
	return path.join(wavesBaseDir(cwd), name);
}

function specPath(cwd: string, name: string): string {
	return path.join(waveProjectDir(cwd, name), "SPEC.md");
}

function planPath(cwd: string, name: string): string {
	return path.join(waveProjectDir(cwd, name), "PLAN.md");
}

function logFilePath(cwd: string, name: string): string {
	return path.join(waveProjectDir(cwd, name), "EXECUTION.md");
}

function ensureProjectDir(cwd: string, name: string): void {
	const dir = waveProjectDir(cwd, name);
	if (!fs.existsSync(dir)) {
		fs.mkdirSync(dir, { recursive: true });
	}
}

function listWaveProjects(cwd: string): string[] {
	const base = wavesBaseDir(cwd);
	if (!fs.existsSync(base)) return [];
	return fs.readdirSync(base, { withFileTypes: true })
		.filter((d) => d.isDirectory())
		.map((d) => d.name)
		.sort();
}

// ── File Access Enforcement ────────────────────────────────────────

interface FileAccessRules {
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

function generateEnforcementExtension(rules: FileAccessRules): string {
	return `
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import * as path from "node:path";

const rules = ${JSON.stringify(rules)};

function matchesPattern(filePath, patterns) {
	const normalized = path.resolve(filePath);
	return patterns.some(p => {
		if (p.includes("*")) {
			const regex = new RegExp("^" + p.replace(/\\./g, "\\\\.").replace(/\\*/g, ".*") + "$");
			return regex.test(normalized) || regex.test(path.basename(normalized));
		}
		const resolvedPattern = path.resolve(p);
		return normalized === resolvedPattern || normalized.startsWith(resolvedPattern + path.sep);
	});
}

export default function (pi) {
	pi.on("tool_call", async (event) => {
		const toolName = event.toolName;
		const filePath = event.input.path || event.input.file_path || "";

		// Enforce protected paths (never writable)
		if (rules.protectedPaths && rules.protectedPaths.length > 0 && (toolName === "write" || toolName === "edit")) {
			if (matchesPattern(filePath, rules.protectedPaths)) {
				return { block: true, reason: "BLOCKED: " + filePath + " is a protected document and cannot be modified during execution." };
			}
		}

		// Enforce read-only mode
		if (rules.readOnly && (toolName === "write" || toolName === "edit")) {
			return { block: true, reason: "BLOCKED: This agent is read-only. Cannot " + toolName + " " + filePath };
		}

		// Enforce write allowlist
		if (rules.allowWrite && rules.allowWrite.length > 0 && (toolName === "write" || toolName === "edit")) {
			if (!matchesPattern(filePath, rules.allowWrite)) {
				return {
					block: true,
					reason: "BLOCKED: Not allowed to " + toolName + " " + filePath + ". Allowed files: " + rules.allowWrite.join(", ")
				};
			}
		}

		// Enforce read allowlist (if specified)
		if (rules.allowRead && rules.allowRead.length > 0 && toolName === "read") {
			if (!matchesPattern(filePath, rules.allowRead)) {
				return {
					block: true,
					reason: "BLOCKED: Not allowed to read " + filePath + ". Allowed files: " + rules.allowRead.join(", ")
				};
			}
		}

		// Enforce safe bash
		if (rules.safeBashOnly && toolName === "bash") {
			const cmd = event.input.command || "";
			const destructive = [/\\brm\\b/, /\\bmv\\b/, /\\bcp\\b/, /\\bmkdir\\b/, /\\btouch\\b/, /\\bchmod\\b/,
				/\\btee\\b/, /(^|[^<])>(?!>)/, />>/, /\\bsudo\\b/, /\\bgit\\s+(add|commit|push|reset|checkout)/i];
			if (destructive.some(p => p.test(cmd))) {
				return { block: true, reason: "BLOCKED: Destructive bash command not allowed for this agent: " + cmd };
			}
		}
	});
}
`;
}

function writeEnforcementExtension(cwd: string, taskId: string, rules: FileAccessRules): { filePath: string; dir: string } {
	const dir = path.join(os.tmpdir(), `pi-wave-enforce-${taskId}-${Date.now()}`);
	fs.mkdirSync(dir, { recursive: true });
	const filePath = path.join(dir, "enforce.ts");
	fs.writeFileSync(filePath, generateEnforcementExtension(rules), { encoding: "utf-8", mode: 0o600 });
	return { filePath, dir };
}

function cleanupEnforcement(filePath: string, dir: string): void {
	try { fs.unlinkSync(filePath); } catch { /* ignore */ }
	try { fs.rmdirSync(dir); } catch { /* ignore */ }
}

// ── Subagent Runner ────────────────────────────────────────────────

function runSubagent(
	agentName: string,
	task: string,
	cwd: string,
	signal?: AbortSignal,
	fileRules?: FileAccessRules,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	return new Promise((resolve) => {
		const args = ["--mode", "json", "-p", "--no-session"];

		// Resolve package root for bundled resources
		const packageRoot = path.join(__dirname, "..", "..");

		// Look for agent definitions: first in package dir, then in global agents dir
		const packageAgentsDir = path.join(packageRoot, "agents");
		const globalAgentsDir = path.join(os.homedir(), ".pi", "agent", "agents");
		const agentFile = fs.existsSync(path.join(packageAgentsDir, `${agentName}.md`))
			? path.join(packageAgentsDir, `${agentName}.md`)
			: path.join(globalAgentsDir, `${agentName}.md`);
		if (fs.existsSync(agentFile)) {
			args.push("--append-system-prompt", agentFile);
		}

		// Generate and load file access enforcement extension
		let enforcement: { filePath: string; dir: string } | null = null;
		if (fileRules) {
			enforcement = writeEnforcementExtension(cwd, agentName + "-" + Math.random().toString(36).slice(2, 8), fileRules);
			args.push("-e", enforcement.filePath);
		}

		args.push(`Task: ${task}`);

		let stdout = "";
		let stderr = "";

		const proc = spawn("pi", args, { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });

		proc.stdout.on("data", (data) => {
			stdout += data.toString();
		});
		proc.stderr.on("data", (data) => {
			stderr += data.toString();
		});

		proc.on("close", (code) => {
			if (enforcement) cleanupEnforcement(enforcement.filePath, enforcement.dir);
			resolve({ exitCode: code ?? 1, stdout, stderr });
		});
		proc.on("error", () => {
			if (enforcement) cleanupEnforcement(enforcement.filePath, enforcement.dir);
			resolve({ exitCode: 1, stdout, stderr: stderr || "Failed to spawn pi" });
		});

		if (signal) {
			const kill = () => {
				proc.kill("SIGTERM");
				setTimeout(() => { if (!proc.killed) proc.kill("SIGKILL"); }, 5000);
			};
			if (signal.aborted) kill();
			else signal.addEventListener("abort", kill, { once: true });
		}
	});
}

function extractFinalOutput(jsonLines: string): string {
	const lines = jsonLines.split("\n").filter((l) => l.trim());
	let lastText = "";
	for (const line of lines) {
		try {
			const event = JSON.parse(line);
			if (event.type === "message_end" && event.message?.role === "assistant") {
				for (const part of event.message.content) {
					if (part.type === "text") lastText = part.text;
				}
			}
		} catch { /* skip */ }
	}
	return lastText;
}

async function mapConcurrent<T, R>(
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

// ── PLAN.md Parser ─────────────────────────────────────────────────

function parsePlan(markdown: string): Plan {
	const lines = markdown.split("\n");
	const plan: Plan = { goal: "", waves: [] };

	let currentWave: Wave | null = null;
	let currentTask: Task | null = null;
	let inDescription = false;
	let descriptionLines: string[] = [];

	const flushTask = () => {
		if (currentTask && currentWave) {
			currentTask.description = descriptionLines.join("\n").trim();
			currentWave.tasks.push(currentTask);
		}
		currentTask = null;
		inDescription = false;
		descriptionLines = [];
	};

	const flushWave = () => {
		flushTask();
		if (currentWave && currentWave.tasks.length > 0) {
			plan.waves.push(currentWave);
		}
		currentWave = null;
	};

	for (const line of lines) {
		// Goal
		if (line.startsWith("## Goal")) {
			continue;
		}
		if (!plan.goal && lines[lines.indexOf(line) - 1]?.startsWith("## Goal")) {
			plan.goal = line.trim();
			continue;
		}

		// Wave header: ## Wave N: Name
		const waveMatch = line.match(/^## Wave \d+:\s*(.+)/);
		if (waveMatch) {
			flushWave();
			currentWave = { name: waveMatch[1].trim(), description: "", tasks: [] };
			continue;
		}

		// Wave description (line after wave header, before first task)
		if (currentWave && currentWave.tasks.length === 0 && !currentTask && !line.startsWith("###") && line.trim() && !line.startsWith("## ") && !line.startsWith("# ")) {
			if (!currentWave.description) {
				currentWave.description = line.trim();
			}
			continue;
		}

		// Task header: ### Task w1-t1: Title
		const taskMatch = line.match(/^### Task ([\w-]+):\s*(.+)/);
		if (taskMatch) {
			flushTask();
			currentTask = {
				id: taskMatch[1],
				title: taskMatch[2].trim(),
				agent: "worker",
				files: [],
				specRefs: [],
				testFiles: [],
				description: "",
			};
			inDescription = false;
			descriptionLines = [];
			continue;
		}

		if (currentTask) {
			// Agent line
			const agentMatch = line.match(/^\s*-\s*\*\*Agent\*\*:\s*(.+)/);
			if (agentMatch) {
				currentTask.agent = agentMatch[1].trim().replace(/`/g, "");
				continue;
			}

			// Files line
			const filesMatch = line.match(/^\s*-\s*\*\*Files?\*\*:\s*(.+)/);
			if (filesMatch) {
				currentTask.files = filesMatch[1].split(",").map((f) =>
					f.trim().replace(/`/g, ""),
				).filter(Boolean);
				continue;
			}

			// Tests line (which test files this implementation should satisfy)
			const testsMatch = line.match(/^\s*-\s*\*\*Tests?\*\*:\s*(.+)/);
			if (testsMatch) {
				currentTask.testFiles = testsMatch[1].split(",").map((f) =>
					f.trim().replace(/`/g, ""),
				).filter(Boolean);
				continue;
			}

			// Spec refs line
			const refsMatch = line.match(/^\s*-\s*\*\*Spec refs?\*\*:\s*(.+)/);
			if (refsMatch) {
				currentTask.specRefs = refsMatch[1].split(",").map((r) => r.trim()).filter(Boolean);
				continue;
			}

			// Description line
			const descMatch = line.match(/^\s*-\s*\*\*Description\*\*:\s*(.+)/);
			if (descMatch) {
				inDescription = true;
				descriptionLines.push(descMatch[1]);
				continue;
			}

			// Continuation of description (indented lines or non-metadata lines after description starts)
			if (inDescription) {
				descriptionLines.push(line);
			}
		}
	}

	flushWave();

	// Extract goal from first line if not found via ## Goal
	if (!plan.goal) {
		const goalMatch = markdown.match(/^# Implementation Plan\s*\n+(.+)/m);
		if (goalMatch) plan.goal = goalMatch[1].trim();
	}

	return plan;
}

// ── Extension ──────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {

	// ── /waves ───────────────────────────────────────────────────────

	pi.registerCommand("waves", {
		description: "List wave projects in this repo",
		handler: async (_args, ctx) => {
			const projects = listWaveProjects(ctx.cwd);
			if (projects.length === 0) {
				ctx.ui.notify("No wave projects yet. Run /spec <task> to create one.", "info");
				return;
			}

			let summary = `**Wave projects** in \`.pi/waves/\`:\n\n`;
			for (const name of projects) {
				const dir = waveProjectDir(ctx.cwd, name);
				const hasSpec = fs.existsSync(path.join(dir, "SPEC.md"));
				const hasPlan = fs.existsSync(path.join(dir, "PLAN.md"));
				const hasLog = fs.existsSync(path.join(dir, "EXECUTION.md"));
				const icons = [
					hasSpec ? "📄 SPEC" : null,
					hasPlan ? "📋 PLAN" : null,
					hasLog ? "📝 LOG" : null,
				].filter(Boolean).join("  ");
				summary += `- **${name}**  ${icons}\n`;
			}
			summary += `\nCommands: \`/waves-spec <task>\`, \`/waves-plan <name>\`, \`/waves-execute <name>\``;

			pi.sendMessage(
				{ customType: "wave-list", content: summary, display: true },
				{ triggerTurn: false },
			);
		},
	});

	// ── /waves-spec ─────────────────────────────────────────────────

	const SCOPES = ["hack", "standard", "enterprise"] as const;
	type Scope = (typeof SCOPES)[number];

	function parseSpecArgs(args: string): { scope: Scope; query: string } | null {
		const trimmed = args.trim();
		if (!trimmed) return null;
		const firstWord = trimmed.split(/\s+/)[0].toLowerCase();
		if (SCOPES.includes(firstWord as Scope)) {
			const query = trimmed.slice(firstWord.length).trim();
			return query ? { scope: firstWord as Scope, query } : null;
		}
		return { scope: "standard", query: trimmed };
	}

	function buildBrainstormPrompt(scope: Scope, query: string, projectName: string, scoutContext: string, specFilePath: string): string {
		const scopeLabel = scope === "hack" ? "quick hack" : scope === "enterprise" ? "enterprise-grade" : "standard";

		const scopeGuidance = scope === "hack"
			? `This is a **quick hack** — keep brainstorming brief. 1-2 clarifying questions max, then propose the simplest approach and write a short spec (under 50 lines).

**Topics to cover** (briefly — skip any that are obvious from context):
- [ ] Approach: quickest path vs slightly cleaner
- [ ] Where to make the change (which files)
- [ ] What "done" looks like`
			: scope === "enterprise"
			? `This is **enterprise-grade** work. Be thorough in your exploration. Ask as many questions as needed across multiple rounds.

**Topics you MUST cover** — ask about each one if the user hasn't addressed it yet. Check them off mentally as you go. Before writing the spec, review this list and ask about any uncovered topics.

- [ ] **Problem & goal**: What problem does this solve? What's the desired outcome?
- [ ] **Users/consumers**: Who uses this? (end users, developers, internal systems)
- [ ] **Integration strategy**: Extend existing code, new module, replace, adapter, or greenfield?
- [ ] **Integration points**: Which specific files/functions/interfaces does new code hook into?
- [ ] **Legacy & compatibility**: Must preserve existing behavior? Deprecation path? Migration?
- [ ] **Legacy cleanup**: Clean up adjacent code or leave untouched?
- [ ] **Scale & performance**: Expected load? Latency requirements? Caching needs?
- [ ] **Constraints**: Backward compatibility, deadlines, dependency versions?
- [ ] **Security**: Auth changes, input validation, data exposure, rate limiting?
- [ ] **Error handling**: Error taxonomy, response format, recovery behavior, edge cases?
- [ ] **API versioning**: Versioning strategy, breaking vs non-breaking changes?
- [ ] **Testing strategy**: TDD? Unit + integration + E2E? Match existing patterns?
- [ ] **Logging & monitoring**: Log levels, structured logging, health checks, metrics, alerting?
- [ ] **CI/CD & deployment**: Pipeline changes, feature flags, rollback, migration?
- [ ] **Documentation**: API docs, ADRs, runbooks, README updates?
- [ ] **Scalability plan**: Horizontal scaling, stateless design, bottlenecks?`
			: `This is **standard** scope. Balance thoroughness with pragmatism. 3-6 clarifying questions across a few rounds.

**Topics you MUST cover** — ask about each one if the user hasn't addressed it yet. Before writing the spec, review this list and ask about any uncovered topics.

- [ ] **Goal**: What are we building and why?
- [ ] **Scope**: Minimal change, moderate (include related cleanups), or thorough (tests, docs, related code)?
- [ ] **Approach**: Propose 2-3 options with trade-offs
- [ ] **Patterns & conventions**: Follow existing codebase patterns or specific preferences?
- [ ] **Testing**: Match existing test patterns, comprehensive, minimal, or none?
- [ ] **Error handling**: How should errors be handled? Match existing patterns?
- [ ] **Affected files**: Which files need changes?`;

		return `# Brainstorming: ${query}

You are brainstorming a ${scopeLabel} feature with the user. A scout has already explored the codebase. Your job is to have a **natural, collaborative conversation** to fully understand what needs to be built before writing the spec.

## Scout Findings

${scoutContext}

## Your Process

${scopeGuidance}

**How to brainstorm:**
1. **Present the scout findings** — summarize what you found in the codebase relevant to this task
2. **Ask clarifying questions ONE AT A TIME** — don't overwhelm with multiple questions. Prefer offering 2-3 concrete options when possible, but open-ended is fine too
3. **Propose 2-3 approaches** with trade-offs and your recommendation — explain WHY you recommend one
4. **Iterate** — go back and forth until the design is clear. Be ready to revise based on feedback
5. **Before offering to write the spec**, review the topics checklist above. If any topic hasn't been discussed and is relevant, ask about it now.
6. **When all topics are covered and the user approves**, write the spec to \`${specFilePath}\`

**IMPORTANT RULES:**
- Do NOT write any implementation code. Only explore, discuss, and ultimately write the spec.
- Do NOT write the spec until the user has approved the approach. Ask "Ready for me to write the spec?" or similar.
- Ask ONE question per message. If a topic needs more exploration, break it into multiple messages.
- If the user's answer covers multiple topics at once, acknowledge that and move on — don't re-ask about things already answered.
- If a topic from the checklist is clearly not relevant (e.g., API versioning for an internal refactor), briefly note you're skipping it and why.
- When you DO write the spec, save it to \`${specFilePath}\` using the write tool.
- After writing the spec, tell the user: "Next step: \`/waves-plan ${projectName}\` to create the implementation plan."

## Spec Format (when ready to write)

${scope === "hack" ? `\`\`\`markdown
# Spec: <Title>

## What
2-3 sentences. What we're building.

## Where
- \`path/to/file.ts\` — what changes

## How
Brief approach. 5-10 lines max.

## Done When
Bullet list of what "working" looks like.
\`\`\`` : scope === "enterprise" ? `Write a comprehensive spec (200-500+ lines) covering:
- Overview, Current State, User Decisions
- Functional Requirements (20-50+), Non-Functional Requirements (10-20)
- Affected Files, API/Interface Changes, Data Model Changes
- Integration Strategy (integration points, approach, legacy considerations, dependency map)
- Error Handling Strategy (taxonomy, edge cases, error scenarios)
- Security, API Versioning, Logging & Monitoring
- CI/CD & Deployment, Documentation Plan, Scalability Plan
- Testing Criteria (unit, integration, E2E, edge case, performance)
- Migration Plan, Out of Scope, Open Questions` : `\`\`\`markdown
# Spec: <Title>

## Overview
3-5 sentences on what this feature does.

## Current State
Key files, how things work now.

## Requirements
1. FR-1: ...
(10-20 requirements)

## Affected Files
- \`path/to/file.ts\` — what changes

## API / Interface Changes
New or changed APIs, types, signatures.

## Testing Criteria
- Test that X works when Y
(5-15 test criteria)

## Out of Scope
What we're explicitly NOT doing.
\`\`\``}

Now, start by presenting the scout findings and asking your first question.`;
	}

	pi.registerCommand("waves-spec", {
		description: "Brainstorm and create a spec: /waves-spec [hack|standard|enterprise] <task>",
		handler: async (args, ctx) => {
			const parsed = parseSpecArgs(args || "");
			if (!parsed) {
				ctx.ui.notify(
					"Usage: /waves-spec [scope] <task>\n\n" +
					"Scopes:\n" +
					"  hack        — quick, 1-2 questions, minimal spec\n" +
					"  standard    — balanced, collaborative brainstorming (default)\n" +
					"  enterprise  — thorough, multi-round exploration\n\n" +
					"Examples:\n" +
					"  /waves-spec hack add a debug flag\n" +
					"  /waves-spec add OAuth2 support\n" +
					"  /waves-spec enterprise redesign the auth module",
					"info",
				);
				return;
			}

			const { scope, query } = parsed;
			const scopeEmoji = scope === "hack" ? "⚡" : scope === "enterprise" ? "🏢" : "📋";
			const projectName = slugify(query);
			ensureProjectDir(ctx.cwd, projectName);

			// Phase 1: Scout
			ctx.ui.setStatus("waves", ctx.ui.theme.fg("warning", `🔍 [${projectName}] Scouting...`));
			const scoutDepth = scope === "hack" ? "Quick" : scope === "enterprise" ? "Thorough" : "Medium";
			const enterpriseExtra = scope === "enterprise"
				? `\n\nIMPORTANT — Enterprise mode: In addition to standard scouting, you MUST also:\n- Identify and propose specific integration points: exact files, functions, interfaces, and classes where new code should hook into existing code\n- Map the dependency graph around the affected area: what depends on this code, what does it depend on\n- Flag legacy code that may need replacing, wrapping, or deprecating\n- Note existing abstractions/interfaces that new code should implement or extend\n- Include a section "## Proposed Integration Points" in your output listing each point with file path, function/class, and how to integrate`
				: "";
			const scoutResult = await runSubagent("scout", `${scoutDepth} investigation: ${query}${enterpriseExtra}`, ctx.cwd, undefined, { readOnly: true, safeBashOnly: true });
			const scoutOutput = extractFinalOutput(scoutResult.stdout);

			if (scoutResult.exitCode !== 0 || !scoutOutput) {
				ctx.ui.setStatus("waves", undefined);
				ctx.ui.notify("Scout failed: " + (scoutResult.stderr || "no output"), "error");
				return;
			}
			ctx.ui.setStatus("waves", undefined);

			// Phase 2: Brainstorm — send context to main agent for collaborative conversation
			const file = specPath(ctx.cwd, projectName);
			const relFile = path.relative(ctx.cwd, file);

			const brainstormPrompt = buildBrainstormPrompt(scope, query, projectName, scoutOutput, relFile);

			ctx.ui.notify(`${scopeEmoji} Scout complete. Starting brainstorming session...`, "info");

			pi.sendMessage(
				{
					customType: "wave-brainstorm",
					content: brainstormPrompt,
					display: false,
				},
				{
					triggerTurn: true,
					deliverAs: "followUp",
				},
			);
		},
	});

	// ── /plan ────────────────────────────────────────────────────────

	pi.registerCommand("waves-plan", {
		description: "Create PLAN.md for a wave project (e.g. /waves-plan add-oauth2-support)",
		handler: async (args, ctx) => {
			let projectName: string;
			let extraInstructions: string;

			if (!args?.trim()) {
				// No args: check current dir for SPEC.md first
				const localSpec = path.join(ctx.cwd, "SPEC.md");
				if (fs.existsSync(localSpec)) {
					// Use current directory's SPEC.md — create a project from the dir name
					projectName = slugify(path.basename(ctx.cwd));
					extraInstructions = "";
					ensureProjectDir(ctx.cwd, projectName);
					// Copy local SPEC.md into wave project dir if not already there
					const waveSpec = specPath(ctx.cwd, projectName);
					if (!fs.existsSync(waveSpec)) {
						fs.copyFileSync(localSpec, waveSpec);
					}
				} else {
					// List projects that have a spec but no plan yet
					const projects = listWaveProjects(ctx.cwd);
					const ready = projects.filter((p) =>
						fs.existsSync(specPath(ctx.cwd, p)) && !fs.existsSync(planPath(ctx.cwd, p))
					);
					if (ready.length > 0) {
						ctx.ui.notify(`Usage: /waves-plan <name>\nReady for planning: ${ready.join(", ")}`, "info");
					} else if (projects.length > 0) {
						ctx.ui.notify(`Usage: /waves-plan <name> [extra instructions]\nProjects: ${projects.join(", ")}`, "info");
					} else {
						ctx.ui.notify("No wave projects and no SPEC.md in current dir. Run /waves-spec <task> first.", "info");
					}
					return;
				}
			} else {
				// Parse: first word is project name, rest is extra instructions
				const parts = args.trim().split(/\s+/);
				projectName = slugify(parts[0]);
				extraInstructions = parts.slice(1).join(" ");
			}

			const spec = specPath(ctx.cwd, projectName);
			if (!fs.existsSync(spec)) {
				ctx.ui.notify(`No SPEC.md found for "${projectName}". Run /waves-spec <task> first.`, "error");
				return;
			}

			const extra = extraInstructions ? `\n\nAdditional instructions: ${extraInstructions}` : "";

			ctx.ui.setStatus("waves", ctx.ui.theme.fg("warning", `📋 [${projectName}] Planning...`));
			ensureProjectDir(ctx.cwd, projectName);
			const file = planPath(ctx.cwd, projectName);
			const relSpec = path.relative(ctx.cwd, spec);
			const relPlan = path.relative(ctx.cwd, file);

			const planTask = `Read the spec at \`${relSpec}\` and create a wave-based implementation plan.${extra}

IMPORTANT: Write the plan directly to the file \`${relPlan}\`.
Use the read tool to read the spec file first, then use the write tool to create the plan file.
You can read it back to verify the format is correct.`;

			const planResult = await runSubagent("wave-planner", planTask, ctx.cwd, undefined, {
				allowWrite: [file],
				safeBashOnly: true,
			});

			ctx.ui.setStatus("waves", undefined);

			if (planResult.exitCode !== 0) {
				ctx.ui.notify("Planner failed: " + (planResult.stderr || "no output"), "error");
				return;
			}

			if (!fs.existsSync(file)) {
				ctx.ui.notify("Planner did not create PLAN.md", "error");
				return;
			}

			const planContent = fs.readFileSync(file, "utf-8");

			// Parse to show summary
			const plan = parsePlan(planContent);
			const totalTasks = plan.waves.reduce((s, w) => s + w.tasks.length, 0);

			let summary = `📋 **${projectName}/PLAN.md** created → \`${relPlan}\`\n\n`;
			summary += `**${plan.waves.length} waves, ${totalTasks} tasks**\n\n`;
			for (const wave of plan.waves) {
				const testCount = wave.tasks.filter((t) => t.agent === "test-writer").length;
				const implCount = wave.tasks.filter((t) => t.agent === "worker").length;
				const verifyCount = wave.tasks.filter((t) => t.agent === "wave-verifier").length;
				const parts2: string[] = [];
				if (testCount) parts2.push(`🧪 ${testCount} test`);
				if (implCount) parts2.push(`🔨 ${implCount} impl`);
				if (verifyCount) parts2.push(`🔍 ${verifyCount} verify`);
				summary += `- **${wave.name}**: ${parts2.join(", ")} — ${wave.description}\n`;
			}
			summary += `\nReview and edit, then run \`/waves-execute ${projectName}\``;

			pi.sendMessage(
				{ customType: "wave-plan", content: summary, display: true },
				{ triggerTurn: false },
			);

			ctx.ui.notify(`PLAN.md → ${relPlan} — ${plan.waves.length} waves, ${totalTasks} tasks. Next: /waves-execute ${projectName}`, "info");
		},
	});

	// ── /execute ─────────────────────────────────────────────────────

	pi.registerCommand("waves-execute", {
		description: "Execute a wave project's PLAN.md (e.g. /waves-execute add-oauth2-support)",
		handler: async (args, ctx) => {
			if (!args?.trim()) {
				const projects = listWaveProjects(ctx.cwd);
				const ready = projects.filter((p) =>
					fs.existsSync(specPath(ctx.cwd, p)) && fs.existsSync(planPath(ctx.cwd, p))
				);
				if (ready.length > 0) {
					ctx.ui.notify(`Usage: /execute <name>\nReady to execute: ${ready.join(", ")}`, "info");
				} else {
					ctx.ui.notify("No projects ready. Run /waves-spec then /waves-plan first.", "info");
				}
				return;
			}

			const projectName = slugify(args.trim());
			const spec = specPath(ctx.cwd, projectName);
			const planFile = planPath(ctx.cwd, projectName);

			if (!fs.existsSync(spec)) {
				ctx.ui.notify(`No SPEC.md for "${projectName}". Run /waves-spec <task> first.`, "error");
				return;
			}
			if (!fs.existsSync(planFile)) {
				ctx.ui.notify(`No PLAN.md for "${projectName}". Run /waves-plan ${projectName} first.`, "error");
				return;
			}

			const specContent = fs.readFileSync(spec, "utf-8");
			const planContent = fs.readFileSync(planFile, "utf-8");
			const plan = parsePlan(planContent);

			if (plan.waves.length === 0) {
				ctx.ui.notify("PLAN.md has no waves. Check the format or run /plan again.", "error");
				return;
			}

			const totalTasks = plan.waves.reduce((s, w) => s + w.tasks.length, 0);

			// Show summary and confirm
			const testTasks = plan.waves.reduce((s, w) => s + w.tasks.filter((t) => t.agent === "test-writer").length, 0);
			const implTasks = plan.waves.reduce((s, w) => s + w.tasks.filter((t) => t.agent === "worker").length, 0);
			const verifyTasks = plan.waves.reduce((s, w) => s + w.tasks.filter((t) => t.agent === "wave-verifier").length, 0);

			let preview = `**${plan.goal || "Implementation"}**\n`;
			preview += `${plan.waves.length} waves, ${totalTasks} tasks (🧪 ${testTasks} test, 🔨 ${implTasks} impl, 🔍 ${verifyTasks} verify)\n`;
			preview += `Up to ${MAX_CONCURRENCY} parallel agents per wave\n\n`;
			for (const wave of plan.waves) {
				const tc = wave.tasks.filter((t) => t.agent === "test-writer").length;
				const ic = wave.tasks.filter((t) => t.agent === "worker").length;
				const vc = wave.tasks.filter((t) => t.agent === "wave-verifier").length;
				const parts: string[] = [];
				if (tc) parts.push(`🧪${tc}`);
				if (ic) parts.push(`🔨${ic}`);
				if (vc) parts.push(`🔍${vc}`);
				preview += `• ${wave.name}: ${parts.join(" ")}\n`;
			}

			const ok = await ctx.ui.confirm("Execute wave plan?", preview);
			if (!ok) {
				ctx.ui.notify("Execution cancelled.", "info");
				return;
			}

			const controller = new AbortController();
			const waveResults: WaveResult[] = [];
			let allPassed = true;
			let totalCompleted = 0;

			// Write execution log
			const logPath = logFilePath(ctx.cwd, projectName);
			const logLines: string[] = [
				`# Execution Log`,
				``,
				`Started: ${new Date().toISOString()}`,
				`Spec: SPEC.md`,
				`Plan: PLAN.md`,
				``,
			];
			const writeLog = () => fs.writeFileSync(logPath, logLines.join("\n"), "utf-8");

			for (let wi = 0; wi < plan.waves.length; wi++) {
				const wave = plan.waves[wi];
				const waveLabel = `Wave ${wi + 1}/${plan.waves.length}: ${wave.name}`;

				ctx.ui.setStatus("waves", ctx.ui.theme.fg("accent", `⚡ ${waveLabel}`));
				logLines.push(`## ${waveLabel}`, "");

				// Progress widget
				let completed = 0;
				const taskStatuses: ("pending" | "running" | "done" | "failed")[] =
					wave.tasks.map(() => "pending");

				const updateWidget = () => {
					const lines = [
						ctx.ui.theme.fg("accent", `⚡ ${waveLabel} — ${completed}/${wave.tasks.length} done`),
					];
					for (let i = 0; i < wave.tasks.length; i++) {
						const t = wave.tasks[i];
						const status = taskStatuses[i];
						const icon =
							status === "done" ? ctx.ui.theme.fg("success", "✓") :
							status === "failed" ? ctx.ui.theme.fg("error", "✗") :
							status === "running" ? ctx.ui.theme.fg("warning", "⏳") :
							ctx.ui.theme.fg("muted", "○");
						const agentTag = t.agent === "test-writer" ? " 🧪" : t.agent === "wave-verifier" ? " 🔍" : " 🔨";
						lines.push(`${icon}${agentTag} ${t.id}: ${t.title}`);
					}
					// Overall progress
					const overallDone = totalCompleted + completed;
					lines.push("");
					lines.push(ctx.ui.theme.fg("dim", `Overall: ${overallDone}/${totalTasks} tasks`));
					ctx.ui.setWidget("wave-progress", lines);
				};

				updateWidget();

				// Execute tasks in parallel, routing to correct agent
				const taskResults = await mapConcurrent(wave.tasks, MAX_CONCURRENCY, async (task, i) => {
					taskStatuses[i] = "running";
					updateWidget();

					const agentName = task.agent || "worker";
					let agentTask: string;

					if (agentName === "test-writer") {
						// Test-writer: gets spec context + behavior to test
						agentTask = `You are writing tests as part of a TDD implementation plan.

## Spec Reference
${specContent.slice(0, 2000)}

## Your Task
**${task.id}: ${task.title}**
Files to create/modify: ${task.files.join(", ")}
Spec refs: ${task.specRefs.join(", ")}

${task.description}

IMPORTANT:
- Only create/modify TEST files listed for this task
- Tests should FAIL right now (implementation doesn't exist yet)
- Tests define the expected behavior — they are the contract
- Follow existing test patterns in the project
- Do not touch implementation files`;
					} else if (agentName === "wave-verifier") {
						// Verifier: runs tests and checks
						agentTask = `You are verifying a wave of completed work.

## Spec Reference
${specContent.slice(0, 2000)}

## Your Task
**${task.id}: ${task.title}**
Files to check: ${task.files.join(", ")}
Spec refs: ${task.specRefs.join(", ")}

${task.description}

IMPORTANT:
- Run the test suite and report results
- Check for type errors, lint issues
- Do NOT modify any files — only read and run checks`;
					} else {
						// Worker: gets spec + task + test file references
						const testContext = task.testFiles.length > 0
							? `\nTests to satisfy: ${task.testFiles.join(", ")}\nYour implementation MUST make these tests pass.`
							: "";
						agentTask = `You are implementing code as part of a TDD plan. Tests have already been written — your job is to make them pass.

## Spec Reference
${specContent.slice(0, 2000)}

## Your Task
**${task.id}: ${task.title}**
Files: ${task.files.join(", ")}
Spec refs: ${task.specRefs.join(", ")}${testContext}

${task.description}

IMPORTANT:
- Only modify the IMPLEMENTATION files listed for this task
- Do NOT modify test files
- Your code must make the existing tests pass
- Follow the spec requirements exactly
- Do not touch files outside your task scope`;
					}

					// Build file access rules based on agent type
					// SPEC.md and PLAN.md are always protected during execution
					const protectedDocs = [spec, planFile];
					let fileRules: FileAccessRules | undefined;

					if (agentName === "test-writer") {
						// Test writers can ONLY write test files listed in their task
						fileRules = {
							allowWrite: [...task.files],
							protectedPaths: protectedDocs,
							safeBashOnly: true,
						};
					} else if (agentName === "wave-verifier") {
						// Verifiers are fully read-only
						fileRules = {
							readOnly: true,
							protectedPaths: protectedDocs,
							safeBashOnly: false, // needs to run test commands
						};
					} else {
						// Workers can only write their listed implementation files, NOT test files
						const blocked = task.testFiles || [];
						fileRules = {
							allowWrite: task.files.filter((f) => !blocked.some((b) => f === b)),
							protectedPaths: protectedDocs,
						};
					}

					const result = await runSubagent(agentName, agentTask, ctx.cwd, controller.signal, fileRules);
					const output = extractFinalOutput(result.stdout);

					const taskResult: TaskResult = {
						id: task.id,
						title: task.title,
						exitCode: result.exitCode,
						output: output || "(no output)",
						stderr: result.stderr,
					};

					taskStatuses[i] = result.exitCode === 0 ? "done" : "failed";
					completed++;
					updateWidget();

					// Log
					const logIcon = result.exitCode === 0 ? "✅" : "❌";
					const agentEmoji = agentName === "test-writer" ? "🧪" : agentName === "wave-verifier" ? "🔍" : "🔨";
					logLines.push(`${logIcon} ${agentEmoji} **${task.id}** [${agentName}]: ${task.title}`);
					if (result.exitCode !== 0) {
						logLines.push(`   Error: ${result.stderr.slice(0, 200)}`);
					}

					return taskResult;
				});

				totalCompleted += completed;

				// Report task failures
				const failedTasks = taskResults.filter((r) => r.exitCode !== 0);
				if (failedTasks.length > 0) {
					const failMsg = failedTasks.map((t) => `  - ${t.id}: ${t.title}`).join("\n");
					pi.sendMessage(
						{
							customType: "wave-task-failures",
							content: `⚠️ **${wave.name}**: ${failedTasks.length}/${wave.tasks.length} tasks failed:\n${failMsg}`,
							display: true,
						},
						{ triggerTurn: false },
					);
				}

				// Verify wave
				ctx.ui.setStatus("waves", ctx.ui.theme.fg("warning", `🔍 Verifying ${wave.name}...`));

				const taskSummaries = taskResults.map((r) => {
					const status = r.exitCode === 0 ? "completed" : "FAILED";
					return `- ${r.id} (${r.title}): ${status}\n  Output: ${r.output.slice(0, 500)}`;
				}).join("\n");

				const verifyTask = `Verify wave completion.

Goal: ${plan.goal}
Wave: ${wave.name} — ${wave.description}

Tasks:
${wave.tasks.map((t) => `- ${t.id}: ${t.title} (files: ${t.files.join(", ")})`).join("\n")}

Results:
${taskSummaries}

Spec excerpt:
${specContent.slice(0, 1500)}`;

				const verifyResult = await runSubagent("wave-verifier", verifyTask, ctx.cwd, controller.signal, { readOnly: true, protectedPaths: [spec, planFile] });
				const verifyOutput = extractFinalOutput(verifyResult.stdout);

				let passed = true;
				try {
					const jsonMatch = verifyOutput.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, verifyOutput];
					const verification = JSON.parse(jsonMatch[1]!.trim());
					passed = verification.readyForNextWave === true || verification.status === "pass";
				} catch {
					passed = !verifyOutput.toLowerCase().includes('"status": "fail"') &&
					         !verifyOutput.toLowerCase().includes('"readyfornextwave": false');
				}

				logLines.push("", `### Verification: ${passed ? "PASSED ✅" : "FAILED ❌"}`, "");

				waveResults.push({
					wave: wave.name,
					taskResults,
					verificationPassed: passed,
					verificationOutput: verifyOutput,
				});

				if (!passed) {
					pi.sendMessage(
						{
							customType: "wave-verify-fail",
							content: `❌ **${wave.name}** verification failed.\n\n${verifyOutput.slice(0, 1000)}`,
							display: true,
						},
						{ triggerTurn: false },
					);

					// Retry: fix issues
					if (MAX_RETRIES_PER_WAVE > 0) {
						ctx.ui.setStatus("waves", ctx.ui.theme.fg("warning", `🔧 Fixing ${wave.name}...`));
						const fixTask = `Fix the issues found during verification of ${wave.name}:\n\n${verifyOutput}\n\nSpec:\n${specContent.slice(0, 1500)}`;
						// Fix worker gets write access to all files in this wave
						const waveFiles = wave.tasks.flatMap((t) => t.files);
						await runSubagent("worker", fixTask, ctx.cwd, controller.signal, { allowWrite: waveFiles });

						// Re-verify
						const reVerify = await runSubagent("wave-verifier", verifyTask, ctx.cwd, controller.signal, { readOnly: true });
						const reOutput = extractFinalOutput(reVerify.stdout);
						let rePassed = true;
						try {
							const m = reOutput.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, reOutput];
							const v = JSON.parse(m[1]!.trim());
							rePassed = v.readyForNextWave === true || v.status === "pass";
						} catch {
							rePassed = !reOutput.toLowerCase().includes('"status": "fail"');
						}

						if (rePassed) {
							logLines.push("Fix applied, re-verification: PASSED ✅", "");
							pi.sendMessage(
								{ customType: "wave-fixed", content: `✅ **${wave.name}** fixed and verified.`, display: true },
								{ triggerTurn: false },
							);
						} else {
							allPassed = false;
							logLines.push("Fix attempted, re-verification: STILL FAILED ❌", "");
							pi.sendMessage(
								{
									customType: "wave-fix-failed",
									content: `❌ **${wave.name}** still failing after fix attempt. Continuing...`,
									display: true,
								},
								{ triggerTurn: false },
							);
						}
					} else {
						allPassed = false;
					}
				} else {
					const passCount = taskResults.filter((r) => r.exitCode === 0).length;
					pi.sendMessage(
						{
							customType: "wave-pass",
							content: `✅ **${wave.name}** — ${passCount}/${wave.tasks.length} tasks passed verification`,
							display: true,
						},
						{ triggerTurn: false },
					);
				}

				writeLog();
			}

			// Final summary
			ctx.ui.setWidget("wave-progress", undefined);

			logLines.push("---", "", `Finished: ${new Date().toISOString()}`);
			logLines.push(`Result: ${allPassed ? "SUCCESS" : "COMPLETED WITH ISSUES"}`);
			writeLog();

			const icon = allPassed ? "✅" : "⚠️";
			let finalSummary = `# ${icon} Execution Complete\n\n`;
			finalSummary += `**Goal:** ${plan.goal}\n`;
			finalSummary += `**Tasks:** ${totalCompleted}/${totalTasks}\n`;
			finalSummary += `**Waves:** ${waveResults.length}/${plan.waves.length}\n\n`;

			for (const wr of waveResults) {
				const passed = wr.taskResults.filter((r) => r.exitCode === 0).length;
				const wIcon = wr.verificationPassed ? "✅" : "❌";
				finalSummary += `${wIcon} **${wr.wave}**: ${passed}/${wr.taskResults.length} tasks\n`;
			}

			finalSummary += `\n📄 Execution log: \`${path.relative(ctx.cwd, logPath)}\``;

			pi.sendMessage(
				{ customType: "wave-complete", content: finalSummary, display: true },
				{ triggerTurn: false },
			);

			ctx.ui.setStatus("waves", allPassed
				? ctx.ui.theme.fg("success", `✅ Done — ${totalCompleted} tasks`)
				: ctx.ui.theme.fg("warning", `⚠️ Done (issues) — ${totalCompleted} tasks`),
			);
			setTimeout(() => ctx.ui.setStatus("waves", undefined), 15000);
		},
	});
}
