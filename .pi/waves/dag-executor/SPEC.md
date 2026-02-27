# DAG Executor — Specification

## Overview

Redesign the wave execution system from flat parallel task lists to a **feature-parallel DAG model** with git worktree isolation. Waves become milestones that deliver working increments. Within each wave, independent features execute in parallel — each on its own git branch/worktree — while tasks within a feature follow a dependency graph (test → implement → verify). At wave end, feature branches merge and integration verification runs.

## Current State

### Architecture
- **Plan format:** Waves contain flat lists of tasks. All tasks in a wave run in parallel (up to MAX_CONCURRENCY). No dependencies between tasks within a wave.
- **Executor (`wave-executor/index.ts`):** Uses `mapConcurrent()` to run all wave tasks simultaneously. Verification runs as a separate agent after all tasks complete. Retry logic: fix agent → re-verify.
- **Git worktrees (`git-worktree.ts`):** Infrastructure exists for per-task worktree isolation but is **not used** by the executor. Designed for flat task parallelism, not feature-level branching.
- **Planner (`wave-planner.md`):** Generates sequential waves with flat task lists. TDD cycle is expressed as separate waves (test wave → impl wave → verify wave) or same-wave parallel tasks.

### Key Files

| File | Purpose | Change |
|------|---------|--------|
| `extensions/wave-executor/index.ts` | Wave execution engine | **Major rewrite** — DAG scheduler, feature isolation, merge |
| `extensions/subagent/git-worktree.ts` | Git worktree helpers | **Adapt** — feature-level (not task-level) worktrees |
| `agents/wave-planner.md` | Planner agent prompt | **Major rewrite** — feature-based plan format |
| `agents/wave-verifier.md` | Verifier agent prompt | **Minor update** — feature-scope and integration-scope verification |
| `agents/worker.md` | Worker agent prompt | **Minor update** — awareness of feature branch context |
| `agents/test-writer.md` | Test writer prompt | **No change** |

### Problems with Current Model

1. **No task dependencies within a wave** — all tasks launch simultaneously, can't express "run tests first, then implement"
2. **No git isolation** — parallel agents write to the same working directory, risking file conflicts
3. **Flat parallelism wastes time** — all tasks must finish before the wave advances, even if some are independent
4. **TDD cycle broken by parallelism** — test-writer and worker run simultaneously from spec, can't read each other's output, leading to naming mismatches
5. **Verification is all-or-nothing** — one failure blocks the entire wave, even if other features are fine
6. **No feature-level organization** — planner can't express "auth is independent from data layer"

## User Decisions

| Topic | Decision |
|-------|----------|
| Execution model | Feature-parallel DAG within waves |
| Git isolation | One worktree per feature (not per task) |
| TDD cycle | Preserved: test → implement → verify per task, sequential within feature |
| Branching | Feature branches per wave, merge at wave end |
| Wave = Milestone | Each wave delivers a working increment |
| Parallelism | Between features (different worktrees), and within features where DAG allows |
| Verification | Per-task verification (verifier checks tests pass), plus integration verification at wave end |

---

## Functional Requirements

### Plan Format (FR-PLAN)

1. **FR-PLAN-1:** Plan format supports **waves** as milestones with a description of what "working" means at wave end
2. **FR-PLAN-2:** Each wave contains one or more **features** — independent units of work
3. **FR-PLAN-3:** Each feature contains **tasks** with explicit dependency declarations (`depends: [task-id, ...]`)
4. **FR-PLAN-4:** Tasks with no dependencies within a feature can run in parallel
5. **FR-PLAN-5:** Features within a wave run in parallel (each in its own worktree)
6. **FR-PLAN-6:** Each wave may have an **integration** section — tasks that run after all features merge
7. **FR-PLAN-7:** Tasks specify agent type: `test-writer`, `worker`, `wave-verifier`
8. **FR-PLAN-8:** Plan format is human-readable Markdown, editable before execution
9. **FR-PLAN-9:** Features specify which files they own (for worktree scoping and conflict detection)
10. **FR-PLAN-10:** Plan parser validates that dependency references exist and are acyclic (no circular deps)

### DAG Execution (FR-DAG)

11. **FR-DAG-1:** Executor parses task dependencies and builds a DAG per feature
12. **FR-DAG-2:** Tasks run as soon as all their dependencies complete successfully
13. **FR-DAG-3:** If a task fails, downstream tasks in that feature are skipped (fail-fast within feature)
14. **FR-DAG-4:** Feature failure does not block other features (they continue independently)
15. **FR-DAG-5:** Feature failure blocks the integration phase (can't merge broken branches)
16. **FR-DAG-6:** Executor displays real-time progress: which features are running, which tasks within each, which are waiting/done/failed
17. **FR-DAG-7:** MAX_CONCURRENCY limits total simultaneous agent processes across all features

### Git Isolation (FR-GIT)

**Feature-level isolation:**
18. **FR-GIT-1:** Each feature in a wave gets its own git worktree on a feature branch
19. **FR-GIT-2:** Feature branch naming: `wave-{N}/{feature-name}` (e.g., `wave-1/auth`)
20. **FR-GIT-3:** Feature worktrees branch from the post-foundation commit (so they all have shared contracts)
21. **FR-GIT-4:** Before creating worktrees, checkpoint any uncommitted changes on the base branch
22. **FR-GIT-5:** After all features complete, merge feature branches into the base branch
23. **FR-GIT-6:** On merge conflict, preserve both branches and report the conflict for manual resolution
24. **FR-GIT-7:** Integration tasks run on the merged result (base branch after all merges)
25. **FR-GIT-8:** Clean up worktrees and feature branches after successful merge
26. **FR-GIT-9:** If not in a git repo, fall back to sequential feature execution (no isolation) with a warning

**Within-feature task isolation:**
27. **FR-GIT-10:** Parallel tasks within a feature (same DAG level, no deps between them) each get a **sub-worktree** branching from the feature branch
28. **FR-GIT-11:** Sub-worktree branch naming: `wave-{N}/{feature-name}/{task-id}` (e.g., `wave-1/auth/t1`)
29. **FR-GIT-12:** When all parallel tasks at a DAG level complete, merge their sub-worktrees back into the feature branch, then clean up sub-worktrees
30. **FR-GIT-13:** Sequential tasks (with dependencies on prior tasks) run directly in the feature worktree — no sub-worktree needed
31. **FR-GIT-14:** If only one task runs at a DAG level (no parallelism), skip sub-worktree creation — run in feature worktree directly

### TDD Cycle (FR-TDD)

28. **FR-TDD-1:** Within a feature, the standard task flow is: test-writer → worker → verifier
29. **FR-TDD-2:** Test-writer creates test files, worker implements to make tests pass, verifier confirms
30. **FR-TDD-3:** Verifier runs the actual test suite (not just static review) — must execute `pytest`, `npm test`, etc.
31. **FR-TDD-4:** If verifier fails, a fix cycle runs: fix agent attempts repair → verifier re-checks (max 1 retry per task)
32. **FR-TDD-5:** Fix agent gets the verifier output + spec context to guide repairs

### Foundation Phase (FR-FOUND)

33. **FR-FOUND-1:** Each wave may define a **foundation** section — tasks that run before any features start
34. **FR-FOUND-2:** Foundation creates shared files that multiple features depend on (types, interfaces, config, test fixtures, package files)
35. **FR-FOUND-3:** Foundation tasks are committed to the base branch before feature worktrees are created — so all features branch from a state that includes the shared contracts
36. **FR-FOUND-4:** The planner defines the exact interfaces/types/signatures in the plan. Foundation agents simply materialize those contracts as code files. The thinking is done in planning, foundation is execution only.
37. **FR-FOUND-5:** Foundation includes a verifier task that confirms shared files are syntactically valid and importable

### Integration Phase (FR-INT)

38. **FR-INT-1:** After all features merge, integration tasks run sequentially
39. **FR-INT-2:** Integration typically includes: glue code (wiring modules together) + full test suite run
40. **FR-INT-3:** Integration failure triggers a fix cycle with access to all files
41. **FR-INT-4:** Wave is marked complete only after integration verification passes

### Planner (FR-PLANNER)

37. **FR-PLANNER-1:** Planner thinks in milestones: each wave delivers a working, testable increment
38. **FR-PLANNER-2:** Planner groups tasks into features based on file ownership and logical boundaries
39. **FR-PLANNER-3:** Planner identifies inter-task dependencies within features
40. **FR-PLANNER-4:** Planner specifies canonical names/conventions in every task description to prevent mismatches between parallel agents
41. **FR-PLANNER-5:** Planner targets 2-5 waves for typical projects, 3-8 features per wave, 2-6 tasks per feature

---

## Non-Functional Requirements

1. **NFR-1:** (removed — execution time varies by task complexity and LLM latency)
2. **NFR-2:** Progress display updates in real-time showing feature and task status
3. **NFR-3:** Execution log (`EXECUTION.md`) captures per-feature, per-task timing and results
4. **NFR-4:** Graceful handling of LLM rate limits — retry with backoff, don't crash
5. **NFR-5:** Ctrl+C aborts all running agents and cleans up worktrees
6. **NFR-6:** Plan format is backward-compatible — flat plans (no features) still work as a single feature with all tasks
7. **NFR-7:** Git worktree cleanup runs even on crashes (signal handlers)
8. **NFR-8:** Total agent processes respect MAX_CONCURRENCY (default 12) across all features

---

## Data Model Changes

### New Plan Format

```markdown
# Implementation Plan

## Goal
One sentence.

## Wave 1: Basic Working App
Working state: server starts, single page loads, auth works.

### Foundation
Shared contracts and infrastructure. Committed before features branch.
The planner has already defined all interfaces — foundation just creates the files.

#### Task w1-found-t1: Create shared types and interfaces
- **Agent**: worker
- **Files**: `backend/config.py`, `backend/database.py`, `backend/models.py`
- **Description**: Create the data contracts all features build against.
  (Planner provides exact signatures, schema, field names here)

#### Task w1-found-t2: Create project scaffolding
- **Agent**: worker
- **Files**: `backend/__init__.py`, `backend/tests/__init__.py`, `backend/routers/__init__.py`, `backend/requirements.txt`, `backend/tests/conftest.py`
- **Description**: Package files, dependencies, test fixtures.

#### Task w1-found-t3: Verify foundation
- **Agent**: wave-verifier
- **Depends**: w1-found-t1, w1-found-t2
- **Description**: Verify imports work, schema is valid, conftest fixtures load.

### Feature: auth
Files: backend/auth.py, backend/routers/auth.py, backend/tests/test_auth.py

#### Task w1-auth-t1: Write auth tests
- **Agent**: test-writer
- **Files**: `backend/tests/test_auth.py`
- **Depends**: (none)
- **Description**: ...

#### Task w1-auth-t2: Implement auth module
- **Agent**: worker
- **Files**: `backend/auth.py`
- **Depends**: w1-auth-t1
- **Tests**: `backend/tests/test_auth.py`
- **Description**: ...

#### Task w1-auth-t3: Implement auth router
- **Agent**: worker
- **Files**: `backend/routers/auth.py`
- **Depends**: w1-auth-t1, w1-auth-t2
- **Description**: ...

#### Task w1-auth-t4: Verify auth
- **Agent**: wave-verifier
- **Files**: `backend/auth.py`, `backend/routers/auth.py`
- **Depends**: w1-auth-t2, w1-auth-t3
- **Description**: Run `pytest tests/test_auth.py -v`

### Feature: data-layer
Files: backend/database.py, backend/models.py, backend/config.py

#### Task w1-data-t1: Write data tests
...

#### Task w1-data-t2: Implement database
- **Depends**: (none)
...

### Integration
Tasks that run after all features are merged.

#### Task w1-int-t1: Wire up main.py
- **Agent**: worker
- **Files**: `backend/main.py`
- **Description**: Import all routers, create app, configure middleware...

#### Task w1-int-t2: Integration verification
- **Agent**: wave-verifier
- **Depends**: w1-int-t1
- **Description**: Run full test suite, verify server starts...

---

## Wave 2: Full CRUD
Working state: all issue and comment endpoints work, frontend shows list.
...
```

### Parsed Data Structures

```typescript
interface Plan {
  goal: string;
  waves: Wave[];
}

interface Wave {
  name: string;
  description: string;          // what "working" means at wave end
  foundation: Task[];           // shared contracts + scaffolding, run first on base branch
  features: Feature[];          // parallel features, each in own worktree
  integration: Task[];          // tasks that run after all features merge
}

interface Feature {
  name: string;
  files: string[];              // files this feature owns (for worktree scoping)
  tasks: Task[];
}

interface Task {
  id: string;                   // e.g., "w1-auth-t1"
  title: string;
  agent: string;                // "test-writer" | "worker" | "wave-verifier"
  files: string[];
  depends: string[];            // task IDs this depends on (within same feature)
  specRefs: string[];
  testFiles: string[];
  description: string;
}
```

---

## Integration Strategy

### Approach
Incremental refactor of the existing wave executor. The plan parser, DAG scheduler, and git integration are new code. The subagent runner (`runSubagent`) is reused as-is.

### Dependency Map

```
wave-executor/index.ts (main changes)
  ├── NEW: parsePlanV2() — parses feature-based plan format
  ├── NEW: DAGScheduler — runs tasks respecting dependencies
  ├── ADAPTED: git-worktree.ts — feature-level worktrees
  ├── REUSED: runSubagent() — unchanged
  ├── REUSED: extractFinalOutput() — unchanged
  └── REUSED: mapConcurrent() — used within DAG scheduler

wave-planner.md (new prompt)
  └── generates feature-based plan format

wave-verifier.md (minor update)
  └── feature-scoped and integration-scoped verification
```

### Backward Compatibility
- **FR-NFR-6:** If the parser detects no `### Feature:` headers, treat the entire wave as a single feature with a flat task list (dependencies inferred from task order). This preserves existing plans.

### Migration
- No data migration needed — plans are regenerated per project
- Old PLAN.md files still parse (backward compat)

---

## Error Handling Strategy

### Task Failure
- Task fails → mark as failed → skip all downstream tasks in that feature
- Other features continue unaffected
- Feature marked as failed → excluded from merge → integration skipped if any feature failed

### Merge Conflict
- Attempt merge → conflict → `git merge --abort` → preserve branch for inspection
- Report conflict with branch names and affected files
- Other features still merge (order-independent merges)
- Integration skipped (can't run on partial merge)

### Fix Cycle
- Verifier fails → spawn fix agent with verifier output → re-run verifier (max 1 retry)
- Fix agent works in the same worktree as the feature
- If fix fails → feature marked as failed

### No Git Repo
- Warning: "Not a git repo, running without isolation"
- Fall back to shared directory — features run sequentially to avoid file conflicts
- Within a feature, tasks still follow DAG

### Abort (Ctrl+C)
- SIGINT handler kills all running agent processes
- Cleanup: remove worktrees, delete temp branches, restore checkpoint if exists

---

## Affected Files

### Modified
| File | Change |
|------|--------|
| `extensions/wave-executor/index.ts` | Major rewrite: DAG scheduler, feature execution, git integration, new plan parser |
| `extensions/subagent/git-worktree.ts` | Adapt for feature-level worktrees (prepare per feature, not per task) |
| `agents/wave-planner.md` | Rewrite: feature-based milestone planning |
| `agents/wave-verifier.md` | Update: feature-scope and integration-scope context |
| `agents/worker.md` | Minor: note about working in feature branch context |

### New
| File | Purpose |
|------|---------|
| `extensions/wave-executor/dag.ts` | DAG scheduler: dependency resolution, topological task ordering |
| `extensions/wave-executor/types.ts` | Shared TypeScript interfaces (Plan, Wave, Feature, Task) |
| `extensions/wave-executor/plan-parser.ts` | Plan Markdown parser (v2 format with features) |

### Unchanged
| File | Reason |
|------|--------|
| `agents/test-writer.md` | No changes needed — receives same task format |
| `agents/scout.md` | Not part of execution |
| `extensions/subagent/index.ts` | Subagent tool unchanged — executor calls runSubagent directly |

---

## Testing Criteria

### Unit Tests (if applicable — this is an extension, testing may be manual)

| Test | Description |
|------|-------------|
| Plan parser: feature format | Parse a plan with features, tasks, dependencies → correct data structures |
| Plan parser: backward compat | Parse old flat plan format → single feature with all tasks |
| Plan parser: cycle detection | Plan with circular deps → error |
| DAG scheduler: simple chain | A→B→C executes in order |
| DAG scheduler: parallel | A, B (no deps) → both start immediately |
| DAG scheduler: diamond | A→B, A→C, B→D, C→D → A first, B+C parallel, D last |
| DAG scheduler: fail-fast | A→B→C, B fails → C skipped, A marked done |
| DAG scheduler: concurrency | 20 tasks, MAX_CONCURRENCY=5 → max 5 running at once |
| Git worktree: feature branch | Creates worktree with correct branch name |
| Git worktree: merge | Two features, no conflict → both merge |
| Git worktree: conflict | Two features modify same file → conflict reported, branches preserved |
| Git worktree: cleanup | After merge, worktrees and branches removed |
| Git worktree: no git | Non-git directory → returns null, executor falls back |

### Integration Tests (manual verification)

| Test | Description |
|------|-------------|
| Small project | Run full cycle on a 2-wave, 3-feature plan → milestones achieved |
| Feature failure | One feature fails, others succeed → partial merge, clear error report |
| Abort | Ctrl+C during execution → clean worktree cleanup |
| Rate limit | Simulate slow LLM → tasks queue correctly, don't exceed MAX_CONCURRENCY |

---

## Parallelism Model

Two levels of parallelism operate simultaneously:

### Level 1: Across Features (git-isolated)
Features within a wave run in parallel, each in its own **git worktree** on a dedicated branch. This provides full file-system isolation — feature A's agents can't see or corrupt feature B's files. Merging happens at wave end.

### Level 2: Within a Feature (DAG-driven, conditional isolation)
Tasks within a single feature follow a dependency DAG. The isolation strategy depends on whether tasks run simultaneously:

- **Parallel tasks (same DAG level, no deps between them):** Each gets its own **sub-worktree** branching from the feature branch. When all parallel tasks at that level complete, their sub-worktrees merge back into the feature branch. This prevents file corruption if two agents accidentally touch the same file.
- **Sequential tasks (has dependency on a prior task):** Runs directly in the **feature worktree**, which already contains the output of completed tasks. No extra worktree needed — the task needs to see prior output anyway.

This gives isolation where it matters (parallel execution) with zero overhead where it doesn't (sequential execution).

```
Feature: auth (feature worktree)
│
│ DAG Level 0 — parallel, separate sub-worktrees:
│   t1 [test-writer] → sub-worktree auth-t1
│   t2 [worker]      → sub-worktree auth-t2
│   (complete → merge auth-t1, auth-t2 back into feature worktree)
│
│ DAG Level 1 — sequential, reuse feature worktree:
│   t3 [worker]      → feature worktree (sees t1+t2 output)
│
│ DAG Level 2 — sequential, reuse:
│   t4 [verifier]    → feature worktree (sees everything)
```

**Example of both levels working together:**

```
Wave 1 (foundation + 3 features + integration)
│
├─ Foundation (sequential on base branch)
│   ├─ worker: config.py, database.py, models.py  ← contracts
│   ├─ worker: conftest.py, __init__.py files      ← scaffolding
│   └─ verifier: imports work                       ← sanity check
│   (commit → feature worktrees branch from here)
│
├─ Feature: auth (worktree: /tmp/wt/auth/)
│   ├─ t1 [test-writer: test_auth.py]  ──┐ parallel (level 2)
│   ├─ t2 [worker: auth.py]             ──┘ (different files, same worktree)
│   ├─ t3 [worker: routers/auth.py]      ← depends on t1, t2
│   └─ t4 [verifier]                     ← depends on t3
│
├─ Feature: data-tests (worktree: /tmp/wt/data/)  ← parallel with auth (level 1)
│   ├─ t1 [test-writer: test_db.py]     ──┐
│   ├─ t2 [test-writer: test_models.py]  ──┘ parallel (level 2)
│   └─ t3 [verifier]                     ← depends on t1, t2
│
└─ Feature: ui-scaffold (worktree: /tmp/wt/ui/)   ← parallel with both (level 1)
    ├─ t1 [worker: package.json, next.config]
    ├─ t2 [worker: types.ts, api.ts]      ← depends on t1
    └─ t3 [verifier: npm run build]        ← depends on t2
│
└─ Integration (after merge)
    ├─ worker: main.py (wires routers)
    └─ verifier: full test suite + server starts
```

At peak: up to ~6 agents running simultaneously (2 per feature × 3 features), all respecting MAX_CONCURRENCY.

---

## Execution Model (detailed)

```
/waves-execute project-name

1. Parse PLAN.md → Plan { waves[] }
   Each wave has: foundation[], features[], integration[]

2. For each wave:
   a. Display milestone: "Wave 1: Basic Working App"
   
   b. Checkpoint git state (commit uncommitted changes)
   
   c. Run foundation tasks (on base branch, DAG-ordered):
      - worker: create shared types/interfaces (contracts defined by planner)
      - worker: create scaffolding (conftest, __init__, requirements)
      - verifier: confirm imports work
      - Commit foundation to base branch
   
   d. Create feature worktrees (all branch from post-foundation commit):
      - wave-1/auth → /tmp/pi-worktrees-XXX/auth/
      - wave-1/data → /tmp/pi-worktrees-XXX/data/
      (each worktree already has foundation files)
   
   e. Launch features in parallel:
      Feature "auth" (in worktree wave-1/auth):
        DAG scheduler runs tasks:
          t1 [test-writer] → starts immediately (no deps)
          t2 [worker] → starts when t1 completes
          t3 [worker] → starts when t1, t2 complete
          t4 [verifier] → starts when t2, t3 complete
            → if fail: fix agent → re-verify
      
      Feature "data" (in worktree wave-1/data):
        DAG scheduler runs tasks in parallel with auth:
          t1 [test-writer] → starts immediately
          t2 [worker] → starts immediately (no deps on t1 here)
          t3 [worker] → starts immediately
          t4 [verifier] → starts when t1, t2, t3 complete
   
   f. Wait for all features to complete
   
   g. Merge feature branches:
      - git merge wave-1/auth → base
      - git merge wave-1/data → base
      - Clean up worktrees and branches
   
   h. Run integration tasks (on merged base, DAG-ordered):
      - worker: wire up main.py (glue code)
      - verifier: full test suite + server starts
   
   i. Wave complete → milestone achieved

3. Repeat for wave 2, 3, ...
```

---

## Out of Scope

- **Parallel wave execution** — waves remain sequential (milestone dependency)
- **Cross-feature task dependencies** — tasks only depend on tasks within the same feature. Cross-feature deps are handled by the integration phase.
- **Automatic conflict resolution** — merge conflicts require manual intervention
- **Custom merge strategies** — always uses `git merge --no-ff`
- **Worktree reuse across waves** — fresh worktrees each wave
- **Plan auto-generation from spec** — planner agent still generates the plan, this spec only covers execution
- **Remote git operations** — no push/pull, local only

---

## Open Questions

1. **Feature dependency ordering:** Should features within a wave support explicit dependencies (feature B starts after feature A completes)? Current design says no — use integration phase instead. But some cases might benefit from it.
2. **Shared foundation feature:** Some tasks (like `conftest.py`, `__init__.py`) are needed by all features. Should there be a special "foundation" feature that runs first and merges before other features start?
3. **Worktree overhead:** Creating git worktrees takes ~1-2s per feature. For waves with many small features, this adds up. Is there a threshold below which we skip isolation?
4. **MAX_CONCURRENCY allocation:** Should concurrency be split evenly across features, or should faster features get more slots? Current plan: global pool, first-come-first-served.
