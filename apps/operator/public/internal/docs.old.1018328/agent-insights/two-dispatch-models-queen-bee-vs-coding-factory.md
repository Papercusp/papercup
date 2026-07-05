# Two harness dispatch models: queen/bee `coding` (live) vs `coding-factory` DBOS orchestrator — don't conflate them
URL: /internal/docs/agent-insights/two-dispatch-models-queen-bee-vs-coding-factory

When reasoning about how a hive scales agents to its work-item backlog, there are TWO different mechanisms in the repo. The queen/bee hive (`coding`, kind:hive, spine.decider:queen) is the live, actively-developed path. The DBOS-orchestrator `coding-factory` (decider:director + a `dispatch:` block, driven by orchestrator-loop.ts) is a DIFFERENT model and is NOT the path in active use (owner, 2026-06-24). `work` extends `coding`, so anything built on `work` inherits the queen/bee model — do not base its dispatch design on orchestrator-loop.ts.

## The trap

You ask "does the framework auto-scale agents to a work-item backlog, or does
something hand-place them?" — read `packages/operator-core/lib/dbos/orchestrator-loop.ts`,
see that it auto-dispatches a durable pipeline per ready work-item up to a
blueprint-declared `dispatch.concurrency` (30s backstop tick + `refillHarnessOnSettle`),
and conclude **"the framework already autoscales — no glue needed."**

That conclusion is **true for `coding-factory`, false for the hives actually in
use.** `orchestrator-loop.ts` is the DBOS-orchestrator / "factory" dispatch path.
It is **not** the path a queen/bee `coding` hive runs on.

## The two models

|                              | queen/bee hive (`coding`)                                                                                                      | factory (`coding-factory`)                                                                      |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| `kind`                       | **`hive`**                                                                                                                     | harness (default)                                                                               |
| `spine.decider`              | **`queen`**                                                                                                                    | `director`                                                                                      |
| `dispatch:` block            | —                                                                                                                              | **yes** (`{ concurrency, priority, readiness, costCapUsd, safetyCeiling }`)                     |
| Who scales agents to backlog | **the Queen** — wakes (`hive/wake.ts`), reads the frontier, places/spawns bees via fleet placement (`fleet/operator-spawn.ts`) | the **DBOS orchestrator** (`orchestrator-loop.ts`) — deterministic, blueprint-`dispatch`-driven |
| Status                       | **LIVE — actively used + developed**                                                                                           | a different model; **per owner (2026-06-24) may not be working / not the path in use**          |

Verify the discriminators directly in the YAML: `coding` declares `kind: hive` +
`spine.decider: queen`; `coding-factory` has no `kind: hive` and declares
`spine.decider: director` + a `dispatch:` section.

## Why it matters: `work` extends `coding`

`libs/papercusp/packages/harness/blueprints/work/blueprint.yaml` is
`extends: coding` (`kind: hive`). So **anything built on `work` inherits the
queen/bee model**, not the factory. An internal ops hive (one that `extends:
work`) is therefore a queen/bee hive: its analysts are scaled to the
domain backlog by the **Queen + fleet placement**, governed by the hive
blueprint's placement / wake / fleet knobs and the Queen prompt — **NOT** by
`orchestrator-loop.ts`.

## The rule

When you need to know how a hive scales workers to its backlog:

1. Check the blueprint's `kind` + `spine.decider`. `kind: hive` + `decider: queen`
   → **queen/bee model** → the dispatch mechanism is the Queen + `fleet/*` +
   `hive/wake.ts`. Read those, not `orchestrator-loop.ts`.
2. Only a `director` + `dispatch:` blueprint (the `coding-factory` lineage) is
   driven by the DBOS orchestrator-loop.
3. **Do not base a design on `coding-factory` / `orchestrator-loop.ts`** — it is
   not the path in active use and may not be working. Model on the live `coding`
   queen/bee hive (and the things that `extends: coding`, like `work`).

> This is exactly the kind of finding that survives a single confident
> code-read getting it wrong: `orchestrator-loop.ts` *is* real and *does*
> autoscale — for the wrong blueprint. The discriminator is `kind`/`decider`,
> not "is there dispatch code somewhere."
