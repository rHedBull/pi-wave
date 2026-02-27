# pi-wave-workflow

Complete development workflow package for [pi](https://github.com/badlogic/pi-mono). Feature-parallel DAG-based wave execution with git worktree isolation, subagent orchestration, feature branch management, code review, security guidance, and git automation.

## Install

```bash
pi install git:github.com/rHedBull/pi-wave
```

## What's Included

### Extensions

| Extension | Description |
|-----------|-------------|
| **wave-executor** | Feature-parallel DAG execution engine with `/waves-spec`, `/waves-plan`, `/waves-execute`, `/waves` commands |
| **subagent** | Delegate tasks to specialized agents — single, parallel (with git worktree isolation), or chained |
| **git-workflow** | `/feature-branch` and `/feature-done` commands for feature branch lifecycle |
| **security-guidance** | Pre-write security checks (XSS, injection, eval, hardcoded secrets, etc.) |
| **handoff** | Session continuity across devices with `/handoff` and `/pickup` |
| **wip** | Persistent project memory with `/wip` and `/ideas` |

### Agents

| Agent | Purpose | Model |
|-------|---------|-------|
| **scout** | Fast codebase recon, returns structured context | Haiku |
| **planner** | Creates implementation plans from context | Sonnet |
| **worker** | General-purpose implementation agent | Sonnet |
| **reviewer** | Code review for quality and security | Sonnet |
| **pr-reviewer** | PR-specific review with confidence scoring | Sonnet |
| **spec-writer** | Specification writer templates (hack/standard/enterprise) — used standalone | Sonnet |
| **test-writer** | Writes tests from behavior descriptions | Sonnet |
| **wave-planner** | Creates feature-parallel DAG-based implementation plans | Sonnet |
| **wave-verifier** | Verifies wave task completion | Sonnet |

### Prompt Templates (Commands)

| Command | Description |
|---------|-------------|
| `/implement <task>` | Feature branch → scout → plan → implement |
| `/implement-and-review <task>` | Feature branch → implement → review → apply feedback |
| `/scout-and-plan <task>` | Scout gathers context → planner creates plan (no implementation) |
| `/commit` | Auto-generate commit message, stage, commit |
| `/commit-push-pr` | Commit + push + create PR in one step |
| `/clean-gone` | Clean up local branches deleted from remote |
| `/waves <description>` | Full wave workflow: spec → plan → execute |

### Skills

| Skill | Description |
|-------|-------------|
| **pr-review** | Multi-agent parallel PR review with confidence scoring |

## Architecture: Feature-Parallel DAG Execution

The wave executor uses a three-phase execution model within each wave:

```
Wave (= Milestone)
│
├── Foundation (sequential, on base branch)
│   Creates shared contracts (types, interfaces, config)
│   Commits to base branch before features start
│
├── Features (parallel, each in own git worktree)
│   Feature A ─── branch: wave-1/feature-a
│   │ Tasks follow a DAG:
│   │   Level 0: tasks with no deps → parallel (sub-worktrees)
│   │   Level 1: tasks depending on level 0 → sequential
│   │   Level 2: etc.
│   │
│   Feature B ─── branch: wave-1/feature-b
│   │ Runs simultaneously with Feature A
│   │
│   (each feature merges internally at each DAG level)
│
├── Merge (feature branches → base branch)
│
└── Integration (sequential, on merged base)
    Glue code + full verification
```

### Two Levels of Parallelism

1. **Across features** — each feature runs in its own git worktree on a dedicated branch, providing full file-system isolation
2. **Within features** — tasks follow a DAG; parallel tasks at the same level get sub-worktrees, sequential tasks reuse the feature worktree

### Plan Format

Plans use a structured Markdown format with Foundation/Feature/Integration sections:

```markdown
## Wave 1: Basic Working App

### Foundation
#### Task w1-found-t1: Create shared types
- **Agent**: worker
- **Files**: `src/types.ts`
- **Description**: ...

### Feature: auth
Files: src/auth.ts, tests/test_auth.ts

#### Task w1-auth-t1: Write auth tests
- **Agent**: test-writer
- **Files**: `tests/test_auth.ts`
- **Description**: ...

#### Task w1-auth-t2: Implement auth
- **Agent**: worker
- **Files**: `src/auth.ts`
- **Depends**: w1-auth-t1
- **Description**: ...

### Integration
#### Task w1-int-t1: Wire up app
- **Agent**: worker
- **Files**: `src/main.ts`
- **Description**: ...
```

### Task ID Convention

Task IDs follow: `w{wave}-{feature}-t{num}` (e.g., `w1-auth-t1`, `w2-found-t2`, `w1-int-t1`)

### Backward Compatibility

Old flat plans (no `### Feature:` headers) still work — they're wrapped in a single "default" feature and executed without worktree isolation.

## Git Worktree Isolation

When parallel features execute, each gets its own git worktree:

```
Base branch (foundation committed here)
  ├── worktree wave-1/auth   → feature A's tasks
  ├── worktree wave-1/data   → feature B's tasks
  └── worktree wave-1/ui     → feature C's tasks
  
After completion: auto-merge feature branches back to base
```

Within a feature, parallel tasks at the same DAG level get sub-worktrees:

```
Feature worktree wave-1/auth
  ├── sub-worktree wave-1/auth/t1 → parallel task 1
  └── sub-worktree wave-1/auth/t2 → parallel task 2
  
After level completes: merge sub-worktrees back to feature
```

- **Automatic** — no configuration needed
- **Safe** — merge conflicts detected and reported, branches preserved
- **Clean** — worktrees and branches cleaned up after merge
- **Fault-tolerant** — falls back to sequential execution if not in a git repo

## Feature Branch Workflow

```
/implement Add OAuth      → creates pi/add-oauth branch
                           → scout → planner → worker  
                           → reports diff + next steps

/feature-done             → shows branch summary
/commit-push-pr           → pushes + creates PR
```

Feature branches are never auto-merged to main. The user always controls when work lands.

## Security Guidance

Automatically checks code being written for:
- GitHub Actions workflow injection
- `child_process.exec()` / `os.system()` command injection
- `eval()` / `new Function()` code injection
- `dangerouslySetInnerHTML` / `innerHTML` XSS
- `pickle` deserialization risks
- SQL injection patterns
- Hardcoded secrets/credentials
- Insecure HTTP URLs

Shows a warning and asks for confirmation before proceeding.

## Agent Configuration

All agents that run as subagents require `permissionMode: fullAuto` in their frontmatter to execute bash commands without permission prompts.

## Requirements

- [pi](https://github.com/badlogic/pi-mono) coding agent
- `git` (for worktree isolation and branch management)
- `gh` CLI (optional, for PR commands)
