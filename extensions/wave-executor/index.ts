/**
 * Wave Executor Extension
 *
 * Three-phase workflow with reviewable files:
 *
 *   /waves-spec <task>    — Scout + brainstorm → creates SPEC.md
 *   /waves-plan           — Reads SPEC.md → creates PLAN.md (wave-based tasks)
 *   /waves-execute        — Reads SPEC.md + PLAN.md → wave-executes with verification
 *   /waves-continue       — Resume a failed execution from where it left off
 *
 * Files live in .pi/waves/<project>/ with versioned names:
 *   spec-v1.md, plan-v1.md, execution-v1.md, logs-v1/, state.json
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { validatePlan } from "./dag.js";
import { runWaveExecution } from "./execution-runner.js";
import {
	allVersions,
	createTaskLogDir,
	ensureProjectDir,
	extractFinalOutput,
	extractSpecRef,
	findPlanFile,
	findSpecFile,
	listWaveProjects,
	logFilePath,
	migrateLooseFiles,
	planPath,
	projectDir,
	projectSummary,
	resolveProject,
	runSubagent,
	slugify,
	specPath,
} from "./helpers.js";
import { parsePlanV2 } from "./plan-parser.js";
import { buildBrainstormPrompt, buildPlanReviewPrompt, parseSpecArgs } from "./prompts.js";
import {
	completedTaskIds,
	createInitialState,
	readState,
	stateFilePath,
	writeState,
} from "./state.js";
import type { Plan } from "./types.js";

// ── Config ─────────────────────────────────────────────────────────

const MAX_CONCURRENCY = 12;
const TASK_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes per task

// ── Extension ──────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {

	// ── /waves ───────────────────────────────────────────────────────

	pi.registerCommand("waves", {
		description: "List wave projects in this repo",
		handler: async (_args, ctx) => {
			// Auto-migrate any loose files first
			const migrations = migrateLooseFiles(ctx.cwd);
			if (migrations.length > 0) {
				ctx.ui.notify(
					`📦 Migrated ${migrations.length} file(s) to .pi/waves/:\n${migrations.map((m) => `  ${m}`).join("\n")}`,
					"info",
				);
			}

			const projects = listWaveProjects(ctx.cwd);
			if (projects.length === 0) {
				ctx.ui.notify("No wave projects yet. Run /waves-spec <task> to create one.", "info");
				return;
			}

			let summary = `**Wave projects** in \`.pi/waves/\`:\n\n`;
			for (const name of projects) {
				const info = projectSummary(ctx.cwd, name);
				summary += `- **${name}**  ${info}\n`;
			}
			summary += `\nCommands: \`/waves-spec <task>\`, \`/waves-plan <name>\`, \`/waves-execute <name>\``;

			pi.sendMessage(
				{ customType: "wave-list", content: summary, display: true },
				{ triggerTurn: false },
			);
		},
	});

	// ── /waves-spec ─────────────────────────────────────────────────

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
		description: "Create a plan for a wave project (e.g. /waves-plan my-project)",
		handler: async (args, ctx) => {
			// Auto-migrate any loose files first
			const migrations = migrateLooseFiles(ctx.cwd);
			if (migrations.length > 0) {
				ctx.ui.notify(
					`📦 Migrated ${migrations.length} file(s) to .pi/waves/:\n${migrations.map((m) => `  ${m}`).join("\n")}`,
					"info",
				);
			}

			let projectName: string;
			let extraInstructions: string;
			let spec: string;

			if (!args?.trim()) {
				// No args: show available projects
				const projects = listWaveProjects(ctx.cwd);
				const withSpecs = projects.filter((p) => findSpecFile(ctx.cwd, p));

				if (withSpecs.length === 1) {
					// Only one project with a spec — use it automatically
					projectName = withSpecs[0];
					extraInstructions = "";
					spec = findSpecFile(ctx.cwd, projectName)!;
				} else if (withSpecs.length > 0) {
					let msg = "Available projects with specs:\n";
					for (const p of withSpecs) {
						const info = projectSummary(ctx.cwd, p);
						msg += `  • **${p}**  ${info}\n`;
					}
					msg += `\nUsage: \`/waves-plan <project> [extra instructions]\``;
					ctx.ui.notify(msg, "info");
					return;
				} else {
					ctx.ui.notify("No specs found. Run /waves-spec <task> first.", "info");
					return;
				}
			} else {
				const parts = args.trim().split(/\s+/);
				const firstArg = parts[0];
				extraInstructions = parts.slice(1).join(" ");

				// Resolve project name
				projectName = resolveProject(ctx.cwd, firstArg);
				const found = findSpecFile(ctx.cwd, projectName);

				if (found) {
					spec = found;
				} else {
					const projects = listWaveProjects(ctx.cwd);
					const hint = projects.length > 0
						? `\nKnown projects: ${projects.join(", ")}`
						: "\nRun /waves-spec <task> to create one.";
					ctx.ui.notify(`No spec found for "${firstArg}".${hint}`, "error");
					return;
				}
			}

			const extra = extraInstructions ? `\n\nAdditional instructions: ${extraInstructions}` : "";
			const relSpec = path.relative(ctx.cwd, spec);

			// Phase 1: Run planner for outline only
			ctx.ui.setStatus("waves", ctx.ui.theme.fg("warning", `📋 [${projectName}] Drafting outline...`));

			const outlineTask = `Read the spec at \`${relSpec}\` and produce a **plan outline only** — NOT the full plan.${extra}

Your output should be a structured outline covering:

1. **Project structure** — a directory tree showing existing dirs the code lives in and new dirs being added. Mark new dirs with ← new. This gives everyone a shared map of the codebase layout.

2. **Waves as milestones** — for each wave:
   - Wave number and name
   - What "working" means at wave end (the milestone)
   - Foundation: what shared contracts/scaffolding are created

3. **Feature parallelization** — for each wave:
   - Which features run in parallel (and why they're independent)
   - Files each feature owns
   - Key task dependencies within each feature (e.g., test → implement → verify)

4. **Integration** — for each wave:
   - What glue work is needed after features merge
   - What the integration verification covers

Be concise but specific. Show the structure, not the full task descriptions.
Do NOT write any files. Just output the outline as your response.`;

			const outlineResult = await runSubagent("wave-planner", outlineTask, ctx.cwd, undefined, {
				readOnly: true,
				safeBashOnly: true,
			});

			const outlineOutput = extractFinalOutput(outlineResult.stdout);

			ctx.ui.setStatus("waves", undefined);

			if (outlineResult.exitCode !== 0 || !outlineOutput) {
				ctx.ui.notify("Planner outline failed: " + (outlineResult.stderr || "no output"), "error");
				return;
			}

			// Phase 2: Present outline for review in main conversation
			ensureProjectDir(ctx.cwd, projectName);
			const file = planPath(ctx.cwd, projectName);
			const relPlan = path.relative(ctx.cwd, file);

			const reviewPrompt = buildPlanReviewPrompt(projectName, relSpec, relPlan, outlineOutput, extra);

			ctx.ui.notify("📋 Outline ready. Review the milestones and parallelization...", "info");

			pi.sendMessage(
				{
					customType: "wave-plan-review",
					content: reviewPrompt,
					display: false,
				},
				{
					triggerTurn: true,
					deliverAs: "followUp",
				},
			);
		},
	});

	// ── /waves-execute ───────────────────────────────────────────────

	pi.registerCommand("waves-execute", {
		description: "Execute a wave plan (e.g. /waves-execute my-project)",
		handler: async (args, ctx) => {
			// Auto-migrate any loose files first
			const migrations = migrateLooseFiles(ctx.cwd);
			if (migrations.length > 0) {
				ctx.ui.notify(
					`📦 Migrated ${migrations.length} file(s) to .pi/waves/:\n${migrations.map((m) => `  ${m}`).join("\n")}`,
					"info",
				);
			}

			if (!args?.trim()) {
				// No args: show available projects with plans, or auto-select if only one
				const projects = listWaveProjects(ctx.cwd);
				const withPlans = projects.filter((p) => !!findPlanFile(ctx.cwd, p));
				if (withPlans.length === 1) {
					// Auto-select the only project
					args = withPlans[0];
				} else if (withPlans.length > 0) {
					let msg = "Available projects with plans:\n";
					for (const p of withPlans) {
						const info = projectSummary(ctx.cwd, p);
						msg += `  • **${p}**  ${info}\n`;
					}
					msg += `\nUsage: \`/waves-execute <project>\``;
					ctx.ui.notify(msg, "info");
					return;
				} else {
					ctx.ui.notify("No plan files found. Run /waves-plan first.", "info");
					return;
				}
			}

			// Resolve the plan file — accept a direct path or a project name
			let planFile: string | null = null;
			let projectName: string;
			const input = args.trim();

			// 1. Try as a direct file path
			const asPath = path.resolve(ctx.cwd, input);
			if (fs.existsSync(asPath) && fs.statSync(asPath).isFile()) {
				planFile = asPath;
				// Derive project name from parent directory
				const parentDir = path.basename(path.dirname(asPath));
				projectName = parentDir;
			} else {
				// 2. Try as a project name
				projectName = resolveProject(ctx.cwd, input);

				// Show available plan versions if multiple exist
				const dir = projectDir(ctx.cwd, projectName);
				const plans = allVersions(dir, "plan");

				if (plans.length > 1) {
					// Use latest, but inform the user
					planFile = plans[plans.length - 1].path;
					ctx.ui.notify(
						`Using latest: ${plans[plans.length - 1].file} (${plans.length} versions available)`,
						"info",
					);
				} else {
					planFile = findPlanFile(ctx.cwd, projectName);
				}
			}

			if (!planFile) {
				const projects = listWaveProjects(ctx.cwd);
				const hint = projects.length > 0
					? `\nKnown projects: ${projects.join(", ")}`
					: "";
				ctx.ui.notify(`No plan found for "${input}".${hint}`, "error");
				return;
			}

			const planContent = fs.readFileSync(planFile, "utf-8");
			const plan = parsePlanV2(planContent);

			if (plan.waves.length === 0) {
				ctx.ui.notify(`Plan has no waves: ${path.relative(ctx.cwd, planFile)}`, "error");
				return;
			}

			// Find spec: from the plan's ## Reference section, then by project name
			const specRef = extractSpecRef(planContent);
			let spec: string | null = null;
			if (specRef) {
				spec = findSpecFile(ctx.cwd, specRef);
			}
			if (!spec) {
				spec = findSpecFile(ctx.cwd, projectName);
			}
			// Spec is optional — execution can proceed with empty spec context
			const specContent = spec ? fs.readFileSync(spec, "utf-8") : "";

			// Validate all DAGs (per-section + cross-section + file overlap)
			const planValidation = validatePlan(plan);
			if (!planValidation.valid) {
				const errorList = planValidation.errors.map((e) => `  • ${e}`).join("\n");
				ctx.ui.notify(`Plan has DAG errors:\n${errorList}\n\nFix the plan and re-run /waves-execute.`, "error");
				return;
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
			preview += `Up to ${MAX_CONCURRENCY} parallel agents, ${TASK_TIMEOUT_MS / 60000}min timeout per task\n\n`;
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

			// Build execution log header
			const logPath = logFilePath(ctx.cwd, projectName);
			const relPlanFile = path.relative(ctx.cwd, planFile);
			const relSpecFile = spec ? path.relative(ctx.cwd, spec) : "(none)";
			const logLines: string[] = [
				`# Execution Log`,
				``,
				`Started: ${new Date().toISOString()}`,
				`Spec: ${relSpecFile}`,
				`Plan: ${relPlanFile}`,
				`Architecture: feature-parallel DAG`,
				``,
			];

			const execState = createInitialState(planFile);
			writeState(planFile, execState);

			await runWaveExecution({
				plan, planFile, specContent, cwd: ctx.cwd,
				startWave: 0,
				skipSet: new Set(),
				execState,
				logPath, logLines,
				taskLogDir: createTaskLogDir(logPath),
				protectedPaths: [planFile, ...(spec ? [spec] : [])],
				maxConcurrency: MAX_CONCURRENCY,
				isResume: false,
				pi, ctx,
			});
		},
	});

	// ── /waves-continue ──────────────────────────────────────────────

	pi.registerCommand("waves-continue", {
		description: "Resume a failed wave execution from where it left off",
		handler: async (args, ctx) => {
			// Auto-migrate any loose files first
			const migrations = migrateLooseFiles(ctx.cwd);
			if (migrations.length > 0) {
				ctx.ui.notify(
					`📦 Migrated ${migrations.length} file(s) to .pi/waves/:\n${migrations.map((m) => `  ${m}`).join("\n")}`,
					"info",
				);
			}

			if (!args?.trim()) {
				// Find projects with state.json files
				const projects = listWaveProjects(ctx.cwd);
				const resumable = projects.filter((p) => {
					const stateFile = path.join(projectDir(ctx.cwd, p), "state.json");
					return fs.existsSync(stateFile);
				});

				if (resumable.length === 1) {
					// Auto-select the only resumable project
					args = resumable[0];
				} else if (resumable.length > 0) {
					let msg = "Resumable projects:\n";
					for (const p of resumable) {
						const info = projectSummary(ctx.cwd, p);
						msg += `  • **${p}**  ${info}\n`;
					}
					msg += `\nUsage: \`/waves-continue <project>\``;
					ctx.ui.notify(msg, "info");
					return;
				} else {
					ctx.ui.notify("No resumable executions found. State files are created during /waves-execute and removed on success.", "info");
					return;
				}
			}

			// Resolve plan file
			let planFile: string | null = null;
			let projectName: string;
			const input = args.trim();

			const asPath = path.resolve(ctx.cwd, input);
			if (fs.existsSync(asPath) && fs.statSync(asPath).isFile()) {
				planFile = asPath;
				projectName = path.basename(path.dirname(asPath));
			} else {
				projectName = resolveProject(ctx.cwd, input);
				planFile = findPlanFile(ctx.cwd, projectName);
			}

			if (!planFile) {
				const projects = listWaveProjects(ctx.cwd);
				const hint = projects.length > 0
					? `\nKnown projects: ${projects.join(", ")}`
					: "";
				ctx.ui.notify(`No plan found for "${input}".${hint}`, "error");
				return;
			}

			// Load state
			const prevState = readState(planFile);
			if (!prevState) {
				ctx.ui.notify(
					`No execution state found for this plan. Nothing to resume.\n` +
					`State file expected at: ${stateFilePath(planFile)}\n\n` +
					`Run /waves-execute first, or if a previous run completed successfully, there's nothing to resume.`,
					"info",
				);
				return;
			}

			const skipSet = completedTaskIds(prevState);
			const resumeWave = prevState.currentWave;

			// Load plan
			const planContent = fs.readFileSync(planFile, "utf-8");
			const plan = parsePlanV2(planContent);

			if (plan.waves.length === 0) {
				ctx.ui.notify("Plan has no waves.", "error");
				return;
			}

			// Validate all DAGs (per-section + cross-section + file overlap)
			const planValidation = validatePlan(plan);
			if (!planValidation.valid) {
				const errorList = planValidation.errors.map((e) => `  • ${e}`).join("\n");
				ctx.ui.notify(`Plan has DAG errors:\n${errorList}\n\nFix the plan and re-run /waves-continue.`, "error");
				return;
			}

			// Find spec
			const specRef = extractSpecRef(planContent);
			let spec: string | null = null;
			if (specRef) spec = findSpecFile(ctx.cwd, specRef);
			if (!spec) spec = findSpecFile(ctx.cwd, projectName);
			const specContent = spec ? fs.readFileSync(spec, "utf-8") : "";

			// Count what's left
			const allTaskIds = plan.waves.slice(resumeWave).flatMap((w) => [
				...w.foundation,
				...w.features.flatMap((f) => f.tasks),
				...w.integration,
			]);
			const remaining = allTaskIds.filter((t) => !skipSet.has(t.id)).length;
			const skipping = allTaskIds.filter((t) => skipSet.has(t.id)).length;

			const preview = `**Resuming: ${plan.goal || "Implementation"}**\n` +
				`Starting from wave ${resumeWave + 1} (${plan.waves[resumeWave].name})\n` +
				`↩ Skipping ${skipping} completed tasks, running ${remaining} remaining\n` +
				`Failed/skipped tasks from previous run will be re-executed.`;

			const ok = await ctx.ui.confirm("Resume wave execution?", preview);
			if (!ok) {
				ctx.ui.notify("Resume cancelled.", "info");
				return;
			}

			// Build resume log header
			const logPath = logFilePath(ctx.cwd, projectName);
			const relPlanFile = path.relative(ctx.cwd, planFile);
			const relSpecFile = spec ? path.relative(ctx.cwd, spec) : "(none)";
			const logLines: string[] = [
				`# Execution Log (resumed)`,
				``,
				`Resumed: ${new Date().toISOString()}`,
				`Previous run: ${prevState.startedAt}`,
				`Resuming from wave: ${resumeWave + 1}`,
				`Skipping ${skipping} completed tasks`,
				`Spec: ${relSpecFile}`,
				`Plan: ${relPlanFile}`,
				``,
			];

			await runWaveExecution({
				plan, planFile, specContent, cwd: ctx.cwd,
				startWave: resumeWave,
				skipSet,
				execState: prevState,
				logPath, logLines,
				taskLogDir: createTaskLogDir(logPath),
				protectedPaths: [planFile, ...(spec ? [spec] : [])],
				maxConcurrency: MAX_CONCURRENCY,
				isResume: true,
				pi, ctx,
			});
		},
	});
}


