/**
 * Wave Executor Extension
 *
 * Three-phase workflow with reviewable files:
 *
 *   /spec <task>    — Scout + brainstorm → creates SPEC.md
 *   /plan           — Reads SPEC.md → creates PLAN.md (wave-based tasks)
 *   /execute        — Reads SPEC.md + PLAN.md → wave-executes with verification
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
			summary += `\nCommands: \`/spec <task>\`, \`/plan <name>\`, \`/execute <name>\``;

			pi.sendMessage(
				{ customType: "wave-list", content: summary, display: true },
				{ triggerTurn: false },
			);
		},
	});

	// ── /spec ────────────────────────────────────────────────────────

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

	interface ScopeConfig {
		emoji: string;
		label: string;
		specAgent: string;
		scoutDepth: string;
		interviewRounds: { questions: InterviewQuestion[] }[];
	}

	interface InterviewQuestion {
		id: string;
		prompt: string;
		options: { label: string; description?: string }[];
		allowCustom: boolean;
		condition?: (answers: Map<string, string>) => boolean;
	}

	function buildInterviewRounds(scope: Scope, scoutContext: string): { questions: InterviewQuestion[] }[] {
		if (scope === "hack") {
			return [{
				questions: [
					{
						id: "approach",
						prompt: "Which approach do you prefer?",
						options: [
							{ label: "Quickest path — minimal changes", description: "Just get it working" },
							{ label: "Slightly cleaner — basic structure", description: "A bit more thought, still fast" },
						],
						allowCustom: true,
					},
				],
			}];
		}

		if (scope === "standard") {
			return [
				{
					questions: [
						{
							id: "goal",
							prompt: "What's the main goal? (pick closest or type your own)",
							options: [
								{ label: "Add a new feature" },
								{ label: "Refactor / improve existing code" },
								{ label: "Fix a bug or issue" },
								{ label: "Performance improvement" },
							],
							allowCustom: true,
						},
						{
							id: "scope",
							prompt: "How far should this go?",
							options: [
								{ label: "Minimal — just the core change", description: "No extras" },
								{ label: "Moderate — include related cleanups", description: "Fix things along the way" },
								{ label: "Thorough — update tests, docs, related code", description: "Do it properly" },
							],
							allowCustom: false,
						},
					],
				},
				{
					questions: [
						{
							id: "patterns",
							prompt: "Any specific patterns or conventions to follow?",
							options: [
								{ label: "Follow existing patterns in the codebase" },
								{ label: "I have specific preferences (I'll type them)" },
								{ label: "No preference — use best judgment" },
							],
							allowCustom: true,
						},
						{
							id: "testing",
							prompt: "Testing approach?",
							options: [
								{ label: "Match existing test patterns" },
								{ label: "Add comprehensive tests" },
								{ label: "Minimal tests — just critical paths" },
								{ label: "No tests needed" },
							],
							allowCustom: false,
						},
					],
				},
			];
		}

		// enterprise
		return [
			{
				questions: [
					{
						id: "problem",
						prompt: "What problem does this solve? (describe in your own words or pick)",
						options: [
							{ label: "New capability the system doesn't have" },
							{ label: "Replacing/upgrading an existing solution" },
							{ label: "Addressing technical debt or scalability" },
							{ label: "Security or compliance requirement" },
						],
						allowCustom: true,
					},
					{
						id: "users",
						prompt: "Who are the users/consumers?",
						options: [
							{ label: "End users (via UI)" },
							{ label: "Other developers (via API)" },
							{ label: "Internal systems (via integration)" },
							{ label: "All of the above" },
						],
						allowCustom: true,
					},
				],
			},
			{
				questions: [
					{
						id: "scale",
						prompt: "Expected scale/load?",
						options: [
							{ label: "Low — internal tool, handful of users" },
							{ label: "Medium — production, moderate traffic" },
							{ label: "High — high throughput, latency-sensitive" },
							{ label: "Not applicable" },
						],
						allowCustom: false,
					},
					{
						id: "constraints",
						prompt: "Any hard constraints?",
						options: [
							{ label: "Must be backward compatible" },
							{ label: "Specific deadline or release target" },
							{ label: "Must work with specific dependencies/versions" },
							{ label: "No major constraints" },
						],
						allowCustom: true,
					},
				],
			},
			{
				questions: [
					{
						id: "security",
						prompt: "Security considerations?",
						options: [
							{ label: "Auth/authorization changes needed" },
							{ label: "Input validation / data sanitization" },
							{ label: "Data exposure / privacy concerns" },
							{ label: "Standard security practices sufficient" },
							{ label: "Not security-relevant" },
						],
						allowCustom: true,
					},
					{
						id: "testing",
						prompt: "Testing strategy?",
						options: [
							{ label: "Full TDD — unit + integration + E2E" },
							{ label: "Unit + integration tests" },
							{ label: "Match existing test coverage patterns" },
						],
						allowCustom: true,
					},
				],
			},
			{
				questions: [
					{
						id: "compatibility",
						prompt: "Backward compatibility / migration?",
						options: [
							{ label: "Must be fully backward compatible" },
							{ label: "Breaking changes OK with migration path" },
							{ label: "Greenfield — no compatibility concerns" },
						],
						allowCustom: true,
					},
					{
						id: "observability",
						prompt: "Logging / observability needs?",
						options: [
							{ label: "Add structured logging for key operations" },
							{ label: "Match existing logging patterns" },
							{ label: "Minimal — errors only" },
							{ label: "Not needed" },
						],
						allowCustom: false,
					},
				],
			},
		];
	}

	async function runInterview(
		ctx: ExtensionContext,
		scope: Scope,
		scoutContext: string,
	): Promise<Map<string, string> | null> {
		const answers = new Map<string, string>();
		const rounds = buildInterviewRounds(scope, scoutContext);

		for (let ri = 0; ri < rounds.length; ri++) {
			const round = rounds[ri];
			const questions = round.questions.filter((q) => !q.condition || q.condition(answers));
			if (questions.length === 0) continue;

			for (const question of questions) {
				const options = question.options.map((o) => o.label);
				if (question.allowCustom) options.push("Let me type my own answer...");

				const choice = await ctx.ui.select(question.prompt, options);
				if (choice === undefined) return null; // cancelled

				if (choice === "Let me type my own answer...") {
					const custom = await ctx.ui.input(question.prompt);
					if (custom === undefined) return null;
					answers.set(question.id, custom || "(no answer)");
				} else {
					answers.set(question.id, choice);
				}
			}
		}

		// Enterprise: final confirmation
		if (scope === "enterprise" && answers.size > 0) {
			let summary = "Here's what I gathered:\n\n";
			for (const [id, answer] of answers) {
				summary += `• **${id}**: ${answer}\n`;
			}
			const ok = await ctx.ui.confirm("Does this capture everything?", summary);
			if (!ok) {
				const extra = await ctx.ui.input("What's missing or needs clarification?");
				if (extra) answers.set("additional_notes", extra);
			}
		}

		return answers;
	}

	pi.registerCommand("spec", {
		description: "Create a spec: /spec [hack|standard|enterprise] <task> (default: standard)",
		handler: async (args, ctx) => {
			const parsed = parseSpecArgs(args || "");
			if (!parsed) {
				ctx.ui.notify(
					"Usage: /spec [scope] <task>\n\n" +
					"Scopes:\n" +
					"  hack        — quick & dirty, 1-2 questions, minimal spec\n" +
					"  standard    — balanced, 3-6 questions, solid requirements (default)\n" +
					"  enterprise  — thorough, multi-round interview, full E2E coverage\n\n" +
					"Examples:\n" +
					"  /spec hack add a debug flag\n" +
					"  /spec add OAuth2 support\n" +
					"  /spec enterprise redesign the auth module",
					"info",
				);
				return;
			}

			const { scope, query } = parsed;
			const scopeEmoji = scope === "hack" ? "⚡" : scope === "enterprise" ? "🏢" : "📋";
			const specAgent = `spec-writer-${scope}`;
			const projectName = slugify(query);
			ensureProjectDir(ctx.cwd, projectName);

			// Phase 1: Scout
			ctx.ui.setStatus("waves", ctx.ui.theme.fg("warning", `🔍 [${projectName}] Scouting...`));
			const scoutDepth = scope === "hack" ? "Quick" : scope === "enterprise" ? "Thorough" : "Medium";
			const scoutResult = await runSubagent("scout", `${scoutDepth} investigation: ${query}`, ctx.cwd, undefined, { readOnly: true, safeBashOnly: true });
			const scoutOutput = extractFinalOutput(scoutResult.stdout);

			if (scoutResult.exitCode !== 0 || !scoutOutput) {
				ctx.ui.setStatus("waves", undefined);
				ctx.ui.notify("Scout failed: " + (scoutResult.stderr || "no output"), "error");
				return;
			}
			ctx.ui.setStatus("waves", undefined);

			// Phase 2: Interactive interview (runs in main process with full UI)
			ctx.ui.notify(`${scopeEmoji} Starting ${scope} interview...`, "info");
			const answers = await runInterview(ctx, scope, scoutOutput);

			if (!answers) {
				ctx.ui.notify("Interview cancelled.", "info");
				return;
			}

			// Format answers for spec writer
			let interviewSection = "";
			if (answers.size > 0) {
				interviewSection = "\n\nUser interview answers:\n";
				for (const [id, answer] of answers) {
					interviewSection += `- ${id}: ${answer}\n`;
				}
			}

			// Phase 3: Write spec (non-interactive sub-agent, gets scout context + interview answers)
			ctx.ui.setStatus("waves", ctx.ui.theme.fg("warning", `${scopeEmoji} [${projectName}] Writing SPEC.md (${scope})...`));
			const file = specPath(ctx.cwd, projectName);
			const relFile = path.relative(ctx.cwd, file);

			const specTask = `Scope level: ${scope.toUpperCase()}
Task: "${query}"

Codebase context from scout:
${scoutOutput}
${interviewSection}
IMPORTANT: Write the specification directly to the file \`${relFile}\`.
Use the write tool to create the file. You can read it back to verify.`;

			const specResult = await runSubagent(specAgent, specTask, ctx.cwd, undefined, {
				allowWrite: [file],
				safeBashOnly: scope !== "enterprise",
			});

			ctx.ui.setStatus("waves", undefined);

			if (specResult.exitCode !== 0) {
				ctx.ui.notify("Spec writer failed: " + (specResult.stderr || "no output"), "error");
				return;
			}

			if (!fs.existsSync(file)) {
				ctx.ui.notify("Spec writer did not create SPEC.md", "error");
				return;
			}

			const specContent = fs.readFileSync(file, "utf-8");
			pi.sendMessage(
				{
					customType: "wave-spec",
					content: `${scopeEmoji} **${projectName}/SPEC.md** [${scope}] → \`${relFile}\`\n\nReview and edit the spec, then run \`/plan ${projectName}\` to create the implementation plan.\n\n---\n\n${specContent.slice(0, 3000)}${specContent.length > 3000 ? "\n\n*(truncated — see full file)*" : ""}`,
					display: true,
				},
				{ triggerTurn: false },
			);

			ctx.ui.notify(`SPEC.md → ${relFile}. Next: /plan ${projectName}`, "info");
		},
	});

	// ── /plan ────────────────────────────────────────────────────────

	pi.registerCommand("plan", {
		description: "Create PLAN.md for a wave project (e.g. /plan add-oauth2-support)",
		handler: async (args, ctx) => {
			if (!args?.trim()) {
				// List projects that have a spec but no plan yet
				const projects = listWaveProjects(ctx.cwd);
				const ready = projects.filter((p) =>
					fs.existsSync(specPath(ctx.cwd, p)) && !fs.existsSync(planPath(ctx.cwd, p))
				);
				if (ready.length > 0) {
					ctx.ui.notify(`Usage: /plan <name>\nReady for planning: ${ready.join(", ")}`, "info");
				} else if (projects.length > 0) {
					ctx.ui.notify(`Usage: /plan <name> [extra instructions]\nProjects: ${projects.join(", ")}`, "info");
				} else {
					ctx.ui.notify("No wave projects. Run /spec <task> first.", "info");
				}
				return;
			}

			// Parse: first word is project name, rest is extra instructions
			const parts = args.trim().split(/\s+/);
			const projectName = slugify(parts[0]);
			const extraInstructions = parts.slice(1).join(" ");

			const spec = specPath(ctx.cwd, projectName);
			if (!fs.existsSync(spec)) {
				ctx.ui.notify(`No SPEC.md found for "${projectName}". Run /spec <task> first.`, "error");
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
			summary += `\nReview and edit, then run \`/execute ${projectName}\``;

			pi.sendMessage(
				{ customType: "wave-plan", content: summary, display: true },
				{ triggerTurn: false },
			);

			ctx.ui.notify(`PLAN.md → ${relPlan} — ${plan.waves.length} waves, ${totalTasks} tasks. Next: /execute ${projectName}`, "info");
		},
	});

	// ── /execute ─────────────────────────────────────────────────────

	pi.registerCommand("execute", {
		description: "Execute a wave project's PLAN.md (e.g. /execute add-oauth2-support)",
		handler: async (args, ctx) => {
			if (!args?.trim()) {
				const projects = listWaveProjects(ctx.cwd);
				const ready = projects.filter((p) =>
					fs.existsSync(specPath(ctx.cwd, p)) && fs.existsSync(planPath(ctx.cwd, p))
				);
				if (ready.length > 0) {
					ctx.ui.notify(`Usage: /execute <name>\nReady to execute: ${ready.join(", ")}`, "info");
				} else {
					ctx.ui.notify("No projects ready. Run /spec then /plan first.", "info");
				}
				return;
			}

			const projectName = slugify(args.trim());
			const spec = specPath(ctx.cwd, projectName);
			const planFile = planPath(ctx.cwd, projectName);

			if (!fs.existsSync(spec)) {
				ctx.ui.notify(`No SPEC.md for "${projectName}". Run /spec <task> first.`, "error");
				return;
			}
			if (!fs.existsSync(planFile)) {
				ctx.ui.notify(`No PLAN.md for "${projectName}". Run /plan ${projectName} first.`, "error");
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
