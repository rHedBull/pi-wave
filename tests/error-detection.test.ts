/**
 * Tests for PiRunner error detection.
 *
 * Pi CLI in JSON mode (--mode json) always exits 0, even on fatal errors
 * like rate limits, auth failures, and server errors. The PiRunner must
 * detect these error signals from the JSON event stream and override
 * the exit code to 1.
 *
 * These tests simulate pi output by spawning a small node script that
 * writes JSON events to stdout and exits with code 0.
 */

import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { PiRunner } from "../extensions/runner/pi-runner.js";
import { isApiRateLimitError } from "../extensions/wave-executor/helpers.js";

// ── Helper: create a temp script that emits JSON events and exits 0 ──

function createFakePiScript(events: object[]): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-error-test-"));
	const lines = events.map((e) => JSON.stringify(e)).join("\\n");
	const script = path.join(dir, "pi");
	fs.writeFileSync(
		script,
		`#!/usr/bin/env node
process.stdout.write(${JSON.stringify(events.map((e) => JSON.stringify(e)).join("\n") + "\n")});
process.exit(0);
`,
		{ mode: 0o755 },
	);
	return script;
}

/** Spawn PiRunner with a fake pi binary */
async function runWithEvents(events: object[]): Promise<{
	exitCode: number;
	stdout: string;
	stderr: string;
}> {
	const script = createFakePiScript(events);
	const dir = path.dirname(script);

	// We need to trick PiRunner into running our script instead of `pi`.
	// PiRunner uses spawn("pi", ...) so we create a wrapper that puts our
	// script directory first in PATH.
	const wrapperDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wrapper-"));
	// Create a `pi` script in wrapperDir that delegates to our fake script,
	// passing through all arguments (which it ignores)
	fs.writeFileSync(
		path.join(wrapperDir, "pi"),
		`#!/bin/bash\nexec "${script}" "$@"\n`,
		{ mode: 0o755 },
	);

	// Save and override PATH
	const origPath = process.env.PATH;
	process.env.PATH = `${wrapperDir}:${origPath}`;

	try {
		const runner = new PiRunner();
		const result = await runner.spawn({
			agentName: "test",
			systemPrompt: "",
			task: "test task",
			cwd: "/tmp",
			timeoutMs: 10000,
		});
		return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
	} finally {
		process.env.PATH = origPath;
		// Cleanup
		try { fs.rmSync(dir, { recursive: true }); } catch { /* ignore */ }
		try { fs.rmSync(wrapperDir, { recursive: true }); } catch { /* ignore */ }
	}
}

// ════════════════════════════════════════════════════════════════════
// 1. Rate limit errors — retries exhausted
// ════════════════════════════════════════════════════════════════════

describe("PiRunner error detection: rate limits", () => {
	it("overrides exit code when auto_retry_end has success=false", async () => {
		const result = await runWithEvents([
			{
				type: "auto_retry_start",
				attempt: 1,
				maxAttempts: 3,
				delayMs: 2000,
				errorMessage: "429 rate_limit_error: Too many requests",
			},
			{
				type: "auto_retry_start",
				attempt: 2,
				maxAttempts: 3,
				delayMs: 4000,
				errorMessage: "429 rate_limit_error: Too many requests",
			},
			{
				type: "auto_retry_start",
				attempt: 3,
				maxAttempts: 3,
				delayMs: 8000,
				errorMessage: "429 rate_limit_error: Too many requests",
			},
			{
				type: "auto_retry_end",
				success: false,
				attempt: 3,
				finalError: "429 rate_limit_error: Too many requests",
			},
			{
				type: "agent_end",
				messages: [
					{
						role: "assistant",
						stopReason: "error",
						errorMessage: "429 rate_limit_error: Too many requests",
						content: [],
					},
				],
			},
		]);

		assert.equal(result.exitCode, 1, "should override exit code to 1");
		assert.ok(
			result.stderr.includes("retries exhausted"),
			`stderr should mention retries exhausted, got: ${result.stderr}`,
		);
		assert.ok(
			result.stderr.includes("rate_limit"),
			`stderr should mention rate_limit, got: ${result.stderr}`,
		);
	});

	it("overrides exit code for overloaded errors", async () => {
		const result = await runWithEvents([
			{
				type: "auto_retry_end",
				success: false,
				attempt: 3,
				finalError: "overloaded_error: Anthropic API is overloaded",
			},
		]);

		assert.equal(result.exitCode, 1);
		assert.ok(result.stderr.includes("retries exhausted"));
		assert.ok(result.stderr.includes("overloaded"));
	});
});

// ════════════════════════════════════════════════════════════════════
// 2. Server errors — retries exhausted
// ════════════════════════════════════════════════════════════════════

describe("PiRunner error detection: server errors", () => {
	it("overrides exit code for 502 gateway errors after retry exhaustion", async () => {
		const result = await runWithEvents([
			{
				type: "auto_retry_end",
				success: false,
				attempt: 3,
				finalError: "502 Bad Gateway",
			},
		]);

		assert.equal(result.exitCode, 1);
		assert.ok(result.stderr.includes("502 Bad Gateway"));
	});

	it("overrides exit code for 529 service overloaded after retry exhaustion", async () => {
		const result = await runWithEvents([
			{
				type: "auto_retry_end",
				success: false,
				attempt: 3,
				finalError: "529 Service Overloaded",
			},
		]);

		assert.equal(result.exitCode, 1);
		assert.ok(result.stderr.includes("529"));
	});

	it("overrides exit code for connection refused after retry exhaustion", async () => {
		const result = await runWithEvents([
			{
				type: "auto_retry_end",
				success: false,
				attempt: 3,
				finalError: "Connection refused to api.anthropic.com",
			},
		]);

		assert.equal(result.exitCode, 1);
		assert.ok(result.stderr.includes("Connection refused"));
	});
});

// ════════════════════════════════════════════════════════════════════
// 3. Non-retryable errors — stopReason=error without retry
// ════════════════════════════════════════════════════════════════════

describe("PiRunner error detection: non-retryable errors", () => {
	it("overrides exit code for authentication error (invalid API key)", async () => {
		const result = await runWithEvents([
			{
				type: "message_end",
				message: {
					role: "assistant",
					stopReason: "error",
					errorMessage: "authentication_error: Invalid API key",
					content: [],
				},
			},
			{
				type: "agent_end",
				messages: [
					{
						role: "assistant",
						stopReason: "error",
						errorMessage: "authentication_error: Invalid API key",
						content: [],
					},
				],
			},
		]);

		assert.equal(result.exitCode, 1);
		assert.ok(result.stderr.includes("Agent error"));
		assert.ok(result.stderr.includes("authentication_error"));
	});

	it("overrides exit code for context overflow (compaction failed)", async () => {
		const result = await runWithEvents([
			{
				type: "message_end",
				message: {
					role: "assistant",
					stopReason: "error",
					errorMessage: "Context overflow recovery failed after one compact-and-retry attempt.",
					content: [],
				},
			},
			{
				type: "agent_end",
				messages: [
					{
						role: "assistant",
						stopReason: "error",
						errorMessage: "Context overflow recovery failed after one compact-and-retry attempt.",
						content: [],
					},
				],
			},
		]);

		assert.equal(result.exitCode, 1);
		assert.ok(result.stderr.includes("Context overflow"));
	});
});

// ════════════════════════════════════════════════════════════════════
// 4. No output safety net
// ════════════════════════════════════════════════════════════════════

describe("PiRunner error detection: no output safety net", () => {
	it("overrides exit code when no assistant text output at all", async () => {
		const result = await runWithEvents([
			{ type: "system", message: "Starting agent..." },
		]);

		assert.equal(result.exitCode, 1);
		assert.ok(result.stderr.includes("no output"));
	});

	it("overrides exit code for empty content array", async () => {
		const result = await runWithEvents([
			{
				type: "message_end",
				message: {
					role: "assistant",
					stopReason: "end_turn",
					content: [],
				},
			},
			{
				type: "agent_end",
				messages: [
					{
						role: "assistant",
						stopReason: "end_turn",
						content: [],
					},
				],
			},
		]);

		assert.equal(result.exitCode, 1);
		assert.ok(result.stderr.includes("no output"));
	});

	it("overrides exit code when content is only whitespace", async () => {
		const result = await runWithEvents([
			{
				type: "message_end",
				message: {
					role: "assistant",
					stopReason: "end_turn",
					content: [{ type: "text", text: "   \n  " }],
				},
			},
		]);

		assert.equal(result.exitCode, 1);
		assert.ok(result.stderr.includes("no output"));
	});
});

// ════════════════════════════════════════════════════════════════════
// 5. Successful cases — should NOT override exit code
// ════════════════════════════════════════════════════════════════════

describe("PiRunner error detection: successful cases (no override)", () => {
	it("keeps exit code 0 when agent produces text output", async () => {
		const result = await runWithEvents([
			{
				type: "message_end",
				message: {
					role: "assistant",
					stopReason: "end_turn",
					content: [{ type: "text", text: "I have completed the task successfully." }],
				},
			},
			{
				type: "agent_end",
				messages: [
					{
						role: "assistant",
						stopReason: "end_turn",
						content: [{ type: "text", text: "I have completed the task successfully." }],
					},
				],
			},
		]);

		assert.equal(result.exitCode, 0, "should keep exit code 0 for successful task");
		assert.equal(result.stderr, "", "stderr should be empty");
	});

	it("keeps exit code 0 when retries succeed", async () => {
		const result = await runWithEvents([
			{
				type: "auto_retry_start",
				attempt: 1,
				maxAttempts: 3,
				delayMs: 2000,
				errorMessage: "429 rate_limit_error",
			},
			{
				type: "auto_retry_end",
				success: true,
				attempt: 1,
			},
			{
				type: "message_end",
				message: {
					role: "assistant",
					stopReason: "end_turn",
					content: [{ type: "text", text: "Task done after retry." }],
				},
			},
			{
				type: "agent_end",
				messages: [
					{
						role: "assistant",
						stopReason: "end_turn",
						content: [{ type: "text", text: "Task done after retry." }],
					},
				],
			},
		]);

		assert.equal(result.exitCode, 0, "should keep exit code 0 when retry succeeds");
	});

	it("keeps exit code 0 for multi-turn conversation with tool use", async () => {
		const result = await runWithEvents([
			{
				type: "message_end",
				message: {
					role: "assistant",
					stopReason: "tool_use",
					content: [
						{ type: "text", text: "Let me read that file." },
						{ type: "tool_use", id: "t1", name: "read", input: { path: "/tmp/test.ts" } },
					],
				},
			},
			{ type: "tool_execution_start", toolName: "read", args: { path: "/tmp/test.ts" } },
			{ type: "tool_execution_end", isError: false },
			{
				type: "message_end",
				message: {
					role: "assistant",
					stopReason: "end_turn",
					content: [{ type: "text", text: "Here is the file content analysis." }],
				},
			},
			{
				type: "agent_end",
				messages: [
					{
						role: "assistant",
						stopReason: "end_turn",
						content: [{ type: "text", text: "Here is the file content analysis." }],
					},
				],
			},
		]);

		assert.equal(result.exitCode, 0, "multi-turn with output should stay exit 0");
	});
});

// ════════════════════════════════════════════════════════════════════
// 6. Priority: retryExhausted takes precedence over stopReason
// ════════════════════════════════════════════════════════════════════

describe("PiRunner error detection: priority ordering", () => {
	it("retryExhausted message takes priority over stopReason=error", async () => {
		const result = await runWithEvents([
			{
				type: "auto_retry_end",
				success: false,
				attempt: 3,
				finalError: "429 rate_limit_error",
			},
			{
				type: "agent_end",
				messages: [
					{
						role: "assistant",
						stopReason: "error",
						errorMessage: "429 rate_limit_error",
						content: [],
					},
				],
			},
		]);

		assert.equal(result.exitCode, 1);
		// Should use "retries exhausted" message, not generic "Agent error"
		assert.ok(
			result.stderr.includes("retries exhausted"),
			`should use retries exhausted message, got: ${result.stderr}`,
		);
	});
});

// ════════════════════════════════════════════════════════════════════
// 7. isApiRateLimitError helper
// ════════════════════════════════════════════════════════════════════

describe("isApiRateLimitError", () => {
	it("matches PiRunner rate limit stderr", () => {
		assert.ok(isApiRateLimitError("API error — retries exhausted: 429 rate_limit_error: Too many requests\n"));
	});

	it("matches PiRunner overloaded stderr", () => {
		assert.ok(isApiRateLimitError("API error — retries exhausted: overloaded_error: Anthropic API is overloaded\n"));
	});

	it("matches PiRunner 502 stderr", () => {
		assert.ok(isApiRateLimitError("API error — retries exhausted: 502 Bad Gateway\n"));
	});

	it("matches PiRunner 503 stderr", () => {
		assert.ok(isApiRateLimitError("API error — retries exhausted: 503 Service Unavailable\n"));
	});

	it("matches PiRunner 529 stderr", () => {
		assert.ok(isApiRateLimitError("API error — retries exhausted: 529 Service Overloaded\n"));
	});

	it("matches Claude Code rate limit stderr", () => {
		assert.ok(isApiRateLimitError("rate_limit_error: Too many requests\n"));
	});

	it("matches too many requests error", () => {
		assert.ok(isApiRateLimitError("too many requests error"));
	});

	it("does NOT match auth errors", () => {
		assert.ok(!isApiRateLimitError("Agent error: authentication_error: Invalid API key\n"));
	});

	it("does NOT match context overflow", () => {
		assert.ok(!isApiRateLimitError("Agent error: Context overflow recovery failed\n"));
	});

	it("does NOT match no-output errors", () => {
		assert.ok(!isApiRateLimitError("Agent produced no output\n"));
	});

	it("does NOT match empty string", () => {
		assert.ok(!isApiRateLimitError(""));
	});

	it("does NOT match undefined-like input", () => {
		assert.ok(!isApiRateLimitError(undefined as any));
	});
});
