---
name: pr-review
description: Review a GitHub pull request for bugs, security issues, and code quality. Fetches PR diff via gh CLI, runs parallel review agents with confidence scoring, and optionally posts review comments back to the PR.
---

# PR Review

Review GitHub pull requests with multi-agent analysis and confidence-based filtering.

## Prerequisites

- `gh` CLI installed and authenticated (`gh auth status`)
- Inside a git repository with a GitHub remote

## Usage

The user provides a PR number or URL. If none given, review the most recent PR.

## Review Process

Follow these steps precisely:

### Step 1: Fetch PR Info

```bash
# Get PR details
gh pr view <NUMBER> --json number,title,author,state,isDraft,body,baseRefName,headRefName,url,additions,deletions,changedFiles

# Get the diff
gh pr diff <NUMBER>

# Get list of changed files
gh pr diff <NUMBER> --name-only
```

If the PR is closed, merged, or a draft, inform the user and ask if they still want to review.

### Step 2: Gather Project Context

Check for project guidelines that inform the review:

```bash
# Find project convention files
find . -maxdepth 3 -name "CLAUDE.md" -o -name ".cursorrules" -o -name "CONVENTIONS.md" -o -name "CODING_STANDARDS.md" 2>/dev/null | head -20
```

Read any found convention files — they define project-specific rules to check against.

### Step 3: Parallel Review with Subagents

Launch 5 parallel review agents. Each gets the PR diff, changed file list, and project conventions.

```
Use the subagent tool with parallel mode. Each agent is "reviewer" type.
```

The 5 review agents each focus on a different aspect:

**Agent 1 — Convention Compliance**: Check changes against project conventions (CLAUDE.md, etc.). Flag violations of explicit project rules: import patterns, naming, error handling, testing practices.

**Agent 2 — Bug Scan (Shallow)**: Read only the diff (not full files). Look for obvious bugs: logic errors, null handling, off-by-one, missing error handling, type mismatches. Focus on high-impact bugs, skip nitpicks. Ignore things a linter/compiler would catch.

**Agent 3 — Historical Context**: Run `git log --oneline -10 -- <file>` and `git blame -L <changed_lines> <file>` for modified files. Check if changes contradict recent fixes or revert intentional patterns.

**Agent 4 — Related PR Context**: Run `gh pr list --state merged --search "<changed_files>" --limit 5` to find recent PRs touching the same files. Check for recurring review comments that apply here too.

**Agent 5 — Code Comment Compliance**: Read full modified files. Check if changes violate guidance in code comments (TODO notes, @see references, // NOTE: explanations, doc comments describing contracts).

Each agent must return a structured list:
```
## Issues Found
- **File**: path/to/file.ts
- **Line(s)**: 42-45
- **Description**: What's wrong
- **Reason**: Why flagged (convention violation | bug | historical context | recurring issue | comment violation)
- **Confidence**: 0-100
```

### Step 4: Confidence Scoring

For each issue found, evaluate confidence on this scale:

- **0**: False positive. Doesn't hold up to scrutiny, or is pre-existing.
- **25**: Might be real, might be false positive. Stylistic issues not explicitly in project conventions.
- **50**: Real but minor. Nitpick or rarely triggered in practice.
- **75**: Very likely real. Verified, will impact functionality, or explicitly called out in conventions.
- **100**: Certain. Confirmed real, will happen frequently, evidence directly confirms it.

**False positive indicators** (filter these OUT):
- Pre-existing issues (not introduced by this PR)
- Things linters/compilers/CI would catch (type errors, formatting, imports)
- General quality concerns not in project conventions (test coverage, documentation)
- Issues silenced by lint-ignore comments
- Intentional functionality changes related to the PR's purpose
- Issues on lines the PR didn't modify

### Step 5: Filter and Format

**Only report issues with confidence ≥ 80.**

Get the full commit SHA for linking:
```bash
gh pr view <NUMBER> --json headRefOid --jq '.headRefOid'
```

Get the repo owner/name:
```bash
gh repo view --json nameWithOwner --jq '.nameWithOwner'
```

Format the review as:

```markdown
### Code Review — PR #<number>: <title>

**<N> issue(s) found** (filtered from <total> candidates, confidence ≥ 80):

1. **<brief description>** (confidence: <score>)
   Reason: <convention says "..." | bug due to ... | historical context shows ...>

   https://github.com/<owner>/<repo>/blob/<full_sha>/<file>#L<start>-L<end>

2. ...

---
If no issues meet the threshold:

### Code Review — PR #<number>: <title>

No significant issues found. Checked for bugs, convention compliance, historical context, related PRs, and code comment adherence.
```

### Step 6: Post Review (Optional)

Ask the user if they want to post the review as a PR comment:

```bash
gh pr comment <NUMBER> --body "<review_markdown>"
```

Or post as a formal review:
```bash
gh pr review <NUMBER> --comment --body "<review_markdown>"
```

## Tips

- For large PRs (>500 lines changed), focus agents on the most critical files first
- If the diff is too large for a single context, split by file and review in batches
- Use `gh pr diff <NUMBER> -- <specific_file>` to review individual files
- When linking code, always use the full SHA — shortened SHAs won't render as previews
