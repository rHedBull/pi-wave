# pi-wave-workflow

TDD wave-based parallel execution workflow for [pi](https://github.com/badlogic/pi-mono).

## Install

```bash
# From git
pi install git:github.com/youruser/pi-wave-workflow

# Or from a local path
pi install /path/to/pi-wave-workflow
```

## Workflow

Three commands, three files, full control between each step:

```
/spec add OAuth2 support       → .pi/waves/add-oauth2-support/SPEC.md
/plan add-oauth2-support       → .pi/waves/add-oauth2-support/PLAN.md
/execute add-oauth2-support    → .pi/waves/add-oauth2-support/EXECUTION.md
```

### 1. `/spec <task>` — Create the specification

Scouts the codebase, then writes a detailed spec describing the expected end outcome: requirements, API changes, testing criteria.

Review and edit `SPEC.md` before proceeding.

### 2. `/plan <name> [extra instructions]` — Create the implementation plan

Reads `SPEC.md` and creates a wave-based plan following strict TDD:

```
Wave 1: Foundation — Tests          🧪 test-writer agents (parallel)
Wave 2: Foundation — Implementation 🔨 worker agents (parallel, must make tests pass)
Wave 3: Foundation — Verification   🔍 verifier (runs tests, checks types)
Wave 4: Core Logic — Tests          🧪 ...
Wave 5: Core Logic — Implementation 🔨 ...
...
```

Review and edit `PLAN.md` before proceeding — add/remove tasks, reorder waves.

### 3. `/execute <name>` — Run the plan

Executes each wave with up to 6 parallel agents. Between waves, a verifier checks that tests pass. If verification fails, a fix attempt runs automatically.

### `/waves` — List projects

Shows all wave projects and their status.

## TDD Enforcement

Tests are always written **before** implementation, by **different agents**:

- 🧪 **test-writer** — writes failing tests that define expected behavior
- 🔨 **worker** — writes implementation to make tests pass
- 🔍 **wave-verifier** — runs tests, checks types, validates integration

## File Access Enforcement

Each sub-agent gets a generated enforcement extension that blocks unauthorized file operations at the tool level:

| Agent | Write Access | Bash |
|-------|-------------|------|
| Scout | ❌ None | Safe only |
| Spec writer | Only its `SPEC.md` | Safe only |
| Wave planner | Only its `PLAN.md` | Safe only |
| Test writer | Only its listed test files | Safe only |
| Worker | Only its listed impl files (not test files) | Full |
| Verifier | ❌ None | Full (runs tests) |

SPEC.md and PLAN.md are **protected during execution** — no agent can modify them.

## Agents

Bundled agent definitions in `agents/`:

| Agent | Model | Purpose |
|-------|-------|---------|
| `scout` | Haiku | Fast codebase reconnaissance |
| `spec-writer` | Sonnet | Writes detailed specifications |
| `wave-planner` | Sonnet | Creates TDD wave plans |
| `test-writer` | Sonnet | Writes tests before implementation |
| `worker` | Sonnet | General-purpose implementation |
| `wave-verifier` | Sonnet | Verification and test running |

Edit `agents/*.md` to change models, tools, or system prompts.

## Prompt Templates

| Command | Description |
|---------|-------------|
| `/waves <task>` | Shorthand for `/spec <task>` |
| `/waves-plan <task>` | Shorthand for `/spec <task>` (plan only) |

## Configuration

Edit `extensions/wave-executor/index.ts` to change:

- `MAX_CONCURRENCY` (default: 6) — parallel agents per wave
- `MAX_RETRIES_PER_WAVE` (default: 1) — fix attempts on verification failure

## License

MIT
