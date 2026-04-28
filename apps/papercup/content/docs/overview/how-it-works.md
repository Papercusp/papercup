---
title: How the harness works
description: The full life of one feature, from planner output to merged PR.
---

The harness has two startup phases and one main loop.

## Phase 1 — Plan

If `.harness/features.json` doesn't exist, the **planner** runs once. It reads `SPEC.md` and produces:

- `.harness/features.json` — a feature queue, each entry has `id`, `title`, `claims[]`, `status`, `attempts`.
- `.harness/validation-contract.md` — every claim spelled out as a verifiable assertion (`VAL-AUTH-001: User can log in with valid credentials`).

## Phase 2 — Plan review

The **plan-reviewer** challenges the planner's output. It can `accept`, `accept-with-notes`, or `reject`. Reject → harness exits 7, escalation written.

If `checkpoints.types[].triggerOn=="post-planner"` is configured, an auto-checkpoint is fired here and the run pauses for a human grant.

## Phase 3 — Main loop

```
while iteration < MAX:
  decision = orchestrator()
  match decision:
    DONE                → optional smoke-test gate; curator + documenter; exit 0
    NEXT_WORKER <fid>   → branch_iso + invoke worker(fid)
    NEXT_VALIDATOR <f>  → invoke validator(f); if pass → optional smoke + ui-qa + crosscheck + documenter
    NEXT_ARCHITECT <f>  → invoke architect to resolve ambiguity
    CONVERTED           → orchestrator promoted issues to F-FIX-* features
    CHECKPOINT <name>   → write checkpoint file, exit 8
    ESCALATE <reason>   → escalation.md, curator, exit 3
  snapshot state, prune logs, check cost cap
```

## What "fresh context" means

Every role invocation is a separate `claude` subprocess with no shared in-memory state. The role's prompt is:

```
<role.md>
+ <identity/role.md>          ← cross-mission, curator-maintained
+ <memory/summary.md>         ← this-mission, capped at 40 lines / 800 tokens
+ <runtime context>           ← FEATURE_ID=…, working dir, …
```

Anthropic's prompt cache makes this cheap — we measured 99.94% cache-hit rate on the live missions because the per-role prompt prefix is stable. Rebuilding context every iteration costs almost nothing in tokens and gives us very strong "no drift" guarantees.

## Branch isolation + worktrees

When `branchIsolation.enabled: true`, each feature gets its own `harness/<FEATURE_ID>` branch. With `useWorktrees: true`, each parallel lane gets its own filesystem directory under `.harness/worktrees/<fid>` so workers can edit different files at the same time without git races.

On validator pass: worktree merges into baseBranch + worktree is removed. On fail: worktree is retained for retry.

## Where memory lives

| Layer | Location | Lifetime | Maintained by |
|---|---|---|---|
| L0 — wake-up | injected at runtime | per invocation | run.sh |
| L1 — session state | `.harness/memory/raw.md` | this mission | every role appends |
| L2 — mission summary | `.harness/memory/summary.md` | this mission | curator (capped 40 lines) |
| L3 — mission long memory | `.harness/memory/MEMORY.md` | this mission | curator |
| L4 — cross-mission identity | `~/autonomous-harness/identity/<role>.md` | forever | curator (append-only) |

Workers can prefix raw entries with `TRICK:` to flag generalisable patterns. Curator promotes confirmed tricks to `identity/worker.md`.
