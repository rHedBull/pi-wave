---
description: Feature branch, worker implements, reviewer reviews, worker applies feedback
---
Before starting, check the current git branch. If NOT already on a `pi/*` feature branch, create one:
```bash
git checkout -b pi/<short-kebab-case-description>
```

Then use the subagent tool with the chain parameter to execute this workflow:

1. First, use the "worker" agent to implement: $@
2. Then, use the "reviewer" agent to review the implementation from the previous step (use {previous} placeholder)
3. Finally, use the "worker" agent to apply the feedback from the review (use {previous} placeholder)

Execute this as a chain, passing output between steps via {previous}.

After completion, report:
- Branch name and `git diff --stat` summary
- How to review: `git diff main..HEAD`
- Next steps: `/commit-push-pr` to create a PR, `/feature-done` for summary, or discard with `git checkout main`
