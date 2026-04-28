---
title: Competition mode
description: Two workers race on the same feature, validator picks the winner.
---

`parallelWorkers.mode: "competition"` makes the harness spawn N workers on the *same* feature in sibling worktrees. They race. A validator inspects all N implementations and emits `COMPETITION_WINNER lane-<N>`. The winner's branch merges; losers are discarded.

## When this is worth it

- Ambiguous features. If two plausible implementations exist, racing them is cheaper than spec-revising.
- Stuck features. After 3+ worker attempts on the same feature, racing two fresh approaches often unblocks.
- High-stakes features. The cost of a wrong implementation (rework + propagation) vastly exceeds the cost of N parallel workers.

## When it's wasteful

- Routine CRUD. The two implementations will be near-identical; the race adds cost without information.
- Features with rigid interfaces. There's only one right way; the race produces twins.
- Early-stage missions. Use the regular lane mode until you have a feel for which features are ambiguous.

Default mode is `lane` (different features in parallel). Switch to `competition` per-feature or per-mission when warranted.

## Implementation sketch

```bash
# In NEXT_WORKER:
if mode == "competition" && parallelWorkers.max > 1:
    for i in 1..N:
        wt=.harness/worktrees/<fid>-lane-<i>
        git worktree add -B harness/<fid>-lane-<i> $wt <base>
        spawn worker(FEATURE_ID=<fid>-lane-<i>, COMPETITION_PARENT=<fid>, COMPETITION_LANE=<i>)
    wait all
    write .harness/competition-<fid>.json with manifest

# In NEXT_VALIDATOR:
if exists(.harness/competition-<fid>.json):
    invoke validator with manifest visible
    parse output for COMPETITION_WINNER lane-<N>
    merge winner's branch into <base>
    remove all lane worktrees + branches
    delete competition manifest
```

## Validator prompt addition

The validator's prompt has a dedicated COMPETITION MODE section that explains how to score lanes (claims-pass first, then minimal diff, then convention adherence) and the exact output format (`COMPETITION_WINNER lane-<N>` or `COMPETITION_WINNER none`).

## Worker awareness

Workers receive `COMPETITION_PARENT` and `COMPETITION_LANE` env vars. The worker prompt has a COMPETITION MODE section telling them: don't coordinate with peers, diversify approach, code lean.

## Inspiration

Pattern lifted from [Conductor](https://conductor.build/) which exposes "parallel work inside one workspace" — same idea, different surface.
