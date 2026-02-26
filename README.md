# pi-wave-workflow

Complete development workflow package for [pi](https://github.com/badlogic/pi-mono). TDD wave-based parallel execution, subagent orchestration with git worktree isolation, feature branch management, code review, security guidance, and git automation.

## Install

```bash
pi install git:github.com/rHedBull/pi-wave
```

## What's Included

### Extensions

| Extension | Description |
|-----------|-------------|
| **wave-executor** | Wave-based TDD execution engine with `/spec`, `/plan`, `/waves`, `/waves-plan` commands |
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
| **spec-writer** | Interactive specification writer (hack/standard/enterprise) | Sonnet |
| **test-writer** | Writes tests from behavior descriptions | Sonnet |
| **wave-planner** | Creates TDD wave-based implementation plans | Sonnet |
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
| `/waves-plan <spec-path>` | Plan + execute from existing spec |

### Skills

| Skill | Description |
|-------|-------------|
| **pr-review** | Multi-agent parallel PR review with confidence scoring |

## Git Worktree Isolation

When parallel subagents need to write files, each gets its own git worktree:

```
Feature branch: pi/add-auth
  ├── worktree worker-0 → edits auth.ts
  ├── worktree worker-1 → edits api.ts
  └── worktree worker-2 → edits types.ts
  
After completion: auto-merge branches back
```

- **Automatic** — no configuration needed, activates when parallel agents have write tools
- **Safe** — merge conflicts detected and reported, branches preserved for manual resolution
- **Clean** — worktrees and branches cleaned up after merge
- **Fault-tolerant** — falls back to shared directory if not in a git repo

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

## Requirements

- [pi](https://github.com/badlogic/pi-mono) coding agent
- `git` (for worktree isolation and branch management)
- `gh` CLI (optional, for PR commands)
