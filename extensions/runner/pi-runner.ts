/**
 * PiRunner — spawns `pi` processes for agent execution.
 *
 * This is a direct extraction of the existing runSubagent() logic from helpers.ts,
 * wrapped in the AgentRunner interface.
 */

import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	writeEnforcementExtension,
	cleanupEnforcement,
} from "../wave-executor/helpers.js";
import type { AgentRunner, RunnerConfig, RunnerResult, StallInfo } from "./types.js";

/** Default per-task timeout: 10 minutes */
export const DEFAULT_TASK_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Hanging tool timeout: if a single bash command produces no JSON events
 * for this long, kill its child process (not the agent).
 */
export const HANGING_TOOL_TIMEOUT_MS = 3 * 60 * 1000;

// Stall detection thresholds
export const STALL_SOFT_IDENTICAL_CALLS = 5;
export const STALL_HARD_IDENTICAL_CALLS = 10;
export const STALL_SOFT_CONSECUTIVE_ERRORS = 8;
export const STALL_HARD_CONSECUTIVE_ERRORS = 14;

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

function summarizeArgs(toolArgs: any): string {
	if (!toolArgs) return "";
	if (toolArgs.command) return toolArgs.command.slice(0, 120);
	if (toolArgs.path) return toolArgs.path;
	return JSON.stringify(toolArgs).slice(0, 120);
}

export class PiRunner implements AgentRunner {
	spawn(config: RunnerConfig): Promise<RunnerResult> {
		return new Promise((resolve) => {
			const args = ["--mode", "json", "-p", "--no-session"];

			if (config.model) args.push("--model", config.model);
			if (config.tools && config.tools.length > 0) args.push("--tools", config.tools.join(","));
			if (config.permissionMode) args.push("--permission-mode", config.permissionMode);

			// Look for agent definitions: first in package dir, then in global agents dir
			const packageRoot = path.join(__dirname, "..", "..");
			const packageAgentsDir = path.join(packageRoot, "agents");
			const globalAgentsDir = path.join(os.homedir(), ".pi", "agent", "agents");
			const agentFile = fs.existsSync(path.join(packageAgentsDir, `${config.agentName}.md`))
				? path.join(packageAgentsDir, `${config.agentName}.md`)
				: path.join(globalAgentsDir, `${config.agentName}.md`);
			if (fs.existsSync(agentFile)) {
				args.push("--append-system-prompt", agentFile);
			}

			// System prompt from config (written to temp file)
			let tmpPromptDir: string | null = null;
			let tmpPromptPath: string | null = null;
			if (config.systemPrompt.trim()) {
				const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-runner-"));
				const filePath = path.join(dir, `prompt-${config.agentName.replace(/[^\w.-]+/g, "_")}.md`);
				fs.writeFileSync(filePath, config.systemPrompt, { encoding: "utf-8", mode: 0o600 });
				tmpPromptDir = dir;
				tmpPromptPath = filePath;
				args.push("--append-system-prompt", tmpPromptPath);
			}

			// Stall signal file
			const stallSignalFile = path.join(
				os.tmpdir(),
				`pi-wave-stall-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.signal`,
			);

			// File access enforcement extension
			let enforcement: { filePath: string; dir: string } | null = null;
			if (config.fileRules) {
				enforcement = writeEnforcementExtension(
					config.cwd,
					config.agentName + "-" + Math.random().toString(36).slice(2, 8),
					config.fileRules,
					stallSignalFile,
				);
				args.push("-e", enforcement.filePath);
			}

			args.push(`Task: ${config.task}`);

			let stdout = "";
			let stderr = "";
			let lineBuffer = "";
			let resolved = false;
			let timedOut = false;
			let stall: StallInfo | undefined;

			// Stall detection state
			let consecutiveErrors = 0;
			let softInterruptSent = false;
			const callCounts = new Map<string, number>();
			const recentActivity: string[] = [];

			// Error detection state — pi CLI in JSON mode always exits 0,
			// even on fatal errors (rate limits, auth failures, server errors, etc.)
			// We track error signals from the event stream to override exit code.
			let lastStopReason: string | undefined;
			let lastErrorMessage: string | undefined;
			let retryExhausted = false;  // auto_retry_end with success=false
			let hasAssistantOutput = false;  // any actual text output produced

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

			const proc = spawn("pi", args, { cwd: config.cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });

			let hangingToolTimer: ReturnType<typeof setTimeout> | undefined;
			let hangingToolCommand: string | undefined;

			const cleanup = () => {
				if (enforcement) cleanupEnforcement(enforcement.filePath, enforcement.dir);
				if (tmpPromptPath) try { fs.unlinkSync(tmpPromptPath); } catch { /* ignore */ }
				if (tmpPromptDir) try { fs.rmdirSync(tmpPromptDir); } catch { /* ignore */ }
				try { fs.unlinkSync(stallSignalFile); } catch { /* ignore */ }
				clearTimeout(hangingToolTimer);
				clearTimeout(timer);
			};

			proc.stdout.on("data", (data) => {
				const chunk = data.toString();
				stdout += chunk;

				lineBuffer += chunk;
				const lines = lineBuffer.split("\n");
				lineBuffer = lines.pop() || "";

				for (const line of lines) {
					if (!line.trim()) continue;
					try {
						const event = JSON.parse(line);

						// Track error signals from pi's event stream
						if (event.type === "message_end" && event.message?.role === "assistant") {
							lastStopReason = event.message.stopReason;
							lastErrorMessage = event.message.errorMessage;
							// Check if this message has actual text output
							if (Array.isArray(event.message.content)) {
								for (const part of event.message.content) {
									if (part.type === "text" && part.text?.trim()) {
										hasAssistantOutput = true;
									}
								}
							}
						}
						if (event.type === "agent_end") {
							// Check final message in agent_end for errors
							const msgs = event.messages;
							if (Array.isArray(msgs) && msgs.length > 0) {
								const lastMsg = msgs[msgs.length - 1];
								if (lastMsg?.role === "assistant") {
									lastStopReason = lastMsg.stopReason;
									lastErrorMessage = lastMsg.errorMessage;
									if (Array.isArray(lastMsg.content)) {
										for (const part of lastMsg.content) {
											if (part.type === "text" && part.text?.trim()) {
												hasAssistantOutput = true;
											}
										}
									}
								}
							}
						}
						if (event.type === "auto_retry_end" && event.success === false) {
							retryExhausted = true;
							if (event.finalError) lastErrorMessage = event.finalError;
						}

						// Hanging tool timer
						if (event.type === "tool_execution_start" && event.toolName === "bash") {
							hangingToolCommand = (event.args?.command ?? event.input?.command ?? "").slice(0, 120);
							clearTimeout(hangingToolTimer);
							hangingToolTimer = setTimeout(() => {
								interruptChildren(proc.pid!);
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

						// Pattern-based stall detection
						const stallResult = checkStall(event);
						if (stallResult && !timedOut) {
							if (stallResult.level === "soft" && enforcement) {
								softInterruptSent = true;
								try {
									fs.writeFileSync(stallSignalFile, stallResult.reason, "utf-8");
								} catch { /* best effort */ }
							} else if (stallResult.level === "hard" || (stallResult.level === "soft" && !enforcement)) {
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

				let effectiveExitCode = stall ? 125 : timedOut ? 124 : (code ?? 1);
				let effectiveStderr = timedOut
					? `Task timed out after ${Math.round((config.timeoutMs ?? DEFAULT_TASK_TIMEOUT_MS) / 1000)}s\n${stderr}`
					: stall
						? `Agent stalled: ${stall.reason}\n${stderr}`
						: stderr;

				// pi CLI in JSON mode always exits 0, even on fatal errors.
				// Detect error conditions and override exit code.
				if (effectiveExitCode === 0) {
					if (retryExhausted) {
						// All retries exhausted (rate limits, server errors, connection errors, etc.)
						effectiveExitCode = 1;
						effectiveStderr = `API error — retries exhausted: ${lastErrorMessage || "unknown error"}\n${effectiveStderr}`;
					} else if (lastStopReason === "error") {
						// Final message was an error (auth failure, context overflow, etc.)
						effectiveExitCode = 1;
						effectiveStderr = `Agent error: ${lastErrorMessage || "unknown error"}\n${effectiveStderr}`;
					} else if (!hasAssistantOutput) {
						// Process exited 0 but produced no text output at all — something went wrong
						effectiveExitCode = 1;
						effectiveStderr = `Agent produced no output\n${effectiveStderr}`;
					}
				}

				resolve({
					exitCode: effectiveExitCode,
					stdout,
					stderr: effectiveStderr,
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

	extractFinalOutput(jsonLines: string): string {
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
}
