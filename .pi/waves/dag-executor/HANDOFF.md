# DAG Executor — Implementation Handoff

## What You're Building

Refactoring the wave execution system in `pi-wave-workflow` from flat parallel task lists to a feature-parallel DAG model with git worktree isolation. This is a significant architectural change to how the `/waves-execute` command works.

## Where Everything Is

```
/home/hendrik/coding/pi-wave-workflow/
├── extensions/
│   ├── wave-executor/
│   │   └── index.ts              ← current executor (1289 lines, will be split into modules)
│   └── subagent/
│       ├── index.ts              ← subagent tool (DO NOT MODIFY)
│       ├── agents.ts             ← agent discovery (DO NOT MODIFY)
│       └── git-worktree.ts       ← git worktree helpers (ADAPT for feature-level)
├── agents/
│   ├── wave-planner.md           ← planner prompt (REWRITE)
│   ├── wave-verifier.md          ← verifier prompt (MINOR UPDATE)
│   ├── worker.md                 ← worker prompt (MINOR UPDATE)
│   ├── test-writer.md            ← test writer prompt (NO CHANGE)
│   └── scout.md                  ← scout prompt (NO CHANGE)
├── skills/                       ← DO NOT MODIFY
├── prompts/                      ← DO NOT MODIFY
└── package.json                  ← no build step, pi loads .ts directly
```

## Key Context

- **No build step.** Pi loads TypeScript extensions directly. No `tsc`, no bundling.
- **No test framework.** Verify by reading code + `npx tsc --noEmit` where possible.
- **The subagent tool (`extensions/subagent/index.ts`) is separate** from the wave executor. Don't modify it. The executor calls `runSubagent()` which spawns `pi` processes.
- **`permissionMode: fullAuto`** must be in all agent frontmatter. Without it, subagents can't run bash commands (blocked by the permissions extension).
- **Imports use relative paths** with `.js` extensions for ESM compatibility (e.g., `import { Task } from "./types.js"`).

## Read These First

1. **Spec:** `.pi/waves/dag-executor/SPEC.md` — full requirements, execution model, parallelism model
2. **Plan:** `.pi/waves/dag-executor/PLAN.md` — wave-by-wave implementation with exact interfaces and file assignments
3. **Current executor:** `extensions/wave-executor/index.ts` — understand what exists before rewriting
4. **Current git-worktree:** `extensions/subagent/git-worktree.ts` — existing worktree helpers to adapt

## The Mental Model

```
Wave (= Milestone)
│
├── Foundation (sequential, on base branch)
│   Creates shared contracts (types, interfaces, config)
│   Commits to base branch
│   All feature worktrees branch from here
│
├── Features (parallel, each in own git worktree)
│   Feature A ─── feature branch: wave-N/feature-a
│   │ Tasks follow a DAG:
│   │   Level 0: tasks with no deps → parallel → separate sub-worktrees
│   │   Level 1: tasks depending on level 0 → sequential → reuse feature worktree
│   │   Level 2: etc.
│   │
│   Feature B ─── feature branch: wave-N/feature-b
│   │ (runs simultaneously with Feature A)
│   │ Same DAG pattern within
│   │
│   (each feature merges sub-worktrees internally at each DAG level)
│
├── Merge (feature branches → base branch)
│
└── Integration (sequential, on merged base)
    Glue code + full verification
```

**Three tiers of git isolation:**
1. Base branch ← foundation commits here
2. Feature worktree (one per feature) ← features work here
3. Sub-worktree (one per parallel task within a feature) ← only when 2+ tasks at same DAG level

Sequential tasks (B depends on A) reuse the parent worktree. Sub-worktrees only exist for actually parallel tasks.

## Implementation Order

Follow the plan's 4 waves. Within each wave, work on foundation first, then features, then integration.

### Wave 1: Core Modules
Create three new files:

1. **`extensions/wave-executor/types.ts`** — All shared TypeScript interfaces (Plan, Wave, Feature, Task, TaskResult, FeatureResult, WaveResult, DAGLevel, FeatureWorktree, SubWorktree, MergeResult). Pure types, no logic.

2. **`extensions/wave-executor/plan-parser.ts`** — Parses the new Markdown plan format. Must handle:
   - `### Foundation` / `### Feature: <name>` / `### Integration` sections
   - `#### Task <id>:` with Agent/Files/Depends/Tests/Spec refs/Description fields
   - Backward compat: old flat format (no Feature headers) → wrap in single "default" feature

3. **`extensions/wave-executor/dag.ts`** — DAG scheduler:
   - `validateDAG()` — cycle detection (Kahn's algorithm)
   - `buildDAG()` — topological sort into levels
   - `executeDAG()` — run tasks level by level, parallel within levels, fail-fast on errors

### Wave 2: Git + Planner
Modify/create two files:

4. **`extensions/subagent/git-worktree.ts`** — Replace per-task worktree API with:
   - `createFeatureWorktree()` — branch: `wave-N/feature-name`
   - `createSubWorktrees()` — branch: `wave-N/feature-name/task-id` (for parallel tasks)
   - `mergeSubWorktrees()` — merge back into feature branch after parallel level completes
   - `mergeFeatureBranches()` — merge features into base after all complete
   - `checkpointChanges()` / `restoreCheckpoint()` — save/restore dirty state
   - Keep existing git helpers (`git()`, `isGitRepo()`, etc.)

5. **`agents/wave-planner.md`** — Rewrite prompt for feature-based planning. The planner must:
   - Think in milestones (waves deliver working increments)
   - Define foundation contracts with exact signatures
   - Group work into parallel features
   - Specify task dependencies within features
   - Repeat canonical names in every task description

### Wave 3: Executor Rewrite
The big one — split `index.ts` into modules:

6. **`extensions/wave-executor/helpers.ts`** — Extract from index.ts: `extractFinalOutput`, `extractSpecSections`, `slugify`, path helpers, `runSubagent`, `mapConcurrent`, file enforcement code.

7. **`extensions/wave-executor/feature-executor.ts`** — Executes one feature's task DAG:
   - Uses `buildDAG()` to get task levels
   - For parallel levels: create sub-worktrees, run tasks, merge back
   - For sequential levels: run in feature worktree directly
   - Fix cycle on verifier failure (max 1 retry)

8. **`extensions/wave-executor/wave-executor.ts`** — Executes one wave:
   - Foundation phase → commit → create feature worktrees
   - Feature phase → parallel `executeFeature()` calls
   - Merge phase → merge feature branches
   - Integration phase → run on merged base

9. **`extensions/wave-executor/index.ts`** — Slim down to command registration + UI:
   - Keep `/waves`, `/waves-spec`, `/waves-plan`, `/waves-execute` commands
   - Keep brainstorm prompt builder
   - Replace inline execution with `executeWave()` calls
   - Keep progress widgets and log writing

10. **`agents/wave-verifier.md`** + **`agents/worker.md`** — Minor updates: worktree awareness notes.

### Wave 4: Verify + Docs
11. **`README.md`** — Document new architecture
12. Final verification — everything compiles, commands register, imports resolve

## Critical Details

### Import Style
```typescript
// ESM with .js extensions (pi loads .ts but resolves .js)
import type { Task, Feature, WaveResult } from "./types.js";
import { buildDAG, executeDAG } from "./dag.js";
```

### runSubagent Signature (keep as-is)
```typescript
function runSubagent(
  agentName: string,
  task: string,
  cwd: string,
  signal?: AbortSignal,
  fileRules?: FileAccessRules,
): Promise<{ exitCode: number; stdout: string; stderr: string }>;
```

### Agent Spawning
Agents are spawned as separate `pi` processes:
```typescript
spawn("pi", ["--mode", "json", "-p", "--no-session", "--append-system-prompt", agentFile, ...], { cwd })
```
The `cwd` is what changes — it's the worktree directory for isolated features/tasks.

### File Access Enforcement
The current executor generates a temporary TypeScript extension that blocks writes outside allowed paths. Keep this mechanism — pass the temp extension via `-e` flag to the pi subprocess.

### No Feature-to-Feature Dependencies
Features within a wave are fully independent. If feature B needs feature A's output, put B in the next wave or in the integration phase.

### Backward Compatibility
Old flat plans (no `### Feature:` headers) must still work. The parser wraps all tasks in a single "default" feature with foundation=[] and integration=[]. The executor handles single-feature waves without worktree isolation (no point isolating one feature).

## Verification Checklist

After implementation, verify:
- [ ] `extensions/wave-executor/types.ts` — all interfaces from spec present
- [ ] `extensions/wave-executor/plan-parser.ts` — parses new and legacy formats
- [ ] `extensions/wave-executor/dag.ts` — validates, builds, executes DAGs
- [ ] `extensions/wave-executor/helpers.ts` — extracted helpers compile
- [ ] `extensions/wave-executor/feature-executor.ts` — executes feature DAG with sub-worktrees
- [ ] `extensions/wave-executor/wave-executor.ts` — foundation → features → merge → integration
- [ ] `extensions/wave-executor/index.ts` — commands register, uses new modules
- [ ] `extensions/subagent/git-worktree.ts` — feature + sub-worktree functions
- [ ] `agents/wave-planner.md` — new feature-based prompt with permissionMode
- [ ] `agents/wave-verifier.md` — worktree awareness, permissionMode
- [ ] `agents/worker.md` — worktree awareness, permissionMode
- [ ] All imports resolve (no circular dependencies)
- [ ] Old flat plans still parse and execute
- [ ] README updated
