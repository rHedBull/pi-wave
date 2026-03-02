/**
 * Shared helpers extracted from the wave executor.
 *
 * Pure utility functions: spec parsing, file paths, subagent runner,
 * file access enforcement.
 */

import { execSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { FileAccessRules } from "./types.js";

// ── Post-Task File Verification ────────────────────────────────────

/**
 * Check that files declared by a task actually exist on disk.
 * Returns the list of missing files. Empty array = all present.
 *
 * Skips glob patterns (containing *) since those can't be checked simply.
 */
export function checkDeclaredFiles(declaredFiles: string[], cwd: string): string[] {
	const missing: string[] = [];
	for (const file of declaredFiles) {
		// Skip glob patterns
		if (file.includes("*")) continue;
		const resolved = path.resolve(cwd, file);
		if (!fs.existsSync(resolved)) {
			missing.push(file);
		}
	}
	return missing;
}

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
//
// All wave project files live under .pi/waves/<project>/:
//   spec-v1.md, spec-v2.md, plan-v1.md, execution-v1.md, state.json
//

export function slugify(text: string): string {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 60);
}

function wavesBaseDir(cwd: string): string {
	return path.join(cwd, ".pi", "waves");
}

export function projectDir(cwd: string, name: string): string {
	return path.join(wavesBaseDir(cwd), name);
}

export function ensureProjectDir(cwd: string, name: string): void {
	const dir = projectDir(cwd, name);
	if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// ── Versioned File Helpers ─────────────────────────────────────────

type FileType = "spec" | "plan" | "execution";

/**
 * List versioned files of a given type in a directory, sorted by version ascending.
 * Matches: spec-v1.md, plan-v3.md, execution-v2.md
 */
export function versionedFiles(dir: string, type: FileType): { file: string; version: number }[] {
	if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return [];
	const regex = new RegExp(`^${type}-v(\\d+)\\.md$`);
	return fs.readdirSync(dir)
		.map((f) => {
			const m = f.match(regex);
			return m ? { file: f, version: parseInt(m[1], 10) } : null;
		})
		.filter((x): x is { file: string; version: number } => x !== null)
		.sort((a, b) => a.version - b.version);
}

function nextVersion(dir: string, type: FileType): number {
	const existing = versionedFiles(dir, type);
	return existing.length > 0 ? existing[existing.length - 1].version + 1 : 1;
}

/**
 * Get the latest versioned file of a given type. Returns null if none found.
 */
export function latestFile(dir: string, type: FileType): string | null {
	const files = versionedFiles(dir, type);
	if (files.length > 0) return path.join(dir, files[files.length - 1].file);

	// Legacy fallback: SPEC.md / PLAN.md
	const legacyName = type === "spec" ? "SPEC.md" : type === "plan" ? "PLAN.md" : null;
	if (legacyName) {
		const legacy = path.join(dir, legacyName);
		if (fs.existsSync(legacy)) return legacy;
	}
	return null;
}

/**
 * List all versions of a file type with full paths.
 */
export function allVersions(dir: string, type: FileType): { file: string; version: number; path: string }[] {
	return versionedFiles(dir, type).map((f) => ({ ...f, path: path.join(dir, f.file) }));
}

// ── Write Paths (create next version) ──────────────────────────────

export function specPath(cwd: string, name: string): string {
	const dir = projectDir(cwd, name);
	const v = nextVersion(dir, "spec");
	return path.join(dir, `spec-v${v}.md`);
}

export function planPath(cwd: string, name: string): string {
	const dir = projectDir(cwd, name);
	const v = nextVersion(dir, "plan");
	return path.join(dir, `plan-v${v}.md`);
}

export function logFilePath(cwd: string, name: string): string {
	const dir = projectDir(cwd, name);
	const v = nextVersion(dir, "execution");
	return path.join(dir, `execution-v${v}.md`);
}

// ── Migrate Loose Files ────────────────────────────────────────────
//
// Detect wave-related files outside .pi/waves/ and move them in.
// Scans: project root, docs/spec/, docs/plan/, legacy SPEC.md/PLAN.md.
//

/** Detect the file type from a filename. */
function detectFileType(filename: string): FileType | null {
	const lower = filename.toLowerCase();
	if (lower.includes("execution")) return "execution";
	if (lower.includes("spec")) return "spec";
	if (lower.includes("plan")) return "plan";
	return null;
}

/** Derive a project name from a loose file in the project root. */
function deriveProjectName(filename: string, cwd: string): string {
	let name = path.basename(filename, path.extname(filename));
	name = name
		.replace(/[-_]?(spec|plan|execution)[-_]?/gi, "")
		.replace(/[-_]?v\d+$/i, "")
		.replace(/[-_]?\d{4}-\d{2}-\d{2}[-_T]?\d{2}[-:]\d{2}([-:]\d{2})?/g, "")
		.replace(/^-+|-+$/g, "");
	if (name) return slugify(name);
	return slugify(path.basename(cwd));
}

/** Move a file into .pi/waves/<project>/ as the next version. Returns dest path or null if already there. */
function adoptFile(cwd: string, project: string, type: FileType, srcPath: string): string | null {
	const dir = projectDir(cwd, project);
	if (path.resolve(path.dirname(srcPath)) === path.resolve(dir)) return null; // already in place
	ensureProjectDir(cwd, project);
	const v = nextVersion(dir, type);
	const dest = path.join(dir, `${type}-v${v}.md`);
	fs.renameSync(srcPath, dest);
	return dest;
}

/**
 * Scan for wave-related files outside .pi/waves/ and move them to the standard location.
 * Returns human-readable descriptions of what was moved (empty if nothing found).
 *
 * Checks:
 * 1. Project root — *.md files with "spec"/"plan"/"execution" in the name
 * 2. Old layout — docs/spec/<project>/ and docs/plan/<project>/
 * 3. Legacy naming — .pi/waves/<project>/SPEC.md → spec-v1.md
 */
export function migrateLooseFiles(cwd: string): string[] {
	const moved: string[] = [];
	const rel = (p: string) => path.relative(cwd, p);

	// ── 1. Project root: loose spec/plan/execution .md files ────────

	try {
		for (const entry of fs.readdirSync(cwd, { withFileTypes: true })) {
			if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
			const type = detectFileType(entry.name);
			if (!type) continue;
			const src = path.join(cwd, entry.name);
			const project = deriveProjectName(entry.name, cwd);
			const dest = adoptFile(cwd, project, type, src);
			if (dest) moved.push(`${rel(src)} → ${rel(dest)}`);
		}
	} catch { /* cwd unreadable */ }

	// ── 2. Old layout: docs/spec/ and docs/plan/ ───────────────────

	for (const [oldBase, defaultType] of [
		[path.join(cwd, "docs", "spec"), "spec" as FileType],
		[path.join(cwd, "docs", "plan"), "plan" as FileType],
	]) {
		if (!fs.existsSync(oldBase) || !fs.statSync(oldBase).isDirectory()) continue;

		for (const projEntry of fs.readdirSync(oldBase, { withFileTypes: true })) {
			if (!projEntry.isDirectory()) continue;
			const projDir = path.join(oldBase, projEntry.name);

			for (const fileEntry of fs.readdirSync(projDir, { withFileTypes: true })) {
				if (!fileEntry.isFile()) continue;

				// .md files → move as spec/plan/execution
				if (fileEntry.name.endsWith(".md")) {
					const type = detectFileType(fileEntry.name) || defaultType;
					const src = path.join(projDir, fileEntry.name);
					const dest = adoptFile(cwd, projEntry.name, type, src);
					if (dest) moved.push(`${rel(src)} → ${rel(dest)}`);
				}

				// .state.json files → move as state.json
				if (fileEntry.name.endsWith(".state.json")) {
					const src = path.join(projDir, fileEntry.name);
					const destDir = projectDir(cwd, projEntry.name);
					ensureProjectDir(cwd, projEntry.name);
					const dest = path.join(destDir, "state.json");
					if (!fs.existsSync(dest)) {
						fs.renameSync(src, dest);
						moved.push(`${rel(src)} → ${rel(dest)}`);
					}
				}
			}

			// Clean up empty project dir
			try { fs.rmdirSync(projDir); } catch { /* not empty */ }
		}

		// Clean up empty docs/spec or docs/plan dir
		try { fs.rmdirSync(oldBase); } catch { /* not empty */ }
	}

	// Clean up empty docs/ dir
	try { fs.rmdirSync(path.join(cwd, "docs")); } catch { /* not empty */ }

	// ── 3. Legacy naming: SPEC.md / PLAN.md in .pi/waves/<project>/ ─

	const wDir = wavesBaseDir(cwd);
	if (fs.existsSync(wDir)) {
		for (const projEntry of fs.readdirSync(wDir, { withFileTypes: true })) {
			if (!projEntry.isDirectory()) continue;
			const projDir = path.join(wDir, projEntry.name);
			for (const [legacyName, type] of [
				["SPEC.md", "spec"],
				["PLAN.md", "plan"],
			] as [string, FileType][]) {
				const legacy = path.join(projDir, legacyName);
				if (!fs.existsSync(legacy)) continue;
				const v = nextVersion(projDir, type);
				const dest = path.join(projDir, `${type}-v${v}.md`);
				fs.renameSync(legacy, dest);
				moved.push(`${rel(legacy)} → ${rel(dest)}`);
			}
		}
	}

	return moved;
}

// ── Find Paths (locate existing files) ─────────────────────────────

/**
 * Find a spec file. Checks:
 * 1. Exact file path (absolute or relative to cwd)
 * 2. Latest spec-v*.md in .pi/waves/<name>/
 */
export function findSpecFile(cwd: string, nameOrPath: string): string | null {
	// 1. Exact path
	const asPath = path.resolve(cwd, nameOrPath);
	if (fs.existsSync(asPath) && fs.statSync(asPath).isFile()) return asPath;

	// 2. Latest versioned spec in project dir
	return latestFile(projectDir(cwd, slugify(nameOrPath)), "spec");
}

/**
 * Find a plan file. Checks:
 * 1. Exact file path (absolute or relative to cwd)
 * 2. Latest plan-v*.md in .pi/waves/<name>/
 */
export function findPlanFile(cwd: string, nameOrPath: string): string | null {
	// 1. Exact path
	const asPath = path.resolve(cwd, nameOrPath);
	if (fs.existsSync(asPath) && fs.statSync(asPath).isFile()) return asPath;

	// 2. Latest versioned plan in project dir
	return latestFile(projectDir(cwd, slugify(nameOrPath)), "plan");
}

// ── Project Listing & Resolution ───────────────────────────────────

export function listWaveProjects(cwd: string): string[] {
	const dir = wavesBaseDir(cwd);
	if (!fs.existsSync(dir)) return [];
	return fs.readdirSync(dir, { withFileTypes: true })
		.filter((d) => d.isDirectory())
		.map((d) => d.name)
		.sort();
}

/**
 * Resolve user input to a known project name.
 * 1. Exact match  2. Slugified match  3. Unique prefix match  4. Slug fallback
 */
export function resolveProject(cwd: string, input: string): string {
	const projects = listWaveProjects(cwd);
	if (projects.length === 0) return slugify(input);

	if (projects.includes(input)) return input;

	const slug = slugify(input);
	if (projects.includes(slug)) return slug;

	const matches = projects.filter((p) => p.startsWith(slug));
	if (matches.length === 1) return matches[0];

	return slug;
}

/**
 * Build a summary of a project's files for display.
 */
export function projectSummary(cwd: string, name: string): string {
	const dir = projectDir(cwd, name);
	const specs = versionedFiles(dir, "spec");
	const plans = versionedFiles(dir, "plan");
	const execs = versionedFiles(dir, "execution");
	const hasState = fs.existsSync(path.join(dir, "state.json"));

	const parts: string[] = [];
	if (specs.length > 0) parts.push(`📄 ${specs.map((s) => s.file).join(", ")}`);
	if (plans.length > 0) parts.push(`📋 ${plans.map((p) => p.file).join(", ")}`);
	if (execs.length > 0) parts.push(`📝 ${execs.map((e) => e.file).join(", ")}`);
	if (hasState) parts.push("⏸ resumable");

	return parts.join("  ");
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
 * Hanging tool timeout: if a single bash command produces no JSON events
 * for this long, kill its child process (not the agent). The agent sees
 * the command fail and continues. Catches dev servers, accidental
 * `docker compose up`, etc. Long builds that complete within this window
 * are unaffected.
 */
export const HANGING_TOOL_TIMEOUT_MS = 3 * 60 * 1000;

/**
 * Send SIGINT to all direct children of a process.
 * Used to interrupt a hanging bash command without killing the pi agent.
 */
function interruptChildren(parentPid: number): void {
	try {
		const output = execSync(`pgrep -P ${parentPid}`, { encoding: "utf-8", timeout: 5000 });
		for (const line of output.trim().split("\n")) {
			const pid = parseInt(line, 10);
			if (pid > 0) {
				try { process.kill(pid, "SIGINT"); } catch { /* already exited */ }
			}
		}
	} catch { /* pgrep unavailable or no children — nothing to interrupt */ }
}

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

		// ── Hanging tool detection ──
		// A single bash command that never returns (dev server, accidental
		// docker-compose up, etc). We kill its child process, not the agent.
		let hangingToolTimer: ReturnType<typeof setTimeout> | undefined;
		let hangingToolCommand: string | undefined;

		const cleanup = () => {
			if (enforcement) cleanupEnforcement(enforcement.filePath, enforcement.dir);
			// Clean up stall signal file
			try { fs.unlinkSync(stallSignalFile); } catch { /* ignore */ }
			clearTimeout(hangingToolTimer);
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

					// ── Hanging tool timer ──
					if (event.type === "tool_execution_start" && event.toolName === "bash") {
						hangingToolCommand = (event.args?.command ?? event.input?.command ?? "").slice(0, 120);
						clearTimeout(hangingToolTimer);
						hangingToolTimer = setTimeout(() => {
							// Kill the child process (the bash command), not the agent
							interruptChildren(proc.pid);
							// Write signal file so the agent gets guidance on its next tool call
							if (enforcement) {
								try {
									fs.writeFileSync(stallSignalFile,
										`bash command running for ${HANGING_TOOL_TIMEOUT_MS / 60000} minutes without completing: "${hangingToolCommand}". ` +
										`This appears to be a long-running or never-returning command (like a dev server). ` +
										`Do NOT re-run it. If you need to start a server, use a background process or skip it.`,
										"utf-8");
								} catch { /* best effort */ }
							}
						}, HANGING_TOOL_TIMEOUT_MS);
					}
					if (event.type === "tool_execution_end") {
						clearTimeout(hangingToolTimer);
						hangingToolCommand = undefined;
					}

					// ── Pattern-based stall detection ──
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
