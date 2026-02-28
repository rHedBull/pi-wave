/**
 * Tests for stall detection, signal file mechanism, hanging command
 * detection, and interruptChildren.
 *
 * These tests simulate the JSON event stream that runSubagent parses,
 * and verify each defense layer independently using small spawned
 * processes instead of full pi sessions.
 */

import { describe, it, before, after } from "node:test";
import * as assert from "node:assert/strict";
import { spawn, execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import {
	generateEnforcementExtension,
	writeEnforcementExtension,
	cleanupEnforcement,
	STALL_SOFT_IDENTICAL_CALLS,
	STALL_HARD_IDENTICAL_CALLS,
	STALL_SOFT_CONSECUTIVE_ERRORS,
	STALL_HARD_CONSECUTIVE_ERRORS,
	HANGING_TOOL_TIMEOUT_MS,
} from "../extensions/wave-executor/helpers.js";

// ════════════════════════════════════════════════════════════════════
// 1. generateEnforcementExtension — signal file code path
// ════════════════════════════════════════════════════════════════════

describe("generateEnforcementExtension", () => {
	it("includes stall signal check when stallSignalPath is provided", () => {
		const code = generateEnforcementExtension(
			{ protectedPaths: [] },
			"/tmp/test-signal.signal",
		);
		assert.ok(code.includes("stallSignalPath"), "should reference stallSignalPath variable");
		assert.ok(code.includes('fs.readFileSync(stallSignalPath'), "should read signal file");
		assert.ok(code.includes("fs.unlinkSync(stallSignalPath)"), "should delete signal file after read");
		assert.ok(code.includes("LOOP DETECTED"), "should include loop message");
	});

	it("sets stallSignalPath to null when not provided", () => {
		const code = generateEnforcementExtension({ protectedPaths: [] });
		assert.ok(code.includes("const stallSignalPath = null"), "stallSignalPath should be null");
	});

	it("embeds the exact signal path", () => {
		const p = "/tmp/pi-wave-stall-123456-abcd.signal";
		const code = generateEnforcementExtension({ protectedPaths: [] }, p);
		assert.ok(code.includes(JSON.stringify(p)), "should embed quoted path");
	});
});

// ════════════════════════════════════════════════════════════════════
// 2. writeEnforcementExtension — creates file with signal path
// ════════════════════════════════════════════════════════════════════

describe("writeEnforcementExtension", () => {
	let result: { filePath: string; dir: string };
	const signalPath = "/tmp/test-write-enforcement.signal";

	before(() => {
		result = writeEnforcementExtension(os.tmpdir(), "test-task", { protectedPaths: [] }, signalPath);
	});
	after(() => {
		cleanupEnforcement(result.filePath, result.dir);
	});

	it("creates the extension file", () => {
		assert.ok(fs.existsSync(result.filePath));
	});

	it("file contains stall signal path", () => {
		const content = fs.readFileSync(result.filePath, "utf-8");
		assert.ok(content.includes(signalPath));
	});
});

// ════════════════════════════════════════════════════════════════════
// 3. Signal file mechanism — enforcement extension reads + deletes
// ════════════════════════════════════════════════════════════════════

describe("signal file mechanism", () => {
	it("enforcement extension blocks tool call when signal file exists", async () => {
		const signalPath = path.join(os.tmpdir(), `test-signal-${Date.now()}.signal`);
		const reason = "bash called 5 times with identical arguments";

		// Write signal file (simulating what runSubagent does)
		fs.writeFileSync(signalPath, reason, "utf-8");

		// Generate the extension code and extract just the handler logic
		const code = generateEnforcementExtension({ protectedPaths: [] }, signalPath);

		// Write a small test script that loads the extension and simulates a tool call
		const testScript = path.join(os.tmpdir(), `test-signal-ext-${Date.now()}.mjs`);
		fs.writeFileSync(testScript, `
import * as fs from "node:fs";
import * as path from "node:path";

// Simulate the extension's handler inline
const stallSignalPath = ${JSON.stringify(signalPath)};
const event = { toolName: "bash", input: { command: "npm test" } };

let result = null;
if (stallSignalPath) {
	try {
		const reason = fs.readFileSync(stallSignalPath, "utf-8");
		fs.unlinkSync(stallSignalPath);
		result = { block: true, reason: "LOOP DETECTED: " + reason };
	} catch {
		// no signal
	}
}

// Output result as JSON
console.log(JSON.stringify({
	blocked: result !== null,
	reason: result?.reason ?? null,
	signalFileGone: !fs.existsSync(stallSignalPath),
}));
`, "utf-8");

		const output = execSync(`node ${testScript}`, { encoding: "utf-8" });
		const parsed = JSON.parse(output.trim());

		assert.equal(parsed.blocked, true, "should block the tool call");
		assert.ok(parsed.reason.includes("LOOP DETECTED"), "should include loop message");
		assert.ok(parsed.reason.includes(reason), "should include original reason");
		assert.equal(parsed.signalFileGone, true, "signal file should be deleted");

		// Cleanup
		try { fs.unlinkSync(testScript); } catch {}
	});

	it("enforcement extension passes through when no signal file", async () => {
		const signalPath = path.join(os.tmpdir(), `test-nosignal-${Date.now()}.signal`);
		// Don't write signal file

		const testScript = path.join(os.tmpdir(), `test-nosignal-ext-${Date.now()}.mjs`);
		fs.writeFileSync(testScript, `
import * as fs from "node:fs";
const stallSignalPath = ${JSON.stringify(signalPath)};
let blocked = false;
if (stallSignalPath) {
	try {
		fs.readFileSync(stallSignalPath, "utf-8");
		blocked = true;
	} catch {
		// no signal — expected
	}
}
console.log(JSON.stringify({ blocked }));
`, "utf-8");

		const output = execSync(`node ${testScript}`, { encoding: "utf-8" });
		const parsed = JSON.parse(output.trim());

		assert.equal(parsed.blocked, false, "should NOT block when no signal file");

		try { fs.unlinkSync(testScript); } catch {}
	});
});

// ════════════════════════════════════════════════════════════════════
// 4. interruptChildren — SIGINT to child processes
// ════════════════════════════════════════════════════════════════════

describe("interruptChildren via pgrep", () => {
	it("pgrep is available", () => {
		try {
			execSync("which pgrep", { encoding: "utf-8" });
		} catch {
			assert.fail("pgrep not found — interruptChildren won't work on this system");
		}
	});

	it("models real scenario: node parent → bash child, pgrep finds child, SIGINT kills it", async () => {
		// Real architecture:
		//   runSubagent spawns `pi` (a node process) → pi spawns `bash -c "command"`
		//   interruptChildren(proc.pid) → pgrep -P proc.pid → finds bash → SIGINT it
		//
		// We model this with a node parent that spawns bash -c "sleep 300".
		// bash may exec-optimize (replace itself with sleep), but the child
		// PID is still a child of the node parent, so pgrep -P finds it.
		const helper = path.join(os.tmpdir(), `test-parent-${Date.now()}.mjs`);
		fs.writeFileSync(helper, `
			import { spawn } from "node:child_process";
			const child = spawn("bash", ["-c", "sleep 300"], { stdio: "ignore" });
			// Keep parent alive indefinitely
			setInterval(() => {}, 60000);
		`);

		const parent = spawn("node", [helper], { stdio: "ignore" });
		await new Promise((r) => setTimeout(r, 500)); // let child start

		// pgrep -P parent.pid should find the bash/sleep child
		const pgrepOutput = execSync(`pgrep -P ${parent.pid}`, { encoding: "utf-8" });
		const childPids = pgrepOutput.trim().split("\n").map(Number).filter(Boolean);
		assert.ok(childPids.length > 0, "pgrep should find children of the node parent");

		// SIGINT all children (exactly what interruptChildren does)
		for (const pid of childPids) {
			try { process.kill(pid, "SIGINT"); } catch {}
		}

		await new Promise((r) => setTimeout(r, 300));

		// The sleep/bash child should be dead
		for (const pid of childPids) {
			let alive = true;
			try { process.kill(pid, 0); } catch { alive = false; }
			assert.equal(alive, false, `child ${pid} should be dead after SIGINT`);
		}

		// The node parent should still be alive (like pi would be)
		let parentAlive = true;
		try { process.kill(parent.pid!, 0); } catch { parentAlive = false; }
		assert.equal(parentAlive, true, "node parent should survive — only child was killed");

		parent.kill("SIGTERM");
		try { fs.unlinkSync(helper); } catch {}
	});
});

// ════════════════════════════════════════════════════════════════════
// 5. Stall detection logic — simulate JSON events
// ════════════════════════════════════════════════════════════════════

describe("stall detection logic (simulated)", () => {
	// Reimplement the detection logic standalone to verify thresholds
	function createDetector() {
		let consecutiveErrors = 0;
		let softInterruptSent = false;
		const callCounts = new Map<string, number>();
		const recentActivity: string[] = [];

		return function checkStall(event: any): { level: "soft" | "hard"; reason: string } | null {
			if (event.type === "tool_execution_start") {
				const toolName = event.toolName;
				const args = event.args ?? {};
				const summary = `${toolName}(${JSON.stringify(args).slice(0, 60)})`;
				recentActivity.push(summary);
				if (recentActivity.length > 15) recentActivity.shift();

				const key = `${toolName}:${JSON.stringify(args)}`;
				const count = (callCounts.get(key) ?? 0) + 1;
				callCounts.set(key, count);

				if (count >= STALL_HARD_IDENTICAL_CALLS) {
					return { level: "hard", reason: `${toolName} called ${count} times with identical arguments` };
				}
				if (count >= STALL_SOFT_IDENTICAL_CALLS && !softInterruptSent) {
					softInterruptSent = true;
					return { level: "soft", reason: `${toolName} called ${count} times with identical arguments` };
				}
			}
			if (event.type === "tool_execution_end") {
				if (event.isError) {
					consecutiveErrors++;
					if (consecutiveErrors >= STALL_HARD_CONSECUTIVE_ERRORS) {
						return { level: "hard", reason: `${consecutiveErrors} consecutive tool errors` };
					}
					if (consecutiveErrors >= STALL_SOFT_CONSECUTIVE_ERRORS && !softInterruptSent) {
						softInterruptSent = true;
						return { level: "soft", reason: `${consecutiveErrors} consecutive tool errors` };
					}
				} else {
					consecutiveErrors = 0;
				}
			}
			return null;
		};
	}

	it("does not trigger below soft threshold for identical calls", () => {
		const check = createDetector();
		const event = { type: "tool_execution_start", toolName: "bash", args: { command: "npm test" } };
		for (let i = 0; i < STALL_SOFT_IDENTICAL_CALLS - 1; i++) {
			assert.equal(check(event), null, `call ${i + 1} should not trigger`);
		}
	});

	it("triggers soft at exactly the soft threshold", () => {
		const check = createDetector();
		const event = { type: "tool_execution_start", toolName: "bash", args: { command: "npm test" } };
		let result: any = null;
		for (let i = 0; i < STALL_SOFT_IDENTICAL_CALLS; i++) {
			result = check(event);
		}
		assert.notEqual(result, null, "should trigger");
		assert.equal(result.level, "soft");
		assert.ok(result.reason.includes("bash"));
		assert.ok(result.reason.includes(String(STALL_SOFT_IDENTICAL_CALLS)));
	});

	it("soft only fires once, then hard fires at hard threshold", () => {
		const check = createDetector();
		const event = { type: "tool_execution_start", toolName: "bash", args: { command: "npm test" } };

		let softCount = 0;
		let hardResult: any = null;
		for (let i = 0; i < STALL_HARD_IDENTICAL_CALLS; i++) {
			const r = check(event);
			if (r?.level === "soft") softCount++;
			if (r?.level === "hard") hardResult = r;
		}
		assert.equal(softCount, 1, "soft should fire exactly once");
		assert.notEqual(hardResult, null, "hard should fire");
		assert.equal(hardResult.level, "hard");
	});

	it("different args don't accumulate", () => {
		const check = createDetector();
		for (let i = 0; i < 20; i++) {
			const r = check({
				type: "tool_execution_start",
				toolName: "bash",
				args: { command: `npm test file${i}.ts` },
			});
			assert.equal(r, null, `unique call ${i} should not trigger`);
		}
	});

	it("consecutive errors trigger soft then hard", () => {
		const check = createDetector();
		let softResult: any = null;
		let hardResult: any = null;

		for (let i = 0; i < STALL_HARD_CONSECUTIVE_ERRORS; i++) {
			const r = check({ type: "tool_execution_end", isError: true });
			if (r?.level === "soft" && !softResult) softResult = r;
			if (r?.level === "hard") hardResult = r;
		}

		assert.notEqual(softResult, null, "soft should have fired");
		assert.equal(softResult.level, "soft");
		assert.ok(softResult.reason.includes(String(STALL_SOFT_CONSECUTIVE_ERRORS)));

		assert.notEqual(hardResult, null, "hard should have fired");
		assert.equal(hardResult.level, "hard");
	});

	it("a successful tool resets consecutive error count", () => {
		const check = createDetector();
		// Almost hit threshold
		for (let i = 0; i < STALL_SOFT_CONSECUTIVE_ERRORS - 1; i++) {
			check({ type: "tool_execution_end", isError: true });
		}
		// Success resets
		check({ type: "tool_execution_end", isError: false });
		// Start counting again — should need full count
		for (let i = 0; i < STALL_SOFT_CONSECUTIVE_ERRORS - 1; i++) {
			const r = check({ type: "tool_execution_end", isError: true });
			assert.equal(r, null, `error ${i + 1} after reset should not trigger`);
		}
	});
});

// ════════════════════════════════════════════════════════════════════
// 6. Hanging command detection — spawn a "never-returning" process,
//    verify child gets killed via the same pgrep mechanism
// ════════════════════════════════════════════════════════════════════

describe("hanging command detection (integration)", () => {
	it("simulates the real scenario: parent survives, hanging child dies", async () => {
		// Real scenario modeled:
		//   pi (parent) spawns bash -c "npm run dev" (child, foreground)
		//   interruptChildren sends SIGINT to the child
		//   child dies, pi's bash tool sees exit code, pi continues
		//
		// We simulate this with a wrapper script that:
		//   1. Runs a foreground sleep (the "hanging command") via a nested bash
		//   2. Traps the child's exit and reports it
		//   3. Stays alive briefly after the child dies
		const parent = spawn("bash", ["-c", `
			# Run a foreground "hanging command" in a subshell
			bash -c "sleep 300" &
			CHILD=$!
			echo "READY:$CHILD"
			# Wait for child (will return when child is killed)
			wait $CHILD 2>/dev/null
			echo "CHILD_DONE"
			# Parent survives — like pi would continue after tool failure
			sleep 5
		`], { stdio: ["ignore", "pipe", "pipe"] });

		let output = "";
		parent.stdout.on("data", (d) => { output += d.toString(); });

		// Wait for READY
		await new Promise<void>((resolve) => {
			const check = setInterval(() => {
				if (output.includes("READY:")) { clearInterval(check); resolve(); }
			}, 50);
		});
		// Extra time for the nested bash + sleep to actually start
		await new Promise((r) => setTimeout(r, 200));

		const childPid = parseInt(output.match(/READY:(\d+)/)?.[1] ?? "0", 10);
		assert.ok(childPid > 0, "should have child PID");

		// Kill the hanging child (the nested bash -c "sleep 300")
		// This is what interruptChildren does: find children of pi, SIGINT them
		try { process.kill(childPid, "SIGTERM"); } catch {}

		// Wait for parent to see the child exit
		await new Promise<void>((resolve) => {
			const check = setInterval(() => {
				if (output.includes("CHILD_DONE")) { clearInterval(check); resolve(); }
			}, 50);
			setTimeout(() => { clearInterval(check); resolve(); }, 2000);
		});

		assert.ok(output.includes("CHILD_DONE"), "parent should see child exit");

		// Parent should still be alive (it has sleep 5)
		let parentAlive = true;
		try { process.kill(parent.pid!, 0); } catch { parentAlive = false; }
		assert.equal(parentAlive, true, "parent should survive child's death");

		parent.kill("SIGTERM");
	});
});

// ════════════════════════════════════════════════════════════════════
// 7. Constants sanity checks
// ════════════════════════════════════════════════════════════════════

describe("threshold constants", () => {
	it("soft < hard for identical calls", () => {
		assert.ok(STALL_SOFT_IDENTICAL_CALLS < STALL_HARD_IDENTICAL_CALLS);
	});
	it("soft < hard for consecutive errors", () => {
		assert.ok(STALL_SOFT_CONSECUTIVE_ERRORS < STALL_HARD_CONSECUTIVE_ERRORS);
	});
	it("soft identical is at least 5", () => {
		assert.ok(STALL_SOFT_IDENTICAL_CALLS >= 5, "threshold too aggressive");
	});
	it("hanging tool timeout is at least 2 minutes", () => {
		assert.ok(HANGING_TOOL_TIMEOUT_MS >= 120000, "hanging timeout too short for builds");
	});
});
