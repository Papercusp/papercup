---
title: Migrating a bespoke loop to a deterministic / hybrid blueprint
description: The established pattern for deterministic-blueprints-migration — a learning loop becomes a program-mode blueprint whose steps are registered step-ops (deterministic capability ops + spawn-roles for agents), fired on a cadence by system:blueprint-run. Reuse the lib logic; don't rewrite.
discovered: 2026-06-13
tags: [blueprints, deterministic-steps, coord-ops, migration, learning-loops, dbos]
status: active
sidebar:
  order: 60
---

## What

The blueprint **program-mode spine** (`spine.steps` + optional `spine.gate`) is
the deterministic-step substrate. A "deterministic step" is **not a new engine** —
it is a registered typed function (a `CoordOp`: `name` + `argsSchema`/`resultSchema`
+ `run(args, ctx)`) that the program runner executes as a checkpointed step. The
coord-op registry is the step-op registry; coordination ops are one family,
deterministic capability ops (wrapping lib logic) are another. (Plan:
`deterministic-blueprints-migration-2026-06-13`, P-010/P-011.)

Two program shapes, discriminated by the gate (no schema field):

- **deterministic pipeline** — `steps`, **NO gate**. Runs every step then resolves
  `done`. The migrated learning loops (negative-space, neologism, fleet-ekg, …).
- **decision program** — `steps` + `gate` (must have a fallback). vote / deliberate.

## How to migrate a loop (the recipe)

1. **Reuse the lib logic — don't rewrite (D-003).** Extract the loop's
   flag → governor → tick orchestration into a shared `run<Loop>Mine`-style fn
   (one source of truth) with **injectable deps as parameters**. Example:
   `packages/operator-core/lib/negative-space/mine.ts` (`runNegativeSpaceMine`).
   The existing `system:<loop>` action then delegates to it (keeps its test seams),
   and so does the new op — provably behavior-neutral (D-004).

2. **Write the deterministic step-op** under
   `packages/operator-core/lib/blueprint-steps/ops/<loop>.ts`:
   a `CoordOp` named `<domain>:<verb>` (e.g. `negative-space:scan`), declared
   `argsSchema`/`resultSchema` (the typed I/O — P-140), a module-level test-deps
   setter (`setXScanDeps`), and `run(args, ctx)` that calls the shared orchestration
   using `ctx.workspaceId` / `ctx.harnessSlug`. `registerCoordOp(op)` at the bottom,
   and `import './ops/<loop>.js'` in `blueprint-steps/index.ts`. The op carries the
   flag + governor gating (P-012) — so **dark stays dark**.

3. **Write the blueprint** at
   `libs/papercusp/packages/harness/blueprints/<loop>/blueprint.yaml`:
   `extends: base`, a `workItem`, a program spine with the step(s) and `triggers.schedule`
   (the loop's existing cron). Pure-deterministic ⇒ **no gate**. Args interpolate
   `{{ payload.* }}` (an unset whole-string placeholder → `undefined` → the op's
   optional arg defaults).

4. **Point the seed routine at the blueprint**: `target: 'system:blueprint-run'`,
   `payload_template: { blueprintId: '<loop>' }`. Keep the governor-loop registration.
   `system:blueprint-run` detects program-mode (`isProgramSpine`) and runs the
   program **inline as its durable step** via `runProgramCore` + `inlineRunOp`
   (behavior-neutral: the bespoke loops also ran inline in their step).

5. **Hybrid loops** (det select → agent → det persist, e.g. regret): the agent
   step is `orchestrator:spawn-roles`, which routes through `coordSpawnRunner` →
   `spawnInvokeOnce` — **the one governed launch chokepoint**. So blueprint-izing a
   hybrid loop closes the eval-battery "second spawn path" seam for free (D-005).

## Gotchas

- `validateBlueprint` is called WITHOUT `knownOps` at every current call site, so a
  program op that doesn't exist is caught at RUN time (`requireCoordOp` throws), not
  load time. Register your op (import the family index) wherever the program runs.
- A deterministic op must **fail loud** on a missing `ctx.workspaceId` (a
  misconfigured fire), not silently mine the wrong scope.
- `runProgramCore` maps a gateless completed run (`no-gate-match` from the generic
  runner) to a clean `done` — don't reintroduce a gate just to terminate.

## Files (pilot A — negative-space, the reference)

- Schema/validator: `libs/papercusp/packages/orchestrator/src/blueprint/validate.ts` (gate optional)
- Runner: `packages/operator-core/lib/coord-ops/program-runner.ts` (gateless → done)
- Scheduled fire: `packages/operator-core/lib/blueprint/blueprint-run-action.ts` (`runScheduledProgram`)
- Op family: `packages/operator-core/lib/blueprint-steps/`
- Shared orchestration: `packages/operator-core/lib/negative-space/mine.ts`
- Blueprint: `libs/papercusp/packages/harness/blueprints/negative-space/blueprint.yaml`
- Tests: `packages/operator-core/lib/blueprint-steps/negative-space-blueprint.test.ts`
