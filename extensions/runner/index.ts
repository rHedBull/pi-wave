/**
 * Runner factory — selects between pi and Claude Code runtimes.
 *
 * Selection order:
 * 1. Explicit RuntimeType parameter
 * 2. PI_WAVE_RUNTIME environment variable ("pi" | "claude")
 * 3. Auto-detect: if `claude` binary exists on PATH → claude, else → pi
 */

import { execFileSync } from "node:child_process";
import { ClaudeCodeRunner } from "./claude-runner.js";
import { PiRunner } from "./pi-runner.js";
import type { AgentRunner, RuntimeType } from "./types.js";

export type { AgentRunner, RunnerConfig, RunnerResult, RuntimeType, StallInfo } from "./types.js";

function commandExists(cmd: string): boolean {
	try {
		execFileSync("which", [cmd], { encoding: "utf-8", timeout: 5000, stdio: "pipe" });
		return true;
	} catch {
		return false;
	}
}

function detectRuntime(): RuntimeType {
	const envVal = process.env.PI_WAVE_RUNTIME;
	if (envVal === "pi" || envVal === "claude") return envVal;
	return commandExists("claude") ? "claude" : "pi";
}

export function createRunner(type?: RuntimeType): AgentRunner {
	const runtime = type ?? detectRuntime();
	return runtime === "claude" ? new ClaudeCodeRunner() : new PiRunner();
}
