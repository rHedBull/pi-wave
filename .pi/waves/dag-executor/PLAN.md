# Implementation Plan

## Goal
Refactor the wave execution system from flat parallel task lists to a feature-parallel DAG model with git worktree isolation at both feature and task level.

## Reference
- Spec: `.pi/waves/dag-executor/SPEC.md`

## TDD Approach
- This is a TypeScript extension project — no formal test framework in place
- Verification via: `npx tsc --noEmit` (type checking), manual execution tests
- Each module gets a verifier task that confirms it compiles and integrates

## Key Interfaces (contracts for all tasks)

```typescript
// types.ts — shared across all modules
interface Plan {
  goal: string;
  waves: Wave[];
}

interface Wave {
  name: string;
  description: string;
  foundation: Task[];
  features: Feature[];
  integration: Task[];
}

interface Feature {
  name: string;
  files: string[];
  tasks: Task[];
}

interface Task {
  id: string;
  title: string;
  agent: string;          // "test-writer" | "worker" | "wave-verifier"
  files: string[];
  depends: string[];       // task IDs within same feature/section
  specRefs: string[];
  testFiles: string[];
  description: string;
}

interface TaskResult {
  id: string;
  title: string;
  agent: string;
  exitCode: number;
  output: string;
  stderr: string;
  durationMs: number;
}

interface FeatureResult {
  name: string;
  branch: string;
  taskResults: TaskResult[];
  passed: boolean;
  error?: string;
}

interface WaveResult {
  wave: string;
  foundationResults: TaskResult[];
  featureResults: FeatureResult[];
  integrationResults: TaskResult[];
  passed: boolean;
}

// dag.ts
interface DAGLevel {
  tasks: Task[];       // tasks at this level (no unmet deps)
  parallel: boolean;   // true if >1 task at this level
}

function buildDAG(tasks: Task[]): DAGLevel[];
function validateDAG(tasks: Task[]): { valid: boolean; error?: string };

// git-worktree.ts additions
interface FeatureWorktree {
  featureName: string;
  branch: string;       // wave-{N}/{feature-name}
  dir: string;
  repoRoot: string;
}

interface SubWorktree {
  taskId: string;
  branch: string;       // wave-{N}/{feature-name}/{task-id}
  dir: string;
  parentBranch: string; // feature branch
}
```

---

## Wave 1: Core Modules
Working state: types, plan parser, and DAG scheduler exist as standalone modules that compile. No execution yet.

### Foundation

#### Task w1-found-t1: Create shared types module
- **Agent**: worker
- **Files**: `extensions/wave-executor/types.ts`
- **Description**: Create the shared TypeScript interfaces used by all other modules. Extract from the contracts above: `Plan`, `Wave`, `Feature`, `Task`, `TaskResult`, `FeatureResult`, `WaveResult`, `DAGLevel`. Export all types. No implementation logic, just type definitions.

#### Task w1-found-t2: Verify types compile
- **Agent**: wave-verifier
- **Depends**: w1-found-t1
- **Description**: Run `npx tsc --noEmit extensions/wave-executor/types.ts` (with appropriate flags). Verify no type errors. Check that all interfaces from the spec are present.

### Feature: plan-parser
Files: extensions/wave-executor/plan-parser.ts

#### Task w1-parser-t1: Implement plan parser
- **Agent**: worker
- **Files**: `extensions/wave-executor/plan-parser.ts`
- **Description**: Implement `parsePlanV2(markdown: string): Plan` that parses the new plan format.
  Import types from `./types.ts`.

  Must handle these Markdown patterns:
  - `## Wave N: <name>` → new wave, text until next section = description
  - `### Foundation` → tasks go into `wave.foundation[]`
  - `### Feature: <name>` → new feature, `Files: ...` line parsed into `feature.files[]`
  - `### Integration` → tasks go into `wave.integration[]`
  - `#### Task <id>: <title>` → new task
  - `- **Agent**: <name>` → `task.agent`
  - `- **Files**: <paths>` → `task.files[]` (comma-separated, backtick-stripped)
  - `- **Depends**: <ids>` → `task.depends[]` (comma-separated, or "(none)")
  - `- **Tests**: <paths>` → `task.testFiles[]`
  - `- **Spec refs**: <refs>` → `task.specRefs[]`
  - `- **Description**: <text>` → `task.description` (includes continuation lines)

  **Backward compatibility (FR-NFR-6):** If no `### Feature:` headers found, detect old format:
  - `### Task <id>:` directly under a wave → wrap all tasks in a single feature named "default"
  - No `### Foundation` / `### Integration` → foundation=[], integration=[]

  Export: `parsePlanV2`, and keep the old `parsePlan` as `parsePlanLegacy` for reference.

#### Task w1-parser-t2: Verify plan parser
- **Agent**: wave-verifier
- **Depends**: w1-parser-t1
- **Description**: Read `plan-parser.ts`, verify it compiles with `types.ts`. Check:
  - Imports from `./types.ts`
  - Exports `parsePlanV2` function
  - Handles both new format (features) and legacy format (flat tasks)
  - Parses `depends` field correctly (handles "(none)" and comma-separated IDs)

### Feature: dag-scheduler
Files: extensions/wave-executor/dag.ts

#### Task w1-dag-t1: Implement DAG scheduler
- **Agent**: worker
- **Files**: `extensions/wave-executor/dag.ts`
- **Description**: Implement the DAG scheduler module. Import `Task`, `DAGLevel` from `./types.ts`.

  Must export:
  ```typescript
  // Validate that dependencies form a DAG (no cycles, all refs exist)
  function validateDAG(tasks: Task[]): { valid: boolean; error?: string };
  
  // Build topologically sorted levels from tasks
  // Level 0: tasks with no deps
  // Level 1: tasks whose deps are all in level 0
  // etc.
  // Each level has parallel=true if >1 task
  function buildDAG(tasks: Task[]): DAGLevel[];
  
  // Execute tasks respecting DAG order. Calls runTask for each.
  // Returns results for all tasks (including skipped ones on failure).
  // - Tasks at the same level with parallel=true run concurrently
  // - If a task fails, downstream dependents are skipped (marked as skipped)
  // - maxConcurrency limits simultaneous runTask calls across all levels
  async function executeDAG(
    tasks: Task[],
    runTask: (task: Task) => Promise<TaskResult>,
    maxConcurrency: number,
  ): Promise<TaskResult[]>;
  ```

  `executeDAG` implementation:
  1. Call `buildDAG(tasks)` to get levels
  2. For each level:
     - If 1 task: run it directly (no sub-worktree needed — caller handles this)
     - If N tasks: run all N concurrently (up to maxConcurrency)
     - If any task fails: mark all tasks in subsequent levels that transitively depend on it as skipped
  3. Return all TaskResult[] in original task order

  Use a simple `mapConcurrent` helper (same pattern as existing codebase):
  ```typescript
  async function mapConcurrent<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]>
  ```

  Cycle detection in `validateDAG`: Kahn's algorithm — if sorted count !== task count, there's a cycle.

#### Task w1-dag-t2: Verify DAG scheduler
- **Agent**: wave-verifier
- **Depends**: w1-dag-t1
- **Description**: Read `dag.ts`, verify it compiles with `types.ts`. Check:
  - Exports `validateDAG`, `buildDAG`, `executeDAG`
  - `validateDAG` detects cycles and missing dependency references
  - `buildDAG` returns levels sorted topologically
  - `executeDAG` handles: simple chain (A→B→C), parallel (A,B no deps), diamond (A→B, A→C, B+C→D), fail-fast (B fails → C skipped)

---

## Wave 2: Git Worktree Adaptation + Planner
Working state: git-worktree supports feature-level and sub-worktree isolation. New planner prompt generates feature-based plans.

### Foundation

#### Task w2-found-t1: Extend types for git worktrees
- **Agent**: worker
- **Files**: `extensions/wave-executor/types.ts`
- **Description**: Add git worktree types to the existing types module:
  ```typescript
  interface FeatureWorktree {
    featureName: string;
    branch: string;
    dir: string;
    repoRoot: string;
  }
  
  interface SubWorktree {
    taskId: string;
    branch: string;
    dir: string;
    parentBranch: string;
  }
  
  interface MergeResult {
    source: string;      // branch name
    target: string;      // branch merged into
    success: boolean;
    hadChanges: boolean;
    error?: string;
  }
  ```
  Keep all existing types unchanged, just append new ones.

#### Task w2-found-t2: Verify extended types
- **Agent**: wave-verifier
- **Depends**: w2-found-t1
- **Description**: Verify types.ts still compiles. Check new interfaces exist alongside old ones.

### Feature: git-worktree-v2
Files: extensions/subagent/git-worktree.ts

#### Task w2-git-t1: Refactor git-worktree for feature + sub-worktree support
- **Agent**: worker
- **Files**: `extensions/subagent/git-worktree.ts`
- **Description**: Adapt the existing git-worktree module. Keep existing helper functions (`git`, `isGitRepo`, `getRepoRoot`, `getCurrentBranch`, `hasUncommittedChanges`). Replace the public API with feature-oriented functions:

  ```typescript
  // Checkpoint uncommitted changes, return sha (or null if clean)
  function checkpointChanges(repoRoot: string): string | null;
  
  // Restore to pre-checkpoint state (soft reset if checkpoint was made)
  function restoreCheckpoint(repoRoot: string, checkpointSha: string | null): void;
  
  // Create a feature worktree branching from current HEAD
  // Branch: wave-{waveNum}/{featureName}
  function createFeatureWorktree(
    repoRoot: string, waveNum: number, featureName: string
  ): FeatureWorktree;
  
  // Create sub-worktrees for parallel tasks within a feature
  // Each branches from the feature branch
  // Branch: wave-{waveNum}/{featureName}/{taskId}
  function createSubWorktrees(
    featureWorktree: FeatureWorktree, waveNum: number, taskIds: string[]
  ): SubWorktree[];
  
  // Merge sub-worktrees back into feature branch, cleanup
  function mergeSubWorktrees(
    featureWorktree: FeatureWorktree, subWorktrees: SubWorktree[], 
    results: { taskId: string; exitCode: number }[]
  ): MergeResult[];
  
  // Merge feature branches into base branch, cleanup
  function mergeFeatureBranches(
    repoRoot: string, featureWorktrees: FeatureWorktree[],
    results: { featureName: string; passed: boolean }[]
  ): MergeResult[];
  
  // Emergency cleanup — remove all worktrees and branches
  function cleanupAll(
    repoRoot: string, featureWorktrees: FeatureWorktree[], 
    subWorktrees: SubWorktree[]
  ): void;
  ```

  Import `FeatureWorktree`, `SubWorktree`, `MergeResult` from `../wave-executor/types.ts`.

  Key behaviors:
  - `createFeatureWorktree`: uses `git worktree add -b <branch> <dir>`, dir in os.tmpdir()
  - `createSubWorktrees`: same but branches from feature branch, not HEAD
  - `mergeSubWorktrees`: commit changes in each sub-worktree, switch to feature worktree, merge each, cleanup. Skip failed tasks. Abort on conflict.
  - `mergeFeatureBranches`: similar but merges into base branch. Skip failed features.
  - All functions handle "not a git repo" gracefully (return null or empty results)

#### Task w2-git-t2: Verify git-worktree
- **Agent**: wave-verifier
- **Depends**: w2-git-t1
- **Description**: Verify git-worktree.ts compiles. Check all exported functions exist with correct signatures. Verify it imports types from `../wave-executor/types.ts`.

### Feature: planner-prompt
Files: agents/wave-planner.md

#### Task w2-planner-t1: Rewrite wave-planner prompt
- **Agent**: worker
- **Files**: `agents/wave-planner.md`
- **Description**: Rewrite the wave-planner agent prompt for the new feature-based plan format. Key changes from current prompt:

  **Structure:**
  - Waves = milestones (each delivers a working increment)
  - Each wave has: Foundation (shared contracts) → Features (parallel) → Integration (glue + verify)
  - Features contain tasks with explicit `Depends:` declarations
  - Tasks within features follow TDD: test-writer → worker → verifier

  **Planning strategy:**
  1. First define all shared interfaces/types/contracts (foundation)
  2. Group independent work into features that can run in parallel
  3. Within each feature, define task dependencies (DAG)
  4. Integration phase wires features together and runs full verification

  **Rules:**
  - Foundation creates shared files that all features need (types, config, fixtures)
  - The planner defines exact signatures/field names — foundation agents just create the files
  - Features MUST NOT have cross-feature dependencies (use integration instead)
  - Parallel tasks within a feature MUST NOT write to the same files
  - Every task description must repeat canonical field names/conventions
  - Target: 2-5 waves, 2-6 features per wave, 2-6 tasks per feature
  - Task IDs: `w{wave}-{feature}-t{num}` (e.g., `w1-auth-t1`)

  **Output format:** Must match the Markdown format from the spec's Data Model section (Foundation/Feature/Integration headers, Task with Agent/Files/Depends/Tests/Spec refs/Description fields).

  Keep the frontmatter: `name: wave-planner`, `tools: read, grep, find, ls`, `model: claude-sonnet-4-5`. Add `permissionMode: fullAuto`.

#### Task w2-planner-t2: Verify planner prompt
- **Agent**: wave-verifier
- **Depends**: w2-planner-t1
- **Description**: Read wave-planner.md. Verify:
  - Frontmatter has name, description, tools, model, permissionMode
  - Describes foundation → features → integration structure
  - Specifies the exact Markdown plan format with Foundation/Feature/Integration sections
  - Includes task ID naming convention
  - Emphasizes canonical names in every task description
  - Mentions backward compatibility with flat plans

---

## Wave 3: Executor Rewrite
Working state: the full executor works — `/waves-execute` runs plans with foundation → parallel features (worktree-isolated) → merge → integration. DAG scheduling within features. Sub-worktrees for parallel tasks.

### Foundation

#### Task w3-found-t1: Extract helpers from current executor
- **Agent**: worker
- **Files**: `extensions/wave-executor/helpers.ts`
- **Description**: Extract reusable functions from the current `index.ts` into a helpers module:
  ```typescript
  // From existing code — move as-is:
  export function extractFinalOutput(jsonLines: string): string;
  export function extractSpecSections(specContent: string, specRefs: string[]): string;
  export function slugify(text: string): string;
  
  // Path helpers — move as-is:
  export function wavesBaseDir(cwd: string): string;
  export function waveProjectDir(cwd: string, name: string): string;
  export function specPath(cwd: string, name: string): string;
  export function planPath(cwd: string, name: string): string;
  export function logFilePath(cwd: string, name: string): string;
  export function ensureProjectDir(cwd: string, name: string): void;
  export function listWaveProjects(cwd: string): string[];
  ```
  Literally copy these functions from index.ts, no changes to logic. Just re-export them.

#### Task w3-found-t2: Verify helpers compile
- **Agent**: wave-verifier
- **Depends**: w3-found-t1
- **Description**: Verify helpers.ts compiles. Check all functions are exported.

### Feature: executor-core
Files: extensions/wave-executor/index.ts

#### Task w3-exec-t1: Implement feature executor function
- **Agent**: worker
- **Files**: `extensions/wave-executor/feature-executor.ts`
- **Description**: Implement the function that executes a single feature's task DAG with sub-worktree isolation for parallel tasks.

  Import from: `./types.ts`, `./dag.ts`, `./helpers.ts`, `../subagent/git-worktree.ts`.

  ```typescript
  interface FeatureExecutorOptions {
    feature: Feature;
    featureWorktree: FeatureWorktree | null; // null if no git
    waveNum: number;
    specContent: string;
    cwd: string;                    // fallback cwd if no worktree
    maxConcurrency: number;
    signal?: AbortSignal;
    onTaskStart?: (task: Task) => void;
    onTaskEnd?: (task: Task, result: TaskResult) => void;
  }
  
  async function executeFeature(opts: FeatureExecutorOptions): Promise<FeatureResult>;
  ```

  Implementation:
  1. Build DAG from `feature.tasks` using `buildDAG()`
  2. For each DAG level:
     a. If 1 task → run directly in feature worktree (or cwd)
     b. If N tasks → create sub-worktrees, run each task in its sub-worktree, merge back, cleanup
  3. Use `runSubagent()` for each task (import from existing code)
  4. Build task prompt based on agent type (test-writer/worker/verifier) — same logic as current executor but using `extractSpecSections` for better spec context
  5. On task failure in verifier agent: run fix cycle (fix agent → re-verify, max 1 retry)
  6. On task failure: skip downstream dependents
  7. Return FeatureResult with all task results and overall pass/fail

  For `runSubagent`, reuse the existing function signature from `index.ts`. Import it or copy it — it spawns a `pi` process with `--mode json`.

#### Task w3-exec-t2: Implement wave executor function
- **Agent**: worker
- **Files**: `extensions/wave-executor/wave-executor.ts`
- **Description**: Implement the function that executes a complete wave: foundation → features (parallel) → merge → integration.

  Import from: `./types.ts`, `./dag.ts`, `./feature-executor.ts`, `./helpers.ts`, `../subagent/git-worktree.ts`.

  ```typescript
  interface WaveExecutorOptions {
    wave: Wave;
    waveNum: number;
    specContent: string;
    cwd: string;
    maxConcurrency: number;
    signal?: AbortSignal;
    onProgress?: (update: ProgressUpdate) => void;
  }
  
  interface ProgressUpdate {
    phase: "foundation" | "features" | "integration";
    features?: { name: string; status: "pending" | "running" | "done" | "failed" }[];
    currentTasks?: { id: string; status: "pending" | "running" | "done" | "failed" | "skipped" }[];
  }
  
  async function executeWave(opts: WaveExecutorOptions): Promise<WaveResult>;
  ```

  Implementation:
  1. **Foundation phase:**
     - Run foundation tasks using `executeDAG()` on base branch (cwd)
     - If git repo: commit foundation changes
     - If any foundation task fails: wave fails, skip features + integration
  
  2. **Feature phase:**
     - If git repo: create feature worktrees (all branch from post-foundation commit)
     - Launch `executeFeature()` for each feature concurrently (using `mapConcurrent`)
     - Each feature gets `Math.ceil(maxConcurrency / features.length)` concurrency slots (but still bounded by global max)
     - Wait for all features
  
  3. **Merge phase (git only):**
     - Merge successful feature branches into base
     - Report conflicts
     - If any feature failed: skip integration, wave fails
  
  4. **Integration phase:**
     - Run integration tasks using `executeDAG()` on merged base
     - If any fails: fix cycle, then retry
  
  5. Return WaveResult

#### Task w3-exec-t3: Rewrite index.ts to use new modules
- **Agent**: worker
- **Files**: `extensions/wave-executor/index.ts`
- **Depends**: w3-exec-t1, w3-exec-t2
- **Description**: Rewrite `index.ts` to use the new modular architecture. Keep the command registration (`/waves`, `/waves-spec`, `/waves-plan`, `/waves-execute`) and UI logic (progress widgets, status updates, log writing). Replace the inline execution logic with calls to `executeWave()`.

  Key changes to `/waves-execute` handler:
  1. Parse plan with `parsePlanV2()` (fall back to legacy parser for old plans)
  2. Validate all DAGs in all features (`validateDAG`)
  3. For each wave: call `executeWave()` with progress callbacks for UI
  4. Progress display: show features as parallel tracks, tasks within each
  5. Execution log: write per-feature, per-task results with timing

  Keep unchanged:
  - `/waves` command (list projects)
  - `/waves-spec` command (brainstorm flow)
  - `/waves-plan` command (planner invocation)
  - `runSubagent()` function (move to helpers or keep in index)
  - `buildBrainstormPrompt()` function
  - File access enforcement (`generateEnforcementExtension`, etc.)

  Remove:
  - Old `parsePlan()` (replaced by `parsePlanV2` with legacy compat)
  - Inline wave execution loop (replaced by `executeWave`)
  - `mapConcurrent` (moved to dag.ts or helpers)

#### Task w3-exec-t4: Verify executor compiles and integrates
- **Agent**: wave-verifier
- **Depends**: w3-exec-t3
- **Description**: Verify the full extension compiles:
  - Check all imports resolve between modules (types, dag, plan-parser, helpers, feature-executor, wave-executor, index)
  - Check `index.ts` still registers all three commands (`/waves`, `/waves-spec`, `/waves-plan`, `/waves-execute`)
  - Check `runSubagent` is accessible where needed
  - Verify no circular imports
  - Run `npx tsc --noEmit` on the extension directory if possible

### Feature: agent-prompts
Files: agents/wave-verifier.md, agents/worker.md

#### Task w3-agents-t1: Update agent prompts
- **Agent**: worker
- **Files**: `agents/wave-verifier.md`, `agents/worker.md`
- **Description**: Minor updates to agent prompts:

  **wave-verifier.md:**
  - Keep existing content (mandatory test execution, structured JSON output)
  - Add note: "You may be verifying a single feature's tasks or the full integration. Scope your checks accordingly."
  - Add note: "If working in a git worktree, run tests relative to the worktree root."
  - Keep `permissionMode: fullAuto`

  **worker.md:**
  - Keep existing content
  - Add note: "You may be working in a git worktree. Use relative paths. Don't assume you're in the repo root."
  - Keep `permissionMode: fullAuto`

#### Task w3-agents-t2: Verify agent prompts
- **Agent**: wave-verifier
- **Depends**: w3-agents-t1
- **Description**: Read both agent .md files. Verify frontmatter is intact (name, description, model, permissionMode). Verify new notes are present.

---

## Wave 4: Final Verification + Documentation
Working state: everything works end-to-end. README updated. Old code cleaned up.

### Foundation

#### Task w4-found-t1: Update README
- **Agent**: worker
- **Files**: `README.md`
- **Description**: Update the pi-wave-workflow README to document:
  - New plan format (foundation → features → integration)
  - Feature-parallel execution with git worktree isolation
  - DAG scheduling within features
  - Two levels of parallelism
  - New task ID convention: `w{wave}-{feature}-t{num}`
  - Backward compatibility with old flat plans
  - `permissionMode` on agent definitions

### Integration

#### Task w4-int-t1: End-to-end verification
- **Agent**: wave-verifier
- **Files**: all project files
- **Description**: Final verification of the entire refactor:
  1. Check all TypeScript files compile: `npx tsc --noEmit extensions/wave-executor/*.ts` (with appropriate flags/config)
  2. Check no orphaned imports (modules reference each other correctly)
  3. Check `index.ts` registers all commands
  4. Check `git-worktree.ts` exports feature-level functions
  5. Check `dag.ts` exports `validateDAG`, `buildDAG`, `executeDAG`
  6. Check `plan-parser.ts` exports `parsePlanV2`
  7. Check all agent .md files have valid frontmatter with `permissionMode: fullAuto`
  8. Check README documents the new architecture
  9. Verify backward compat: old plan format section in parser handles flat task lists
