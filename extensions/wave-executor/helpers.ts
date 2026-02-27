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

export function specPath(cwd: string, name: string): string {
	return path.join(specDir(cwd), name, "SPEC.md");
}

/**
 * Find a spec file flexibly. Checks (in order):
 * 1. Exact file path (absolute or relative to cwd)
 * 2. Canonical location: docs/spec/<name>/SPEC.md
 * 3. Any .md file in docs/spec/<name>/
 * 4. docs/spec/<name>.md (flat file, no subdirectory)
 * 5. Legacy location: .pi/waves/<name>/SPEC.md
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

	// 2. Canonical: docs/spec/<name>/SPEC.md
	const canonical = path.join(specDir(cwd), name, "SPEC.md");
	if (fs.existsSync(canonical)) return canonical;

	// 3. Any .md in docs/spec/<name>/
	const projDir = path.join(specDir(cwd), name);
	if (fs.existsSync(projDir) && fs.statSync(projDir).isDirectory()) {
		const mds = fs.readdirSync(projDir).filter((f) => f.endsWith(".md"));
		if (mds.length > 0) return path.join(projDir, mds[0]);
	}

	// 4. Flat file: docs/spec/<name>.md
	const flat = path.join(specDir(cwd), `${name}.md`);
	if (fs.existsSync(flat)) return flat;

	// 5. Legacy: .pi/waves/<name>/SPEC.md
	const legacy = path.join(cwd, ".pi", "waves", name, "SPEC.md");
	if (fs.existsSync(legacy)) return legacy;

	return null;
}

export function planPath(cwd: string, name: string): string {
	return path.join(planDir(cwd), name, "PLAN.md");
}

export function logFilePath(cwd: string, name: string): string {
	return path.join(planDir(cwd), name, "EXECUTION.md");
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

// ── File Access Enforcement ────────────────────────────────────────

export function generateEnforcementExtension(rules: FileAccessRules): string {
	return `
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import * as path from "node:path";

const rules = ${JSON.stringify(rules)};

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
): { filePath: string; dir: string } {
	const dir = path.join(os.tmpdir(), `pi-wave-enforce-${taskId}-${Date.now()}`);
	fs.mkdirSync(dir, { recursive: true });
	const filePath = path.join(dir, "enforce.ts");
	fs.writeFileSync(filePath, generateEnforcementExtension(rules), {
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

/**
 * Spawn a pi subprocess for the given agent.
 *
 * Looks for agent definitions in:
 * 1. The package's own agents/ directory
 * 2. The global ~/.pi/agent/agents/ directory
 */
export function runSubagent(
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
			enforcement = writeEnforcementExtension(
				cwd,
				agentName + "-" + Math.random().toString(36).slice(2, 8),
				fileRules,
			);
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
				setTimeout(() => {
					if (!proc.killed) proc.kill("SIGKILL");
				}, 5000);
			};
			if (signal.aborted) kill();
			else signal.addEventListener("abort", kill, { once: true });
		}
	});
}
