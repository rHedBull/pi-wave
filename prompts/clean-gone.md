---
description: Clean up local git branches deleted from remote
---
## Your task
Clean up stale local branches that have been deleted from the remote repository.

1. Run `git branch -v` to list branches and identify any with [gone] status
2. Run `git worktree list` to identify worktrees that need removal for [gone] branches
3. For each [gone] branch: remove its worktree (if any), then delete the branch with `git branch -D`

Report what was cleaned up, or that no cleanup was needed.
