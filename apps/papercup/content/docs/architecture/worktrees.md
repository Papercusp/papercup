---
title: Git worktrees
description: Why each parallel lane gets its own filesystem directory.
---

When `branchIsolation.useWorktrees: true`, every feature gets a sibling working-tree directory at `.harness/worktrees/<feature-id>/` instead of switching branches in the main project tree.

## Why this matters for parallel workers

Without worktrees, parallel workers share one working tree. `git checkout -B harness/F-023` in lane 1 *while* `git checkout -B harness/F-024` is running in lane 2 = race condition. Either lane stomps on the other's HEAD or they fight over file locks.

Worktrees give each lane its own HEAD on its own branch on its own files. No git race possible.

## Bonus: the validator can read both lanes

When `workersPerFeature > 1`, multiple workers attack the same feature in sibling worktrees. The synthesizer then `cd`s into each worktree and reads all implementations to pick what should ship. With branch-switching, this would require constant stash-and-switch — slow and noisy.

## Lifecycle

```
worker phase:
  worktree_pre_worker(fid)    → git worktree add -B harness/<fid> .harness/worktrees/<fid> <base>
  invoke worker (cwd=worktree)
  worktree_post_worker(fid)   → git add -A && commit in worktree

validator phase:
  validator reads from worktree directly (cwd override)
  on PASS:
    git checkout <base>
    git merge --no-ff harness/<fid>
    git worktree remove --force <wt>
    git branch -D harness/<fid>
  on FAIL:
    worktree retained for retry
```

## Cleanup

- On `feature reset` via UI: `git worktree remove --force` + `git branch -D`. Wired in `harness.ts` at `/features/:id/reset`.
- On harness startup: `git worktree prune` runs to clean up directories left behind by crashed missions.

## Tradeoffs

- **Disk usage.** Each worktree is a full checkout of `<base>`. For a 200MB repo with 5 parallel lanes, that's 1GB extra. Mostly hard-linked by git, so cheaper than it sounds.
- **No cross-lane file mutations.** This is the point — workers can't accidentally read each other's WIP — but means features that genuinely depend on each other's work need to be sequenced.
- **Commit history.** Each lane commits to its own branch. Merging produces a clean linear history per feature.

## Inspiration

Pattern lifted from [ComposioHQ/agent-orchestrator](https://github.com/ComposioHQ/agent-orchestrator) — they describe it as the most reliable way to run parallel coding agents.
