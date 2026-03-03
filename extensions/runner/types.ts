/**
 * Runner abstraction — allows spawning either `pi` or `claude` as the agent runtime.
 */

import type { FileAccessRules } from "../wave-executor/types.js";

export interface StallInfo {
	reason: string;
	recentActivity: string[];
}

export interface RunnerResult {
	exitCode: number;
	stdout: string;
	stderr: string;
	timedOut?: boolean;
	stall?: StallInfo;
}

export interface RunnerConfig {
	agentName: string;
	systemPrompt: string;
	task: string;
	cwd: string;
	model?: string;
	tools?: string[];
	permissionMode?: string;
	signal?: AbortSignal;
	fileRules?: FileAccessRules;
	timeoutMs?: number;
}

export interface AgentRunner {
	spawn(config: RunnerConfig): Promise<RunnerResult>;
	extractFinalOutput(stdout: string): string;
}

export type RuntimeType = "pi" | "claude";
