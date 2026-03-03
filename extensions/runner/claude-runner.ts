/**
 * ClaudeCodeRunner — spawns `claude` (Claude Code CLI) processes for agent execution.
 *
 * Maps pi CLI flags to Claude Code equivalents and translates the
 * stream-json event format back to RunnerResult.
 */

import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { FileAccessRules } from "../wave-executor/types.js";
import type { AgentRunner, RunnerConfig, RunnerResult, StallInfo } from "./types.js";

/** Default per-task timeout: 10 minutes */
const DEFAULT_TASK_TIMEOUT_MS = 10 * 60 * 1000;

/** Hanging tool timeout — same as PiRunner */
const HANGING_TOOL_TIMEOUT_MS = 3 * 60 * 1000;

// Stall detection thresholds (same as PiRunner)
const STALL_HARD_IDENTICAL_CALLS = 10;
const STALL_HARD_CONSECUTIVE_ERRORS = 14;

/**
 * Map pi tool names (lowercase) to Claude Code tool names (PascalCase).
 */
const TOOL_NAME_MAP: Record<string, string> = {
	read: "Read",
	write: "Write",
	edit: "Edit",
	bash: "Bash",
	grep: "Grep",
	find: "Glob",
	ls: "LS",
};

function mapToolNames(piTools: string[]): string[] {
	return piTools.map((t) => TOOL_NAME_MAP[t] ?? t);
}

function interruptChildren(parentPid: number): void {
	try {
		const output = execFileSync("pgrep", ["-P", String(parentPid)], { encoding: "utf-8", timeout: 5000 });
		for (const line of output.trim().split("\n")) {
			const pid = parseInt(line, 10);
			if (pid > 0) {
				try { process.kill(pid, "SIGINT"); } catch { /* already exited */ }
			}
		}
	} catch { /* pgrep unavailable or no children */ }
}

/**
 * Build file access constraints as system prompt instructions for Claude Code.
 * Since Claude Code doesn't have pi's enforcement extension system,
 * we use --disallowedTools for hard blocks and system prompt for soft constraints.
 */
function buildFileAccessArgs(rules: FileAccessRules): { disallowedTools: string[]; promptExtra: string } {
	const disallowedTools: string[] = [];
	const promptLines: string[] = [];

	if (rules.readOnly) {
		disallowedTools.push("Write", "Edit");
	}

	if (rules.allowWrite && rules.allowWrite.length > 0 && !rules.readOnly) {
		promptLines.push(
			`IMPORTANT FILE ACCESS RESTRICTION: You may ONLY write/edit these files: ${rules.allowWrite.join(", ")}`,
			"Do NOT modify any other files.",
		);
	}

	if (rules.protectedPaths && rules.protectedPaths.length > 0) {
		promptLines.push(
			`PROTECTED FILES — do NOT modify these under any circumstances: ${rules.protectedPaths.join(", ")}`,
		);
	}

	if (rules.safeBashOnly) {
		promptLines.push(
			"SAFE BASH ONLY: Do not run destructive bash commands (rm, mv, cp, mkdir, touch, chmod, tee, sudo, git add/commit/push/reset/checkout, or output redirection).",
		);
	}

	return { disallowedTools, promptExtra: promptLines.join("\n") };
}

function summarizeToolInput(input: any): string {
	if (!input) return "";
	if (input.command) return input.command.slice(0, 120);
	if (input.file_path) return input.file_path;
	if (input.path) return input.path;
	return JSON.stringify(input).slice(0, 120);
}

export class ClaudeCodeRunner implements AgentRunner {
	spawn(config: RunnerConfig): Promise<RunnerResult> {
		return new Promise((resolve) => {
			const args = [
				"--output-format", "stream-json",
				"-p",
				"--verbose",
			];

			if (config.model) args.push("--model", config.model);

			// Map pi permission modes to Claude Code equivalents
			if (config.permissionMode === "fullAuto") {
				args.push("--dangerously-skip-permissions");
			}

			// Map tool names and build allowed/disallowed lists
			if (config.tools && config.tools.length > 0) {
				const mapped = mapToolNames(config.tools);
				args.push("--allowedTools", mapped.join(","));
			}

			// File access rules
			let fileAccessPrompt = "";
			if (config.fileRules) {
				const { disallowedTools, promptExtra } = buildFileAccessArgs(config.fileRules);
				if (disallowedTools.length > 0) {
					args.push("--disallowedTools", disallowedTools.join(","));
				}
				fileAccessPrompt = promptExtra;
			}

			// System prompt: combine agent definition + config system prompt + file access rules
			const systemPromptParts: string[] = [];

			// Look for agent definition files (same as PiRunner)
			const packageRoot = path.join(__dirname, "..", "..");
			const packageAgentsDir = path.join(packageRoot, "agents");
			const globalAgentsDir = path.join(os.homedir(), ".pi", "agent", "agents");
			const agentFile = fs.existsSync(path.join(packageAgentsDir, `${config.agentName}.md`))
				? path.join(packageAgentsDir, `${config.agentName}.md`)
				: path.join(globalAgentsDir, `${config.agentName}.md`);
			if (fs.existsSync(agentFile)) {
				systemPromptParts.push(fs.readFileSync(agentFile, "utf-8"));
			}

			if (config.systemPrompt.trim()) {
				systemPromptParts.push(config.systemPrompt);
			}
			if (fileAccessPrompt) {
				systemPromptParts.push(fileAccessPrompt);
			}

			if (systemPromptParts.length > 0) {
				// Write combined system prompt to temp file for --append-system-prompt
				const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-runner-"));
				const filePath = path.join(dir, `prompt-${config.agentName.replace(/[^\w.-]+/g, "_")}.md`);
				fs.writeFileSync(filePath, systemPromptParts.join("\n\n---\n\n"), { encoding: "utf-8", mode: 0o600 });
				args.push("--append-system-prompt", filePath);
			}

			// The task itself is the positional argument
			args.push(`Task: ${config.task}`);

			let stdout = "";
			let stderr = "";
			let lineBuffer = "";
			let resolved = false;
			let timedOut = false;
			let stall: StallInfo | undefined;

			// Stall detection state
			let consecutiveErrors = 0;
			const callCounts = new Map<string, number>();
			const recentActivity: string[] = [];

			// Track current tool use for stall detection
			let currentToolName: string | undefined;
			let currentToolInput: any;

			function checkStall(): { level: "hard"; reason: string } | null {
				// Claude Code has no enforcement extension, so only hard kill
				if (currentToolName) {
					const summary = `${currentToolName}(${summarizeToolInput(currentToolInput)})`;
					recentActivity.push(summary);
					if (recentActivity.length > 15) recentActivity.shift();

					const key = `${currentToolName}:${JSON.stringify(currentToolInput ?? {})}`;
					const count = (callCounts.get(key) ?? 0) + 1;
					callCounts.set(key, count);

					if (count >= STALL_HARD_IDENTICAL_CALLS) {
						return { level: "hard", reason: `${currentToolName} called ${count} times with identical arguments` };
					}
				}

				if (consecutiveErrors >= STALL_HARD_CONSECUTIVE_ERRORS) {
					return { level: "hard", reason: `${consecutiveErrors} consecutive tool errors` };
				}

				return null;
			}

			const proc = spawn("claude", args, { cwd: config.cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });

			let hangingToolTimer: ReturnType<typeof setTimeout> | undefined;

			const cleanup = () => {
				clearTimeout(hangingToolTimer);
				clearTimeout(timer);
			};

			proc.stdout.on("data", (data: Buffer) => {
				const chunk = data.toString();
				stdout += chunk;

				lineBuffer += chunk;
				const lines = lineBuffer.split("\n");
				lineBuffer = lines.pop() || "";

				for (const line of lines) {
					if (!line.trim()) continue;
					try {
						const event = JSON.parse(line);
						this.processStreamEvent(event, {
							onToolStart: (name: string, input: any) => {
								currentToolName = name;
								currentToolInput = input;

								// Hanging tool detection for Bash
								if (name === "Bash" || name === "bash") {
									clearTimeout(hangingToolTimer);
									hangingToolTimer = setTimeout(() => {
										interruptChildren(proc.pid!);
									}, HANGING_TOOL_TIMEOUT_MS);
								}

								const stallResult = checkStall();
								if (stallResult && !timedOut && !stall) {
									stall = { reason: stallResult.reason, recentActivity: [...recentActivity] };
									killProc();
								}
							},
							onToolEnd: (isError: boolean) => {
								clearTimeout(hangingToolTimer);
								currentToolName = undefined;
								currentToolInput = undefined;

								if (isError) {
									consecutiveErrors++;
								} else {
									consecutiveErrors = 0;
								}

								const stallResult = checkStall();
								if (stallResult && !timedOut && !stall) {
									stall = { reason: stallResult.reason, recentActivity: [...recentActivity] };
									killProc();
								}
							},
						});
					} catch {
						/* not JSON, skip */
					}
				}
			});

			proc.stderr.on("data", (data: Buffer) => {
				stderr += data.toString();
			});

			proc.on("close", (code: number | null) => {
				if (resolved) return;
				resolved = true;
				cleanup();
				resolve({
					exitCode: stall ? 125 : timedOut ? 124 : (code ?? 1),
					stdout,
					stderr: timedOut
						? `Task timed out after ${Math.round((config.timeoutMs ?? DEFAULT_TASK_TIMEOUT_MS) / 1000)}s\n${stderr}`
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
				resolve({ exitCode: 1, stdout, stderr: stderr || "Failed to spawn claude" });
			});

			const killProc = () => {
				proc.kill("SIGTERM");
				setTimeout(() => {
					if (!proc.killed) proc.kill("SIGKILL");
				}, 5000);
			};

			if (config.signal) {
				if (config.signal.aborted) killProc();
				else config.signal.addEventListener("abort", killProc, { once: true });
			}

			const effectiveTimeout = config.timeoutMs ?? DEFAULT_TASK_TIMEOUT_MS;
			const timer = effectiveTimeout > 0
				? setTimeout(() => {
					timedOut = true;
					killProc();
				}, effectiveTimeout)
				: undefined;
		});
	}

	/**
	 * Process a single stream-json event from Claude Code.
	 *
	 * Claude Code stream-json format emits events like:
	 * - { type: "assistant", message: { ... }, session_id: "..." }
	 * - { type: "tool_use", tool: { name, input }, session_id: "..." }
	 * - { type: "tool_result", tool: { name }, content: "...", is_error: bool }
	 * - { type: "result", result: "...", session_id: "..." }
	 */
	private processStreamEvent(
		event: any,
		callbacks: {
			onToolStart: (name: string, input: any) => void;
			onToolEnd: (isError: boolean) => void;
		},
	): void {
		if (event.type === "tool_use" && event.tool) {
			callbacks.onToolStart(event.tool.name, event.tool.input);
		}
		if (event.type === "tool_result") {
			callbacks.onToolEnd(!!event.is_error);
		}
	}

	/**
	 * Extract final assistant text from Claude Code stream-json output.
	 *
	 * Claude Code stream-json emits a final `{ type: "result", result: "..." }` event.
	 * Falls back to accumulating assistant message text blocks.
	 */
	extractFinalOutput(jsonLines: string): string {
		const lines = jsonLines.split("\n").filter((l) => l.trim());
		let lastResult = "";
		let lastAssistantText = "";

		for (const line of lines) {
			try {
				const event = JSON.parse(line);

				// Primary: the final result event
				if (event.type === "result" && event.result) {
					lastResult = event.result;
				}

				// Fallback: accumulate assistant message text
				if (event.type === "assistant" && event.message?.content) {
					for (const block of event.message.content) {
						if (block.type === "text") {
							lastAssistantText = block.text;
						}
					}
				}

				// Also handle pi-style message_end events (in case Claude Code
				// emits them in a compatible format in the future)
				if (event.type === "message_end" && event.message?.role === "assistant") {
					for (const part of event.message.content) {
						if (part.type === "text") lastAssistantText = part.text;
					}
				}
			} catch {
				/* skip */
			}
		}

		return lastResult || lastAssistantText;
	}
}
