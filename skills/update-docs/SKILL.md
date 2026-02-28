---
name: update-docs
description: Create and update project documentation to match current code. Analyzes git changes, reads source files, and updates or creates README and doc files. Use when code has changed and docs need to catch up, or to audit docs for accuracy.
---

# Update Docs

Create or update project documentation so it accurately reflects the current codebase.

## Documentation philosophy

There are two layers:

1. **`README.md` (root)** — The entry point. Concise. Gets someone from zero to running in minutes.
2. **`docs/` directory** — The deep dives. Every detail, every option, every edge case lives here.

The root README links to docs. It never tries to be comprehensive itself.

## Docs structure

Scale the `docs/` layout to match the project's complexity:

**Small/medium projects** — flat files in `docs/`:

```
docs/
├── architecture.md      # always exists — system overview, modules, data flow
├── <module>.md           # one per module/service
└── ...
```

**Multi-service projects** — subdirectories per service, plus top-level overview docs:

```
docs/
├── architecture.md      # always exists — high-level system overview, how services connect
├── deployment.md        # how to deploy, infrastructure, environments, CI/CD
├── <service>/
│   ├── architecture.md  # service-level internals, data model, design decisions
│   ├── <reference>.md   # commands, endpoints, etc.
│   └── ...
└── ...
```

Rules for choosing the layout:
- **3+ services or independently deployable units** → use subdirectories
- **`docs/architecture.md`** always exists at the top level, even with subdirectories. It covers the full system: what services exist, how they communicate, shared infrastructure, data flow between services.
- **`docs/deployment.md`** should exist for any project that runs in production — covers environments, infrastructure, CI/CD pipelines, secrets, monitoring, rollback procedures.
- **Per-service `architecture.md`** covers that service's internals: its own data model, internal design decisions, package structure. The top-level one covers how services fit together.
- When migrating from flat to subdirectories, update all README links.

## Style rules

- **Concise over complete.** If it's getting long, move detail to `docs/`.
- **No fluff.** No "Welcome to...", no badges, no "Getting Started" preamble that says nothing.
- **Commands are copy-pasteable.** Every shell block should work if pasted verbatim.
- **Show, don't describe.** A code example beats a paragraph of explanation.
- **No aspirational content.** Only document what the code actually does right now.
- **Plain language.** No marketing speak, no "simply", no "just", no "easily".
- **Preserve existing tone.** When updating, match the style that's already there.

## Workflow

### Step 1: Discover project structure

Before anything else, understand the project:
1. Read the existing `README.md` and any files in `docs/`
2. List top-level directories to identify modules/services
3. Look at `package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`, `Makefile`, `docker-compose.yml` etc. to understand the tech stack and entry points

### Step 2: Identify what changed

Run `git diff --name-only HEAD` to see uncommitted changes. If there are no uncommitted changes, compare against the last few commits with `git diff --name-only HEAD~3..HEAD`.

If the user specified a scope (e.g., a module or service name), focus only on that area.

If there are no changes at all, do a full audit — compare all existing docs against the current code.

### Step 3: Map changes to documentation

For each changed source file, determine:
- Does it affect the root README? (e.g., new commands, changed setup steps, new modules)
- Does it affect `docs/architecture.md`? (e.g., new services, changed data model, new storage layer, changed communication patterns)
- Does it affect `docs/deployment.md`? (e.g., new env vars, changed infra, new CI steps)
- Which module-specific doc does it affect?

If a doc file doesn't exist yet but should, create it.

### Step 4: Read the source files and existing docs

For each affected area:
1. Read the changed source files to understand what's new or different
2. Read the existing documentation
3. Compare what the docs say vs what the code actually does

### Step 5: Update the root README.md

The root README must stay concise. It should contain **only** these sections, in this order:

1. **Title + one-liner** — what this project is, one sentence
2. **Setup** — prerequisites, install commands, everything to go from fresh clone to running
3. **Usage** — all the commands to start servers, run the tool, etc. A small first-use walkthrough (the smallest useful thing someone can do)
4. **Project structure** — brief directory overview (2-4 lines, not a tree dump)
5. **Docs** — links to detailed docs in `docs/` with one-line descriptions
6. **License**

If the README is growing beyond ~100-150 lines, something needs to move to `docs/`.

### Step 6: Update detailed docs in `docs/`

These can be as long and thorough as needed.

**`docs/architecture.md`** — Must always exist. Starts with the big picture, then drills down:
1. **System overview** — what modules/services exist, how they communicate, ASCII diagram of the full system. This comes first, always.
2. **Data flow** — write path and read path, how data moves between modules
3. **Core design** — the key architectural patterns and why they were chosen
4. **Entity/data model** — entities, how they relate, relationship diagram
5. **Storage** — schema, serialization formats, indexes
6. **Other invariants** — ID generation, hashing, security boundaries, etc.

This is the first doc someone reads to understand how the system works. It starts high-level (what are the pieces, how do they talk) and only then goes deep. Update it whenever modules, data flow, schema, or system boundaries change.

In multi-service projects, per-service `docs/<service>/architecture.md` files cover that service's internals. The top-level `docs/architecture.md` stays focused on the system-wide view — it should not duplicate service internals.

**`docs/deployment.md`** — Should exist for any project that runs in production. Covers:
- Environments (dev, staging, prod) and how they differ
- Infrastructure (what runs where — containers, VMs, serverless, etc.)
- CI/CD pipeline (build, test, deploy steps)
- Configuration and secrets management
- Monitoring and alerting
- Rollback procedures
- Prerequisites and access requirements

If the project is local-only or not yet deployed, skip this file. Create it when deployment becomes relevant.

**Module/service docs** — Full reference for each module. Content depends on the module type:
- CLI tools: every command with all options, usage examples, error handling
- APIs: every endpoint with method, path, request/response shapes, example requests
- Web apps: components, routes, configuration, environment variables
- Libraries: public API, usage examples, configuration

### Step 7: Cross-linking

Docs should read like a connected graph, not isolated pages. A reader should never hit a dead end.

**README ↔ docs:**
- README links to every `docs/` file in its Docs section
- When the README mentions a concept covered in detail elsewhere, link inline: "Events are appended to a JSONL log (see [Architecture](docs/architecture.md#event-sourcing) for details)"
- Don't over-link — one inline link per concept per section is enough

**Between docs:**
- `architecture.md` links to the detailed docs when mentioning a module: "The CLI exposes 20+ commands (see [CLI Reference](cli.md))"
- Service/feature docs link back to architecture when referencing system-wide concepts: "All writes go through the shared event log (see [Architecture](architecture.md#write-path))"
- Use anchor links for specific sections: `[entity model](architecture.md#entity-model)`, not just `[architecture](architecture.md)`
- When a doc references another entity type, command, or endpoint covered in a sibling doc, link to it

**Per-service docs (multi-service projects):**
- Top-level `architecture.md` links down to each `docs/<service>/architecture.md`
- Per-service docs link up to the system overview when referencing cross-service concerns
- Sibling services link to each other when describing integration points

**Link hygiene:**
- Every `docs/` file linked from README must exist
- Every detail removed from README should have a corresponding `docs/` entry
- Use relative paths: `[CLI Reference](docs/cli.md)` from README, `[Architecture](architecture.md)` between docs in the same directory
- After any rename or restructure, grep for broken links: `grep -r '](.*\.md' docs/ README.md`

### Step 8: Summary

After updating, provide a brief summary of what changed in each doc file and why.
