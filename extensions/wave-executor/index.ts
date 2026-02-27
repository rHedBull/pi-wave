/**
 * Wave Executor Extension
 *
 * Three-phase workflow with reviewable files:
 *
 *   /waves-spec <task>    — Scout + brainstorm → creates SPEC.md
 *   /waves-plan           — Reads SPEC.md → creates PLAN.md (wave-based tasks)
 *   /waves-execute        — Reads SPEC.md + PLAN.md → wave-executes with verification
 *
 * Files are written to docs/spec/ and docs/plan/ in the project directory
 * so you can review, edit, and version control them before executing.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { validateDAG } from "./dag.js";
import {
	ensureProjectDir,
	extractFinalOutput,
	extractSpecSections,
	findSpecFile,
	listWaveProjects,
	logFilePath,
	planPath,
	runSubagent,
	slugify,
	specPath,
} from "./helpers.js";
import { parsePlanV2 } from "./plan-parser.js";
import type { Plan, Task, TaskResult } from "./types.js";
import { executeWave } from "./wave-executor.js";

// ── Config ─────────────────────────────────────────────────────────

const MAX_CONCURRENCY = 12;

// ── Extension ──────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {

	// ── /waves ───────────────────────────────────────────────────────

	pi.registerCommand("waves", {
		description: "List wave projects in this repo",
		handler: async (_args, ctx) => {
			const projects = listWaveProjects(ctx.cwd);
			if (projects.length === 0) {
				ctx.ui.notify("No wave projects yet. Run /waves-spec <task> to create one.", "info");
				return;
			}

			let summary = `**Wave projects** in \`docs/spec/\` and \`docs/plan/\`:\n\n`;
			for (const name of projects) {
				const hasSpec = !!findSpecFile(ctx.cwd, name);
				const hasPlan = fs.existsSync(planPath(ctx.cwd, name));
				const hasLog = fs.existsSync(logFilePath(ctx.cwd, name));
				const icons = [
					hasSpec ? "📄 SPEC" : null,
					hasPlan ? "📋 PLAN" : null,
					hasLog ? "📝 LOG" : null,
				].filter(Boolean).join("  ");
				summary += `- **${name}**  ${icons}\n`;
			}
			summary += `\nCommands: \`/waves-spec <task>\`, \`/waves-plan <name>\`, \`/waves-execute <name>\``;

			pi.sendMessage(
				{ customType: "wave-list", content: summary, display: true },
				{ triggerTurn: false },
			);
		},
	});

	// ── /waves-spec ─────────────────────────────────────────────────

	const SCOPES = ["hack", "standard", "enterprise"] as const;
	type Scope = (typeof SCOPES)[number];

	function parseSpecArgs(args: string): { scope: Scope; query: string } | null {
		const trimmed = args.trim();
		if (!trimmed) return null;
		const firstWord = trimmed.split(/\s+/)[0].toLowerCase();
		if (SCOPES.includes(firstWord as Scope)) {
			const query = trimmed.slice(firstWord.length).trim();
			return query ? { scope: firstWord as Scope, query } : null;
		}
		return { scope: "standard", query: trimmed };
	}

	function buildBrainstormPrompt(scope: Scope, query: string, projectName: string, scoutContext: string, specFilePath: string): string {
		const scopeLabel = scope === "hack" ? "quick hack" : scope === "enterprise" ? "enterprise-grade" : "standard";

		const scopeGuidance = scope === "hack"
			? `This is a **quick hack** — keep brainstorming brief. 1-2 clarifying questions max, then propose the simplest approach and write a short spec (under 50 lines).

**Topics to cover** (briefly — skip any that are obvious from context):
- [ ] Approach: quickest path vs slightly cleaner
- [ ] Where to make the change (which files)
- [ ] What "done" looks like`
			: scope === "enterprise"
			? `This is **enterprise-grade** work. Be thorough in your exploration. Ask as many questions as needed across multiple rounds.

**Topics you MUST cover** — ask about each one if the user hasn't addressed it yet. Check them off mentally as you go. Before writing the spec, review this list and ask about any uncovered topics.

- [ ] **Problem & goal**: What problem does this solve? What's the desired outcome?
- [ ] **Users/consumers**: Who uses this? (end users, developers, internal systems)
- [ ] **Integration strategy**: Extend existing code, new module, replace, adapter, or greenfield?
- [ ] **Integration points**: Which specific files/functions/interfaces does new code hook into?
- [ ] **Legacy & compatibility**: Must preserve existing behavior? Deprecation path? Migration?
- [ ] **Legacy cleanup**: Clean up adjacent code or leave untouched?
- [ ] **Scale & performance**: Expected load? Latency requirements? Caching needs?
- [ ] **Constraints**: Backward compatibility, deadlines, dependency versions?
- [ ] **Security**: Auth changes, input validation, data exposure, rate limiting?
- [ ] **Error handling**: Error taxonomy, response format, recovery behavior, edge cases?
- [ ] **API versioning**: Versioning strategy, breaking vs non-breaking changes?
- [ ] **Testing strategy**: TDD? Unit + integration + E2E? Match existing patterns?
- [ ] **Logging & monitoring**: Log levels, structured logging, health checks, metrics, alerting?
- [ ] **CI/CD & deployment**: Pipeline changes, feature flags, rollback, migration?
- [ ] **Documentation**: API docs, ADRs, runbooks, README updates?
- [ ] **Scalability plan**: Horizontal scaling, stateless design, bottlenecks?`
			: `This is **standard** scope. Balance thoroughness with pragmatism. 3-6 clarifying questions across a few rounds.

**Topics you MUST cover** — ask about each one if the user hasn't addressed it yet. Before writing the spec, review this list and ask about any uncovered topics.

- [ ] **Goal**: What are we building and why?
- [ ] **Scope**: Minimal change, moderate (include related cleanups), or thorough (tests, docs, related code)?
- [ ] **Approach**: Propose 2-3 options with trade-offs
- [ ] **Patterns & conventions**: Follow existing codebase patterns or specific preferences?
- [ ] **Testing**: Match existing test patterns, comprehensive, minimal, or none?
- [ ] **Error handling**: How should errors be handled? Match existing patterns?
- [ ] **Affected files**: Which files need changes?`;

		return `# Brainstorming: ${query}

You are brainstorming a ${scopeLabel} feature with the user. A scout has already explored the codebase. Your job is to have a **natural, collaborative conversation** to fully understand what needs to be built before writing the spec.

## Scout Findings

${scoutContext}

## Your Process

${scopeGuidance}

**How to brainstorm:**
1. **Present the scout findings** — summarize what you found in the codebase relevant to this task
2. **Ask clarifying questions ONE AT A TIME** — don't overwhelm with multiple questions. Prefer offering 2-3 concrete options when possible, but open-ended is fine too
3. **Propose 2-3 approaches** with trade-offs and your recommendation — explain WHY you recommend one
4. **Iterate** — go back and forth until the design is clear. Be ready to revise based on feedback
5. **Before offering to write the spec**, review the topics checklist above. If any topic hasn't been discussed and is relevant, ask about it now.
6. **When all topics are covered and the user approves**, write the spec to \`${specFilePath}\`

**IMPORTANT RULES:**
- Do NOT write any implementation code. Only explore, discuss, and ultimately write the spec.
- Do NOT write the spec until the user has approved the approach. Ask "Ready for me to write the spec?" or similar.
- Ask ONE question per message. If a topic needs more exploration, break it into multiple messages.
- If the user's answer covers multiple topics at once, acknowledge that and move on — don't re-ask about things already answered.
- If a topic from the checklist is clearly not relevant (e.g., API versioning for an internal refactor), briefly note you're skipping it and why.
- When you DO write the spec, save it to \`${specFilePath}\` using the write tool.
- After writing the spec, tell the user: "Next step: \`/waves-plan ${projectName}\` to create the implementation plan."

## Spec Format (when ready to write)

${scope === "hack" ? `\`\`\`markdown
# Spec: <Title>

## What
2-3 sentences. What we're building.

## Where
- \`path/to/file.ts\` — what changes

## How
Brief approach. 5-10 lines max.

## Done When
Bullet list of what "working" looks like.
\`\`\`` : scope === "enterprise" ? `Write a comprehensive spec (200-500+ lines) covering:
- Overview, Current State, User Decisions
- Functional Requirements (20-50+), Non-Functional Requirements (10-20)
- Affected Files, API/Interface Changes, Data Model Changes
- Integration Strategy (integration points, approach, legacy considerations, dependency map)
- Error Handling Strategy (taxonomy, edge cases, error scenarios)
- Security, API Versioning, Logging & Monitoring
- CI/CD & Deployment, Documentation Plan, Scalability Plan
- Testing Criteria (unit, integration, E2E, edge case, performance)
- Migration Plan, Out of Scope, Open Questions` : `\`\`\`markdown
# Spec: <Title>

## Overview
3-5 sentences on what this feature does.

## Current State
Key files, how things work now.

## Requirements
1. FR-1: ...
(10-20 requirements)

## Affected Files
- \`path/to/file.ts\` — what changes

## API / Interface Changes
New or changed APIs, types, signatures.

## Testing Criteria
- Test that X works when Y
(5-15 test criteria)

## Out of Scope
What we're explicitly NOT doing.
\`\`\``}

Now, start by presenting the scout findings and asking your first question.`;
	}

	pi.registerCommand("waves-spec", {
		description: "Brainstorm and create a spec: /waves-spec [hack|standard|enterprise] <task>",
		handler: async (args, ctx) => {
			const parsed = parseSpecArgs(args || "");
			if (!parsed) {
				ctx.ui.notify(
					"Usage: /waves-spec [scope] <task>\n\n" +
					"Scopes:\n" +
					"  hack        — quick, 1-2 questions, minimal spec\n" +
					"  standard    — balanced, collaborative brainstorming (default)\n" +
					"  enterprise  — thorough, multi-round exploration\n\n" +
					"Examples:\n" +
					"  /waves-spec hack add a debug flag\n" +
					"  /waves-spec add OAuth2 support\n" +
					"  /waves-spec enterprise redesign the auth module",
					"info",
				);
				return;
			}

			const { scope, query } = parsed;
			const scopeEmoji = scope === "hack" ? "⚡" : scope === "enterprise" ? "🏢" : "📋";
			const projectName = slugify(query);
			ensureProjectDir(ctx.cwd, projectName);

			// Phase 1: Scout
			ctx.ui.setStatus("waves", ctx.ui.theme.fg("warning", `🔍 [${projectName}] Scouting...`));
			const scoutDepth = scope === "hack" ? "Quick" : scope === "enterprise" ? "Thorough" : "Medium";
			const enterpriseExtra = scope === "enterprise"
				? `\n\nIMPORTANT — Enterprise mode: In addition to standard scouting, you MUST also:\n- Identify and propose specific integration points: exact files, functions, interfaces, and classes where new code should hook into existing code\n- Map the dependency graph around the affected area: what depends on this code, what does it depend on\n- Flag legacy code that may need replacing, wrapping, or deprecating\n- Note existing abstractions/interfaces that new code should implement or extend\n- Include a section "## Proposed Integration Points" in your output listing each point with file path, function/class, and how to integrate`
				: "";
			const scoutResult = await runSubagent("scout", `${scoutDepth} investigation: ${query}${enterpriseExtra}`, ctx.cwd, undefined, { readOnly: true, safeBashOnly: true });
			const scoutOutput = extractFinalOutput(scoutResult.stdout);

			if (scoutResult.exitCode !== 0 || !scoutOutput) {
				ctx.ui.setStatus("waves", undefined);
				ctx.ui.notify("Scout failed: " + (scoutResult.stderr || "no output"), "error");
				return;
			}
			ctx.ui.setStatus("waves", undefined);

			// Phase 2: Brainstorm
			const file = specPath(ctx.cwd, projectName);
			const relFile = path.relative(ctx.cwd, file);

			const brainstormPrompt = buildBrainstormPrompt(scope, query, projectName, scoutOutput, relFile);

			ctx.ui.notify(`${scopeEmoji} Scout complete. Starting brainstorming session...`, "info");

			pi.sendMessage(
				{
					customType: "wave-brainstorm",
					content: brainstormPrompt,
					display: false,
				},
				{
					triggerTurn: true,
					deliverAs: "followUp",
				},
			);
		},
	});

	// ── /waves-plan ──────────────────────────────────────────────────

	pi.registerCommand("waves-plan", {
		description: "Create PLAN.md for a wave project (e.g. /waves-plan my-spec.md or /waves-plan project-name)",
		handler: async (args, ctx) => {
			let projectName: string;
			let extraInstructions: string;
			let spec: string;

			if (!args?.trim()) {
				// No args: try to find a spec in cwd or list known projects
				const cwdSpec = findSpecFile(ctx.cwd, "SPEC.md");
				if (cwdSpec) {
					projectName = slugify(path.basename(ctx.cwd));
					extraInstructions = "";
					spec = cwdSpec;
				} else {
					const projects = listWaveProjects(ctx.cwd);
					const ready = projects.filter((p) =>
						findSpecFile(ctx.cwd, p) && !fs.existsSync(planPath(ctx.cwd, p))
					);
					if (ready.length > 0) {
						ctx.ui.notify(`Usage: /waves-plan <name-or-file>\nReady for planning: ${ready.join(", ")}`, "info");
					} else if (projects.length > 0) {
						ctx.ui.notify(`Usage: /waves-plan <name-or-file> [extra instructions]\nProjects: ${projects.join(", ")}`, "info");
					} else {
						ctx.ui.notify("No spec files found. Run /waves-spec <task> or provide a path to a spec file.", "info");
					}
					return;
				}
			} else {
				const parts = args.trim().split(/\s+/);
				const firstArg = parts[0];
				extraInstructions = parts.slice(1).join(" ");

				// Try to find a spec file from the argument
				const found = findSpecFile(ctx.cwd, firstArg);
				if (found) {
					spec = found;
					// Derive project name from the spec file or argument
					const basename = path.basename(found, ".md").replace(/[-_]?spec[-_]?/gi, "").replace(/^-+|-+$/g, "");
					projectName = slugify(basename || path.basename(path.dirname(found)));
				} else {
					ctx.ui.notify(
						`No spec file found for "${firstArg}". Looked for:\n` +
						`  • ${firstArg} (as file path)\n` +
						`  • docs/spec/${slugify(firstArg)}/SPEC.md\n` +
						`  • docs/spec/${slugify(firstArg)}/*.md\n` +
						`  • docs/spec/${slugify(firstArg)}.md\n\n` +
						`Run /waves-spec <task> or provide a path to a spec file.`,
						"error",
					);
					return;
				}
			}

			const extra = extraInstructions ? `\n\nAdditional instructions: ${extraInstructions}` : "";

			ctx.ui.setStatus("waves", ctx.ui.theme.fg("warning", `📋 [${projectName}] Planning...`));
			ensureProjectDir(ctx.cwd, projectName);
			const file = planPath(ctx.cwd, projectName);
			const relSpec = path.relative(ctx.cwd, spec);
			const relPlan = path.relative(ctx.cwd, file);

			const planTask = `Read the spec at \`${relSpec}\` and create a wave-based implementation plan.${extra}

IMPORTANT: Write the plan directly to the file \`${relPlan}\`.
Use the read tool to read the spec file first, then use the write tool to create the plan file.
You can read it back to verify the format is correct.`;

			const planResult = await runSubagent("wave-planner", planTask, ctx.cwd, undefined, {
				allowWrite: [file],
				safeBashOnly: true,
			});

			ctx.ui.setStatus("waves", undefined);

			if (planResult.exitCode !== 0) {
				ctx.ui.notify("Planner failed: " + (planResult.stderr || "no output"), "error");
				return;
			}

			if (!fs.existsSync(file)) {
				ctx.ui.notify("Planner did not create PLAN.md", "error");
				return;
			}

			const planContent = fs.readFileSync(file, "utf-8");
			const plan = parsePlanV2(planContent);

			// Count tasks across all sections
			const totalTasks = plan.waves.reduce(
				(s, w) => s + w.foundation.length + w.features.reduce((fs2, f) => fs2 + f.tasks.length, 0) + w.integration.length,
				0,
			);

			let summary = `📋 **${projectName}/PLAN.md** created → \`${relPlan}\`\n\n`;
			summary += `**${plan.waves.length} waves, ${totalTasks} tasks**\n\n`;

			for (const wave of plan.waves) {
				const allTasks = [
					...wave.foundation,
					...wave.features.flatMap((f) => f.tasks),
					...wave.integration,
				];
				const testCount = allTasks.filter((t) => t.agent === "test-writer").length;
				const implCount = allTasks.filter((t) => t.agent === "worker").length;
				const verifyCount = allTasks.filter((t) => t.agent === "wave-verifier").length;
				const parts2: string[] = [];
				if (testCount) parts2.push(`🧪 ${testCount} test`);
				if (implCount) parts2.push(`🔨 ${implCount} impl`);
				if (verifyCount) parts2.push(`🔍 ${verifyCount} verify`);

				const featureNames = wave.features
					.filter((f) => f.name !== "default")
					.map((f) => f.name);
				const featureInfo = featureNames.length > 0
					? ` — features: ${featureNames.join(", ")}`
					: "";

				summary += `- **${wave.name}**: ${parts2.join(", ")}${featureInfo}\n`;
			}
			summary += `\nReview and edit, then run \`/waves-execute ${projectName}\``;

			pi.sendMessage(
				{ customType: "wave-plan", content: summary, display: true },
				{ triggerTurn: false },
			);

			ctx.ui.notify(`PLAN.md → ${relPlan} — ${plan.waves.length} waves, ${totalTasks} tasks. Next: /waves-execute ${projectName}`, "info");
		},
	});

	// ── /waves-execute ───────────────────────────────────────────────

	pi.registerCommand("waves-execute", {
		description: "Execute a wave project's PLAN.md (e.g. /waves-execute project-name)",
		handler: async (args, ctx) => {
			if (!args?.trim()) {
				const projects = listWaveProjects(ctx.cwd);
				const ready = projects.filter((p) =>
					findSpecFile(ctx.cwd, p) && fs.existsSync(planPath(ctx.cwd, p))
				);
				if (ready.length > 0) {
					ctx.ui.notify(`Usage: /waves-execute <name>\nReady to execute: ${ready.join(", ")}`, "info");
				} else {
					ctx.ui.notify("No projects ready. Run /waves-spec then /waves-plan first.", "info");
				}
				return;
			}

			const projectName = slugify(args.trim());
			const spec = findSpecFile(ctx.cwd, projectName);
			const planFile = planPath(ctx.cwd, projectName);

			if (!spec) {
				ctx.ui.notify(`No spec file found for "${projectName}". Run /waves-spec <task> first.`, "error");
				return;
			}
			if (!fs.existsSync(planFile)) {
				ctx.ui.notify(`No PLAN.md for "${projectName}". Run /waves-plan ${projectName} first.`, "error");
				return;
			}

			const specContent = fs.readFileSync(spec, "utf-8");
			const planContent = fs.readFileSync(planFile, "utf-8");
			const plan = parsePlanV2(planContent);

			if (plan.waves.length === 0) {
				ctx.ui.notify("PLAN.md has no waves. Check the format or run /waves-plan again.", "error");
				return;
			}

			// Validate all DAGs
			for (const wave of plan.waves) {
				for (const section of ["foundation", "integration"] as const) {
					const tasks = wave[section];
					if (tasks.length > 0) {
						const v = validateDAG(tasks);
						if (!v.valid) {
							ctx.ui.notify(`DAG validation error in ${wave.name} ${section}: ${v.error}`, "error");
							return;
						}
					}
				}
				for (const feature of wave.features) {
					const v = validateDAG(feature.tasks);
					if (!v.valid) {
						ctx.ui.notify(`DAG validation error in ${wave.name} feature "${feature.name}": ${v.error}`, "error");
						return;
					}
				}
			}

			// Count tasks
			const totalTasks = plan.waves.reduce(
				(s, w) => s + w.foundation.length + w.features.reduce((fs2, f) => fs2 + f.tasks.length, 0) + w.integration.length,
				0,
			);

			const allTasks = plan.waves.flatMap((w) => [
				...w.foundation,
				...w.features.flatMap((f) => f.tasks),
				...w.integration,
			]);
			const testTasks = allTasks.filter((t) => t.agent === "test-writer").length;
			const implTasks = allTasks.filter((t) => t.agent === "worker").length;
			const verifyTasks = allTasks.filter((t) => t.agent === "wave-verifier").length;

			// Build preview
			let preview = `**${plan.goal || "Implementation"}**\n`;
			preview += `${plan.waves.length} waves, ${totalTasks} tasks (🧪 ${testTasks} test, 🔨 ${implTasks} impl, 🔍 ${verifyTasks} verify)\n`;
			preview += `Up to ${MAX_CONCURRENCY} parallel agents\n\n`;
			for (const wave of plan.waves) {
				const wTasks = [
					...wave.foundation,
					...wave.features.flatMap((f) => f.tasks),
					...wave.integration,
				];
				const tc = wTasks.filter((t) => t.agent === "test-writer").length;
				const ic = wTasks.filter((t) => t.agent === "worker").length;
				const vc = wTasks.filter((t) => t.agent === "wave-verifier").length;
				const parts: string[] = [];
				if (tc) parts.push(`🧪${tc}`);
				if (ic) parts.push(`🔨${ic}`);
				if (vc) parts.push(`🔍${vc}`);
				const featureNames = wave.features
					.filter((f) => f.name !== "default")
					.map((f) => f.name);
				const fInfo = featureNames.length > 0
					? ` [${featureNames.join(", ")}]`
					: "";
				preview += `• ${wave.name}: ${parts.join(" ")}${fInfo}\n`;
			}

			const ok = await ctx.ui.confirm("Execute wave plan?", preview);
			if (!ok) {
				ctx.ui.notify("Execution cancelled.", "info");
				return;
			}

			const controller = new AbortController();
			const waveResults: import("./types.js").WaveResult[] = [];
			let allPassed = true;
			let totalCompleted = 0;

			// Execution log
			const logPath = logFilePath(ctx.cwd, projectName);
			const logLines: string[] = [
				`# Execution Log`,
				``,
				`Started: ${new Date().toISOString()}`,
				`Spec: SPEC.md`,
				`Plan: PLAN.md`,
				`Architecture: feature-parallel DAG`,
				``,
			];
			const writeLog = () => fs.writeFileSync(logPath, logLines.join("\n"), "utf-8");

			// Protected paths
			const protectedPaths = [spec, planFile];

			for (let wi = 0; wi < plan.waves.length; wi++) {
				const wave = plan.waves[wi];
				const waveLabel = `Wave ${wi + 1}/${plan.waves.length}: ${wave.name}`;
				const waveTasks = [
					...wave.foundation,
					...wave.features.flatMap((f) => f.tasks),
					...wave.integration,
				];

				ctx.ui.setStatus("waves", ctx.ui.theme.fg("accent", `⚡ ${waveLabel}`));
				logLines.push(`## ${waveLabel}`, "");

				// Progress widget
				let completed = 0;
				const taskStatuses = new Map<string, "pending" | "running" | "done" | "failed" | "skipped">();
				for (const t of waveTasks) taskStatuses.set(t.id, "pending");

				const updateWidget = () => {
					const lines: string[] = [
						ctx.ui.theme.fg("accent", `⚡ ${waveLabel} — ${completed}/${waveTasks.length} done`),
					];

					// Foundation tasks
					if (wave.foundation.length > 0) {
						lines.push(ctx.ui.theme.fg("dim", "  Foundation:"));
						for (const t of wave.foundation) {
							lines.push(`    ${statusIcon(ctx, taskStatuses.get(t.id)!)} ${agentTag(t)} ${t.id}: ${t.title}`);
						}
					}

					// Feature tasks
					for (const feature of wave.features) {
						if (feature.name !== "default") {
							lines.push(ctx.ui.theme.fg("dim", `  Feature: ${feature.name}`));
						}
						for (const t of feature.tasks) {
							const indent = feature.name !== "default" ? "    " : "  ";
							lines.push(`${indent}${statusIcon(ctx, taskStatuses.get(t.id)!)} ${agentTag(t)} ${t.id}: ${t.title}`);
						}
					}

					// Integration tasks
					if (wave.integration.length > 0) {
						lines.push(ctx.ui.theme.fg("dim", "  Integration:"));
						for (const t of wave.integration) {
							lines.push(`    ${statusIcon(ctx, taskStatuses.get(t.id)!)} ${agentTag(t)} ${t.id}: ${t.title}`);
						}
					}

					const overallDone = totalCompleted + completed;
					lines.push("");
					lines.push(ctx.ui.theme.fg("dim", `Overall: ${overallDone}/${totalTasks} tasks`));
					ctx.ui.setWidget("wave-progress", lines);
				};

				updateWidget();

				// Execute the wave
				const waveResult = await executeWave({
					wave,
					waveNum: wi + 1,
					specContent,
					protectedPaths,
					cwd: ctx.cwd,
					maxConcurrency: MAX_CONCURRENCY,
					signal: controller.signal,
					onProgress: (update) => {
						// Update feature statuses
						if (update.features) {
							for (const f of update.features) {
								// Visual cue in the widget — handled per-task
							}
						}
						updateWidget();
					},
					onTaskStart: (phase, task) => {
						taskStatuses.set(task.id, "running");
						updateWidget();
					},
					onTaskEnd: (phase, task, result) => {
						taskStatuses.set(task.id,
							result.exitCode === 0 ? "done" :
							result.exitCode === -1 ? "skipped" : "failed"
						);
						completed++;
						updateWidget();
					},
					onLog: (line) => logLines.push(line),
				});

				totalCompleted += completed;
				waveResults.push(waveResult);

				if (!waveResult.passed) {
					allPassed = false;

					// Report failures
					const failedTasks = [
						...waveResult.foundationResults,
						...waveResult.featureResults.flatMap((f) => f.taskResults),
						...waveResult.integrationResults,
					].filter((r) => r.exitCode !== 0 && r.exitCode !== -1);

					if (failedTasks.length > 0) {
						const failMsg = failedTasks.map((t) => `  - ${t.id}: ${t.title}`).join("\n");
						pi.sendMessage(
							{
								customType: "wave-task-failures",
								content: `❌ **${wave.name}** failed:\n${failMsg}`,
								display: true,
							},
							{ triggerTurn: false },
						);
					}

					// Report failed features
					const failedFeatures = waveResult.featureResults.filter((f) => !f.passed);
					if (failedFeatures.length > 0) {
						const fMsg = failedFeatures.map((f) =>
							`  - Feature "${f.name}": ${f.error || "task failures"}`
						).join("\n");
						pi.sendMessage(
							{
								customType: "wave-feature-failures",
								content: `⚠️ **${wave.name}** — ${failedFeatures.length} feature(s) failed:\n${fMsg}`,
								display: true,
							},
							{ triggerTurn: false },
						);
					}
				} else {
					const allResults = [
						...waveResult.foundationResults,
						...waveResult.featureResults.flatMap((f) => f.taskResults),
						...waveResult.integrationResults,
					];
					const passCount = allResults.filter((r) => r.exitCode === 0).length;
					pi.sendMessage(
						{
							customType: "wave-pass",
							content: `✅ **${wave.name}** — ${passCount}/${allResults.length} tasks passed`,
							display: true,
						},
						{ triggerTurn: false },
					);
				}

				writeLog();
			}

			// Final summary
			ctx.ui.setWidget("wave-progress", undefined);

			logLines.push("---", "", `Finished: ${new Date().toISOString()}`);
			logLines.push(`Result: ${allPassed ? "SUCCESS" : "COMPLETED WITH ISSUES"}`);
			writeLog();

			const icon = allPassed ? "✅" : "⚠️";
			let finalSummary = `# ${icon} Execution Complete\n\n`;
			finalSummary += `**Goal:** ${plan.goal}\n`;
			finalSummary += `**Tasks:** ${totalCompleted}/${totalTasks}\n`;
			finalSummary += `**Waves:** ${waveResults.length}/${plan.waves.length}\n\n`;

			for (const wr of waveResults) {
				const allResults = [
					...wr.foundationResults,
					...wr.featureResults.flatMap((f) => f.taskResults),
					...wr.integrationResults,
				];
				const passed = allResults.filter((r) => r.exitCode === 0).length;
				const wIcon = wr.passed ? "✅" : "❌";
				const featureInfo = wr.featureResults.length > 0
					? ` (${wr.featureResults.filter((f) => f.passed).length}/${wr.featureResults.length} features)`
					: "";
				finalSummary += `${wIcon} **${wr.wave}**: ${passed}/${allResults.length} tasks${featureInfo}\n`;
			}

			finalSummary += `\n📄 Execution log: \`${path.relative(ctx.cwd, logPath)}\``;

			pi.sendMessage(
				{ customType: "wave-complete", content: finalSummary, display: true },
				{ triggerTurn: false },
			);

			ctx.ui.setStatus("waves", allPassed
				? ctx.ui.theme.fg("success", `✅ Done — ${totalCompleted} tasks`)
				: ctx.ui.theme.fg("warning", `⚠️ Done (issues) — ${totalCompleted} tasks`),
			);
			setTimeout(() => ctx.ui.setStatus("waves", undefined), 15000);
		},
	});
}

// ── Widget Helpers ─────────────────────────────────────────────────

function statusIcon(ctx: any, status: string): string {
	switch (status) {
		case "done": return ctx.ui.theme.fg("success", "✓");
		case "failed": return ctx.ui.theme.fg("error", "✗");
		case "running": return ctx.ui.theme.fg("warning", "⏳");
		case "skipped": return ctx.ui.theme.fg("muted", "⏭");
		default: return ctx.ui.theme.fg("muted", "○");
	}
}

function agentTag(t: Task): string {
	return t.agent === "test-writer" ? "🧪" : t.agent === "wave-verifier" ? "🔍" : "🔨";
}
