/**
 * Shared helpers extracted from the wave executor.
 *
 * Pure utility functions: spec parsing, file paths, subagent runner,
 * file access enforcement.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRunner } from "../runner/index.js";
import type { FileAccessRules } from "./types.js";

// ── Version ────────────────────────────────────────────────────────

/** Read version from package.json (single source of truth). */
export const VERSION: string = (() => {
	try {
		const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "package.json"), "utf-8"));
		return pkg.version || "unknown";
	} catch { return "unknown"; }
})();

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
 * Extract the final assistant text from agent output.
 * Delegates to the configured runner for format-aware parsing.
 */
export function extractFinalOutput(jsonLines: string): string {
	const runner = createRunner();
	return runner.extractFinalOutput(jsonLines);
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

// ── Task Log Paths ─────────────────────────────────────────────────

/**
 * Create the task logs directory for this execution run.
 * Tied to the execution version: execution-v3.md → logs-v3/
 * Each execution gets its own log directory — no merging between runs.
 */
export function createTaskLogDir(executionLogPath: string): string {
	const match = path.basename(executionLogPath).match(/execution-v(\d+)\.md$/);
	const version = match ? match[1] : "1";
	const dir = path.join(path.dirname(executionLogPath), `logs-v${version}`);
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

/** Append a line to an already-closed task log file (best effort). */
export function appendTaskLog(logFile: string | undefined, text: string): void {
	if (!logFile) return;
	try { fs.appendFileSync(logFile, `${text}\n`); } catch { /* best effort */ }
}

/** Get the log file path for a task, including agent role suffix. */
export function taskLogFile(logDir: string, taskId: string, agent?: string): string {
	const suffix = agent === "test-writer" ? "-test"
		: agent === "wave-verifier" ? "-verify"
		: agent === "worker" ? "-impl"
		: "";
	return path.join(logDir, `${taskId}${suffix}.log`);
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

		// Block subagent calls — workers must not escalate permissions
		if (toolName === "subagent") {
			return { block: true, reason: "BLOCKED: subagent calls are not allowed in wave tasks. If you are blocked on an environment issue, report it and move on — the executor will handle it." };
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

// Re-export stall constants and types from the runner for backward compatibility
export {
	DEFAULT_TASK_TIMEOUT_MS,
	HANGING_TOOL_TIMEOUT_MS,
	STALL_SOFT_IDENTICAL_CALLS,
	STALL_HARD_IDENTICAL_CALLS,
	STALL_SOFT_CONSECUTIVE_ERRORS,
	STALL_HARD_CONSECUTIVE_ERRORS,
} from "../runner/pi-runner.js";
export type { StallInfo, RunnerResult as SubagentResult } from "../runner/types.js";

/**
 * Spawn an agent subprocess for the given task.
 *
 * Delegates to the configured runner (pi or Claude Code).
 * The runner is selected via PI_WAVE_RUNTIME env var or auto-detection.
 */
export function runSubagent(
	agentName: string,
	task: string,
	cwd: string,
	signal?: AbortSignal,
	fileRules?: FileAccessRules,
	timeoutMs?: number,
	logFile?: string,
	logContext?: string[],
): Promise<import("../runner/types.js").RunnerResult> {
	// Write log header if logFile is specified
	if (logFile) {
		try {
			fs.mkdirSync(path.dirname(logFile), { recursive: true });
			const header = [
				`# Task Log: ${agentName}`,
				`Started: ${new Date().toISOString()}`,
				...(logContext || []),
				`---`,
				``,
			].join("\n");
			fs.writeFileSync(logFile, header, "utf-8");
		} catch { /* best effort */ }
	}

	const runner = createRunner();
	const startTime = Date.now();
	return runner.spawn({
		agentName,
		systemPrompt: "",
		task,
		cwd,
		signal,
		fileRules,
		timeoutMs,
	}).then((result) => {
		// Append result summary to log file
		if (logFile) {
			try {
				const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
				const summary = [
					``,
					`---`,
					`Elapsed: ${elapsed}s`,
					`Exit code: ${result.exitCode}`,
					result.timedOut ? `TIMED OUT` : "",
					result.stall ? `STALLED: ${result.stall.reason}` : "",
				].filter(Boolean).join("\n");
				fs.appendFileSync(logFile, summary + "\n", "utf-8");
				// Also write stdout for debugging
				if (result.stdout) {
					fs.appendFileSync(logFile, `\n## Raw Output\n\`\`\`\n${result.stdout.slice(0, 50000)}\n\`\`\`\n`, "utf-8");
				}
			} catch { /* best effort */ }
		}
		return result;
	});
}
