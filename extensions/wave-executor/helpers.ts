/**
 * Shared helpers extracted from the wave executor.
 *
 * Pure utility functions: spec parsing, file paths, subagent runner,
 * file access enforcement.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { FileAccessRules } from "./types.js";

// ── Spec Helpers ───────────────────────────────────────────────────

/**
 * Extract relevant sections from the spec based on spec refs (e.g., "FR-ISSUE-1", "NFR-3").
 * Falls back to full spec (truncated) if no refs match.
 */
export function extractSpecSections(specContent: string, specRefs: string[]): string {
	if (!specRefs || specRefs.length === 0) {
		return specContent.slice(0, 6000);
	}

	const sections: string[] = [];
	const lines = specContent.split("\n");

	// Extract sections by heading level 2/3
	const sectionMap: { heading: string; content: string }[] = [];
	let currentHeading = "";
	let currentLines: string[] = [];

	for (const line of lines) {
		if (line.match(/^#{1,3}\s/)) {
			if (currentHeading) {
				sectionMap.push({ heading: currentHeading, content: currentLines.join("\n") });
			}
			currentHeading = line;
			currentLines = [line];
		} else {
			currentLines.push(line);
		}
	}
	if (currentHeading) {
		sectionMap.push({ heading: currentHeading, content: currentLines.join("\n") });
	}

	// Always include Overview, Data Model, and User Decisions
	const alwaysInclude = ["overview", "data model", "user decisions", "api / interface", "error handling"];
	for (const section of sectionMap) {
		const lower = section.heading.toLowerCase();
		if (alwaysInclude.some((k) => lower.includes(k))) {
			sections.push(section.content);
		}
	}

	// Include sections that contain any of the spec refs
	for (const section of sectionMap) {
		if (sections.includes(section.content)) continue;
		for (const ref of specRefs) {
			if (section.content.includes(ref)) {
				sections.push(section.content);
				break;
			}
		}
	}

	const result = sections.join("\n\n");
	return result.length > 200 ? result.slice(0, 12000) : specContent.slice(0, 6000);
}

/**
 * Extract the final assistant text from JSON-mode pi output.
 */
export function extractFinalOutput(jsonLines: string): string {
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
		} catch {
			/* skip */
		}
	}
	return lastText;
}

// ── Path Helpers ───────────────────────────────────────────────────

export function slugify(text: string): string {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 60);
}

/**
 * Derive a clean project slug from a filename or user input.
 * Strips: file extensions, "spec"/"plan"/"execution" labels, timestamps.
 */
export function projectSlug(input: string): string {
	let name = path.basename(input, path.extname(input)); // strip .md etc.
	name = name
		.replace(/[-_]?(spec|plan|execution)[-_]?/gi, "") // strip labels
		.replace(/[-_]?\d{4}-\d{2}-\d{2}[-_T]?\d{2}[-:]\d{2}([-:]\d{2})?/g, "") // strip timestamps
		.replace(/^-+|-+$/g, ""); // trim leftover dashes
	return slugify(name || input);
}

/**
 * Resolve user input to a known project name.
 *
 * Tries (in order):
 * 1. Exact match against known project directories
 * 2. Slugified exact match
 * 3. Partial match — known project name starts with the input
 * 4. Partial match — input starts with a known project name
 * 5. projectSlug (strips timestamps/labels) against known projects
 *
 * Returns the matching project name, or the slugified input as fallback.
 */
export function resolveProject(cwd: string, input: string): string {
	const projects = listWaveProjects(cwd);
	if (projects.length === 0) return slugify(input);

	// 1. Exact match
	if (projects.includes(input)) return input;

	// 2. Slugified exact match
	const slug = slugify(input);
	if (projects.includes(slug)) return slug;

	// 3. Clean slug (no timestamps/labels)
	const clean = projectSlug(input);
	if (projects.includes(clean)) return clean;

	// 4. Partial: project starts with input
	const startsWith = projects.filter((p) => p.startsWith(slug) || p.startsWith(clean));
	if (startsWith.length === 1) return startsWith[0];

	// 5. Partial: input starts with project name (user typed too much)
	const prefixOf = projects.filter((p) => slug.startsWith(p) || clean.startsWith(p));
	if (prefixOf.length === 1) return prefixOf[0];

	// 6. Substring match
	const contains = projects.filter((p) => p.includes(clean) || clean.includes(p));
	if (contains.length === 1) return contains[0];

	return slug; // fallback
}

function specDir(cwd: string): string {
	return path.join(cwd, "docs", "spec");
}

function planDir(cwd: string): string {
	return path.join(cwd, "docs", "plan");
}

export function waveProjectDir(cwd: string, name: string): string {
	// Used only for checking file presence — returns the plan dir for the project
	return path.join(planDir(cwd), name);
}

// ── Timestamp helper ───────────────────────────────────────────────

function timestamp(): string {
	const d = new Date();
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}`;
}

// ── Write paths (create new files with descriptive names) ──────────

export function specPath(cwd: string, name: string): string {
	return path.join(specDir(cwd), name, `${name}-spec-${timestamp()}.md`);
}

export function planPath(cwd: string, name: string): string {
	return path.join(planDir(cwd), name, `${name}-plan-${timestamp()}.md`);
}

export function logFilePath(cwd: string, name: string): string {
	return path.join(planDir(cwd), name, `${name}-execution-${timestamp()}.md`);
}

// ── Find paths (locate existing files flexibly) ────────────────────

/**
 * Find any .md file in a directory, preferring the most recent one.
 * Returns null if the directory doesn't exist or has no .md files.
 */
function findMdInDir(dir: string): string | null {
	if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return null;
	const mds = fs.readdirSync(dir)
		.filter((f) => f.endsWith(".md"))
		.sort()
		.reverse(); // latest timestamp sorts last alphabetically → reverse for most recent
	return mds.length > 0 ? path.join(dir, mds[0]) : null;
}

/**
 * Find a spec file flexibly. Checks (in order):
 * 1. Exact file path (absolute or relative to cwd)
 * 2. Any .md in docs/spec/<name>/ (most recent)
 * 3. docs/spec/<name>.md (flat file)
 * 4. Legacy: .pi/waves/<name>/SPEC.md
 *
 * Returns the resolved absolute path, or null if nothing found.
 */
export function findSpecFile(cwd: string, nameOrPath: string): string | null {
	// 1. Exact path (absolute, or relative to cwd)
	const asPath = path.resolve(cwd, nameOrPath);
	if (fs.existsSync(asPath) && fs.statSync(asPath).isFile()) {
		return asPath;
	}

	const name = slugify(nameOrPath);

	// 2. Any .md in docs/spec/<name>/
	const fromDir = findMdInDir(path.join(specDir(cwd), name));
	if (fromDir) return fromDir;

	// 3. Flat file: docs/spec/<name>.md
	const flat = path.join(specDir(cwd), `${name}.md`);
	if (fs.existsSync(flat)) return flat;

	// 4. Legacy: .pi/waves/<name>/SPEC.md
	const legacy = path.join(cwd, ".pi", "waves", name, "SPEC.md");
	if (fs.existsSync(legacy)) return legacy;

	return null;
}

/**
 * Find a plan file for a project.
 * Searches docs/plan/<name>/ for the most recent *-plan-*.md file,
 * falling back to any .md, then legacy PLAN.md.
 */
export function findPlanFile(cwd: string, nameOrPath: string): string | null {
	const name = slugify(nameOrPath);
	const dir = path.join(planDir(cwd), name);

	if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
		const files = fs.readdirSync(dir).filter((f) => f.endsWith(".md"));
		// Prefer plan files over execution logs
		const plans = files.filter((f) => f.includes("-plan-")).sort().reverse();
		if (plans.length > 0) return path.join(dir, plans[0]);
		// Fall back to any .md that isn't an execution log
		const nonExec = files.filter((f) => !f.includes("-execution-")).sort().reverse();
		if (nonExec.length > 0) return path.join(dir, nonExec[0]);
	}

	// Legacy
	const legacy = path.join(cwd, ".pi", "waves", name, "PLAN.md");
	if (fs.existsSync(legacy)) return legacy;

	return null;
}

export function ensureProjectDir(cwd: string, name: string): void {
	const sd = path.join(specDir(cwd), name);
	const pd = path.join(planDir(cwd), name);
	if (!fs.existsSync(sd)) fs.mkdirSync(sd, { recursive: true });
	if (!fs.existsSync(pd)) fs.mkdirSync(pd, { recursive: true });
}

export function listWaveProjects(cwd: string): string[] {
	const names = new Set<string>();
	for (const dir of [specDir(cwd), planDir(cwd)]) {
		if (!fs.existsSync(dir)) continue;
		for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
			if (d.isDirectory()) names.add(d.name);
		}
	}
	return [...names].sort();
}

/**
 * Extract the spec file reference from a plan's Markdown content.
 * Plans contain a `## Reference` section with `- Spec: \`path\``.
 */
export function extractSpecRef(planContent: string): string | null {
	const match = planContent.match(/[-*]\s*Spec:\s*`([^`]+)`/i);
	return match ? match[1] : null;
}

// ── File Access Enforcement ────────────────────────────────────────

export function generateEnforcementExtension(rules: FileAccessRules, stallSignalPath?: string): string {
	return `
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";

const rules = ${JSON.stringify(rules)};
const stallSignalPath = ${stallSignalPath ? JSON.stringify(stallSignalPath) : "null"};

function matchesPattern(filePath, patterns) {
	const normalized = path.resolve(filePath);
	return patterns.some(p => {
		if (p.includes("*")) {
			const regex = new RegExp("^" + p.replace(/\\\\./g, "\\\\\\\\.").replace(/\\\\*/g, ".*") + "$");
			return regex.test(normalized) || regex.test(path.basename(normalized));
		}
		const resolvedPattern = path.resolve(p);
		return normalized === resolvedPattern || normalized.startsWith(resolvedPattern + path.sep);
	});
}

export default function (pi) {
	pi.on("tool_call", async (event) => {
		// ── Stall interrupt: parent process detected a loop and wrote a signal file ──
		if (stallSignalPath) {
			try {
				const reason = fs.readFileSync(stallSignalPath, "utf-8");
				fs.unlinkSync(stallSignalPath);
				return {
					block: true,
					reason: "⚠️ LOOP DETECTED: " + reason + "\\n\\nYou appear to be stuck in a loop repeating the same actions. "
						+ "STOP and take a completely different approach. "
						+ "If a command keeps failing, try an alternative. "
						+ "If an edit keeps not working, re-read the file first and reconsider your strategy."
				};
			} catch {
				// No signal file — continue normally
			}
		}

		const toolName = event.toolName;
		const filePath = event.input.path || event.input.file_path || "";

		if (rules.protectedPaths && rules.protectedPaths.length > 0 && (toolName === "write" || toolName === "edit")) {
			if (matchesPattern(filePath, rules.protectedPaths)) {
				return { block: true, reason: "BLOCKED: " + filePath + " is a protected document and cannot be modified during execution." };
			}
		}

		if (rules.readOnly && (toolName === "write" || toolName === "edit")) {
			return { block: true, reason: "BLOCKED: This agent is read-only. Cannot " + toolName + " " + filePath };
		}

		if (rules.allowWrite && rules.allowWrite.length > 0 && (toolName === "write" || toolName === "edit")) {
			if (!matchesPattern(filePath, rules.allowWrite)) {
				return {
					block: true,
					reason: "BLOCKED: Not allowed to " + toolName + " " + filePath + ". Allowed files: " + rules.allowWrite.join(", ")
				};
			}
		}

		if (rules.allowRead && rules.allowRead.length > 0 && toolName === "read") {
			if (!matchesPattern(filePath, rules.allowRead)) {
				return {
					block: true,
					reason: "BLOCKED: Not allowed to read " + filePath + ". Allowed files: " + rules.allowRead.join(", ")
				};
			}
		}

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

export function writeEnforcementExtension(
	cwd: string,
	taskId: string,
	rules: FileAccessRules,
	stallSignalPath?: string,
): { filePath: string; dir: string } {
	const dir = path.join(os.tmpdir(), `pi-wave-enforce-${taskId}-${Date.now()}`);
	fs.mkdirSync(dir, { recursive: true });
	const filePath = path.join(dir, "enforce.ts");
	fs.writeFileSync(filePath, generateEnforcementExtension(rules, stallSignalPath), {
		encoding: "utf-8",
		mode: 0o600,
	});
	return { filePath, dir };
}

export function cleanupEnforcement(filePath: string, dir: string): void {
	try {
		fs.unlinkSync(filePath);
	} catch {
		/* ignore */
	}
	try {
		fs.rmdirSync(dir);
	} catch {
		/* ignore */
	}
}

// ── Subagent Runner ────────────────────────────────────────────────

/** Default per-task timeout: 10 minutes */
export const DEFAULT_TASK_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Stall detection thresholds — two levels:
 *
 * Soft: interrupt the agent's next tool call via the enforcement extension
 *       (agent stays alive, gets guidance to change approach)
 * Hard: kill the process (caller retries with enriched context)
 */
export const STALL_SOFT_IDENTICAL_CALLS = 5;
export const STALL_HARD_IDENTICAL_CALLS = 10;
export const STALL_SOFT_CONSECUTIVE_ERRORS = 8;
export const STALL_HARD_CONSECUTIVE_ERRORS = 14;

export interface StallInfo {
	reason: string;
	recentActivity: string[];
}

export interface SubagentResult {
	exitCode: number;
	stdout: string;
	stderr: string;
	timedOut?: boolean;
	stall?: StallInfo;
}

/**
 * Spawn a pi subprocess for the given agent.
 *
 * Looks for agent definitions in:
 * 1. The package's own agents/ directory
 * 2. The global ~/.pi/agent/agents/ directory
 *
 * Monitors the JSON event stream for stall patterns:
 * - Same tool called with identical args N times → stuck in a loop
 * - N consecutive tool errors → unable to make progress
 *
 * Two-level response:
 * 1. Soft interrupt (5 identical / 8 errors): writes a signal file that
 *    the enforcement extension picks up — blocks the next tool call with
 *    guidance to change approach. Agent stays alive.
 * 2. Hard kill (10 identical / 14 errors): kills the process. Caller
 *    retries with enriched context.
 *
 * Also enforces a hard timeout (default: 10 minutes) as a backstop.
 */
export function runSubagent(
	agentName: string,
	task: string,
	cwd: string,
	signal?: AbortSignal,
	fileRules?: FileAccessRules,
	timeoutMs?: number,
): Promise<SubagentResult> {
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

		// Stall signal file — bridge between parent (detector) and child (enforcement extension)
		const stallSignalFile = path.join(os.tmpdir(), `pi-wave-stall-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.signal`);

		// Generate and load file access enforcement extension (with stall signal support)
		let enforcement: { filePath: string; dir: string } | null = null;
		if (fileRules) {
			enforcement = writeEnforcementExtension(
				cwd,
				agentName + "-" + Math.random().toString(36).slice(2, 8),
				fileRules,
				stallSignalFile,
			);
			args.push("-e", enforcement.filePath);
		}

		args.push(`Task: ${task}`);

		let stdout = "";
		let stderr = "";
		let lineBuffer = "";
		let resolved = false;
		let timedOut = false;
		let stall: StallInfo | undefined;

		// ── Stall detection state ──
		let consecutiveErrors = 0;
		let softInterruptSent = false;
		const callCounts = new Map<string, number>();
		const recentActivity: string[] = [];

		function summarizeArgs(toolArgs: any): string {
			if (!toolArgs) return "";
			if (toolArgs.command) return toolArgs.command.slice(0, 120);
			if (toolArgs.path) return toolArgs.path;
			return JSON.stringify(toolArgs).slice(0, 120);
		}

		/**
		 * Check for stall patterns. Returns:
		 * - "soft": write signal file (agent gets interrupted on next tool call)
		 * - "hard": kill the process (caller retries)
		 * - null: no stall
		 */
		function checkStall(event: any): { level: "soft" | "hard"; reason: string } | null {
			if (event.type === "tool_execution_start") {
				const summary = `${event.toolName}(${summarizeArgs(event.args)})`;
				recentActivity.push(summary);
				if (recentActivity.length > 15) recentActivity.shift();

				const key = `${event.toolName}:${JSON.stringify(event.args ?? {})}`;
				const count = (callCounts.get(key) ?? 0) + 1;
				callCounts.set(key, count);

				if (count >= STALL_HARD_IDENTICAL_CALLS) {
					return { level: "hard", reason: `${event.toolName} called ${count} times with identical arguments` };
				}
				if (count >= STALL_SOFT_IDENTICAL_CALLS && !softInterruptSent) {
					return { level: "soft", reason: `${event.toolName} called ${count} times with identical arguments` };
				}
			}

			if (event.type === "tool_execution_end") {
				if (event.isError) {
					consecutiveErrors++;
					if (consecutiveErrors >= STALL_HARD_CONSECUTIVE_ERRORS) {
						return { level: "hard", reason: `${consecutiveErrors} consecutive tool errors` };
					}
					if (consecutiveErrors >= STALL_SOFT_CONSECUTIVE_ERRORS && !softInterruptSent) {
						return { level: "soft", reason: `${consecutiveErrors} consecutive tool errors` };
					}
				} else {
					consecutiveErrors = 0;
				}
			}

			return null;
		}

		// ── Process ──
		const proc = spawn("pi", args, { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });

		const cleanup = () => {
			if (enforcement) cleanupEnforcement(enforcement.filePath, enforcement.dir);
			// Clean up stall signal file
			try { fs.unlinkSync(stallSignalFile); } catch { /* ignore */ }
			clearTimeout(timer);
		};

		proc.stdout.on("data", (data) => {
			const chunk = data.toString();
			stdout += chunk;

			// Parse JSON lines incrementally for stall detection
			lineBuffer += chunk;
			const lines = lineBuffer.split("\n");
			lineBuffer = lines.pop() || "";

			for (const line of lines) {
				if (!line.trim()) continue;
				try {
					const event = JSON.parse(line);
					const stallResult = checkStall(event);
					if (stallResult && !timedOut) {
						if (stallResult.level === "soft" && enforcement) {
							// Soft interrupt: write signal file, enforcement extension blocks next tool call
							softInterruptSent = true;
							try {
								fs.writeFileSync(stallSignalFile, stallResult.reason, "utf-8");
							} catch { /* best effort */ }
						} else if (stallResult.level === "hard" || (stallResult.level === "soft" && !enforcement)) {
							// Hard kill: no enforcement extension or soft interrupt didn't help
							if (!stall) {
								stall = { reason: stallResult.reason, recentActivity: [...recentActivity] };
								killProc();
							}
						}
					}
				} catch {
					/* not JSON, skip */
				}
			}
		});
		proc.stderr.on("data", (data) => {
			stderr += data.toString();
		});

		proc.on("close", (code) => {
			if (resolved) return;
			resolved = true;
			cleanup();
			resolve({
				exitCode: stall ? 125 : timedOut ? 124 : (code ?? 1),
				stdout,
				stderr: timedOut
					? `Task timed out after ${Math.round((timeoutMs ?? DEFAULT_TASK_TIMEOUT_MS) / 1000)}s\n${stderr}`
					: stall
						? `Agent stalled: ${stall.reason}\n${stderr}`
						: stderr,
				timedOut,
				stall,
			});
		});
		proc.on("error", () => {
			if (resolved) return;
			resolved = true;
			cleanup();
			resolve({ exitCode: 1, stdout, stderr: stderr || "Failed to spawn pi" });
		});

		// Kill helper — SIGTERM then SIGKILL after 5s
		const killProc = () => {
			proc.kill("SIGTERM");
			setTimeout(() => {
				if (!proc.killed) proc.kill("SIGKILL");
			}, 5000);
		};

		// External abort signal (user cancellation)
		if (signal) {
			if (signal.aborted) killProc();
			else signal.addEventListener("abort", killProc, { once: true });
		}

		// Per-task timeout (backstop)
		const effectiveTimeout = timeoutMs ?? DEFAULT_TASK_TIMEOUT_MS;
		const timer = effectiveTimeout > 0
			? setTimeout(() => {
				timedOut = true;
				killProc();
			}, effectiveTimeout)
			: undefined;
	});
}
