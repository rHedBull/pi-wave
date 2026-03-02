/**
 * Prompt templates for /waves-spec and /waves-plan commands.
 *
 * Pure string-building functions — no side effects, no pi API dependency.
 */

// ── Spec Scopes ────────────────────────────────────────────────────

export const SCOPES = ["hack", "standard", "enterprise"] as const;
export type Scope = (typeof SCOPES)[number];

export function parseSpecArgs(args: string): { scope: Scope; query: string } | null {
	const trimmed = args.trim();
	if (!trimmed) return null;
	const firstWord = trimmed.split(/\s+/)[0].toLowerCase();
	if (SCOPES.includes(firstWord as Scope)) {
		const query = trimmed.slice(firstWord.length).trim();
		return query ? { scope: firstWord as Scope, query } : null;
	}
	return { scope: "standard", query: trimmed };
}

// ── Brainstorm Prompt ──────────────────────────────────────────────

export function buildBrainstormPrompt(scope: Scope, query: string, projectName: string, scoutContext: string, specFilePath: string): string {
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

// ── Plan Review Prompt ─────────────────────────────────────────────

export function buildPlanReviewPrompt(projectName: string, relSpec: string, relPlan: string, outlineOutput: string, extraInstructions: string): string {
	return `# Plan Review: ${projectName}

A planner agent has drafted an outline for the implementation plan. Your job is to **present it to the user for review**, focusing on:

1. **Wave milestones** — what each wave delivers and whether the increments make sense
2. **Feature parallelization** — which features run in parallel within each wave, and whether the grouping is right

## Planner's Outline

${outlineOutput}

## Your Process

1. **Present the outline clearly** — summarize the milestones and parallelization in a readable format. Highlight the key decisions.
2. **Ask for feedback** — "Does this look right? Would you change the milestones, move features between waves, or group things differently?"
3. **Iterate** — if the user has critiques, adjust the outline and present the updated version. Go back and forth until they're satisfied.
4. **When approved** — read the spec at \`${relSpec}\` and write the full detailed implementation plan to \`${relPlan}\`.

${extraInstructions ? `\n**Additional instructions from the user:** ${extraInstructions}\n` : ""}

## Plan Format (when writing the final plan)

The plan must follow this exact Markdown structure:

\`\`\`markdown
# Implementation Plan

## Goal
One sentence.

## Reference
- Spec: \`${relSpec}\`

## TDD Approach
Brief: framework, patterns, directory structure.

---

## Wave 1: <Milestone Name>
Working state: <what "done" means>

### Foundation
Shared contracts committed before features branch.

#### Task w1-found-t1: <title>
- **Agent**: worker | test-writer | wave-verifier
- **Files**: \`path/to/file\`
- **Depends**: (task IDs, or omit if none)
- **Tests**: \`path/to/test\` (for worker tasks)
- **Spec refs**: FR-1, FR-2
- **Description**: Detailed description with code hints (exact signatures, field names).

### Feature: <name>
Files: list of files this feature owns

#### Task w1-<feature>-t1: <title>
- **Agent**: ...
- **Files**: ...
- **Depends**: w1-<feature>-tN (within same feature only)
- **Description**: ...

### Integration

#### Task w1-int-t1: <title>
...
\`\`\`

**Task ID convention:** \`w{wave}-{feature}-t{num}\` (e.g., w1-auth-t1, w1-found-t2, w2-int-t1)

**Rules:**
- Features within a wave MUST NOT depend on each other or write to the same files
- Task dependencies are within the same feature/section only
- Every task description must repeat canonical field names and signatures (parallel agents can't see each other)
- Foundation defines exact interfaces — agents just create the files
- Integration wires features together and runs full verification
- Target: 2-5 waves, 2-6 features per wave, 2-6 tasks per feature
- All agents use \`permissionMode: fullAuto\`

**After writing the plan, you MUST validate it before telling the user it's ready:**

1. Read the plan file back
2. For each wave, collect all task IDs per section:
   - Foundation task IDs (from \`### Foundation\`)
   - Each feature's task IDs (from \`### Feature: <name>\`)
   - Integration task IDs (from \`### Integration\`)
3. For every \`Depends:\` line, verify EACH dependency ID exists in the **same section**:
   - Foundation tasks can only depend on other foundation tasks
   - Feature tasks can only depend on tasks in the **same** feature
   - Integration tasks can only depend on other integration tasks
   - Cross-section dependencies are INVALID (e.g., integration depending on \`w1-skill-t3\`)
4. Verify no two parallel features write to the same file
5. If ANY violations are found, fix them (remove invalid cross-section deps, move files to foundation) and rewrite the plan

Only after validation passes, tell the user: "Next step: \`/waves-execute ${projectName}\`"`;
}
