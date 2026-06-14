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

5. **Hybrid loops** (det → agent → det, e.g. regret / transfer / prompt-ablation /
   iq-battery): the agent leg stays **INTERNAL to the op** (Option A), NOT an
   `orchestrator:spawn-roles` step. Two reasons (D-009 / D-013): (a) those loops'
   "agents" are governed `llmCall`s (regret/transfer/ablation) or fleet bees that
   already route through `spawnAgentInHarness → fleet:spawn → spawnInvokeOnce` —
   **the one governed chokepoint** — so there is NO ungoverned second spawn path to
   "close"; (b) `spawn-roles` is for **role fan-out** (vote's per-lens voters): its
   agents take a harness *role/persona*. A loop whose agent takes a *brief* (a corpus
   case, a transcript continuation) doesn't fit that contract — keep the spawn inside
   the op. So "deterministic step" = deterministic *top level* (the gate logic), with
   internal governed spawns, NOT "no spawns." iq-battery is the worked hybrid:
   `iq-battery:gen` op wraps `runIqBatteryGen` (cadence-tick + the gen-0 bee runner).

## Gotchas

- **Before migrating, check it isn't ALREADY a blueprint role.** The worker chunk
  loop (`worker-chunk-loop.ts`) looked like a bespoke loop to migrate, but it IS the
  coding blueprint's `worker` role body — already blueprint-integrated, running in the
  `invoke-once` subprocess with the subprocess's `InvokeContext`. "Migrating" it is a
  cross-process durability RE-ARCHITECTURE (the op runs in the operator's program
  workflow, a different context), not a gap. Don't re-migrate the already-integrated.
- **No top-level throwing computation in a wrapped lib** (the same class as the
  `__dirname` deploy incident). `change-ledger/scan-loop.ts` did
  `const x = promisify(execFile)` at module scope; a test that partially mocks
  `node:child_process` (only `spawn`) made `execFile` undefined → `promisify(undefined)`
  threw AT IMPORT, poisoning every test whose graph includes the module. Promisify /
  resolve lazily INSIDE the function.
- **Workspace-singleton cadence ≠ blueprint `triggers.schedule` materialization.**
  The migrated loops are workspace SINGLETONS (one routine per workspace), but
  `materializeBlueprintTriggers` creates one routine PER INSTALL (keyed
  `(install_slug, name)`) seeded ACTIVE. So the loops keep their bespoke singleton
  SEED scripts (which also do governor registration); the blueprint's `triggers.schedule`
  is DOCUMENTATION of the cadence, not the live materializer (D-010 / D-012). Making
  it the live mechanism needs a per-workspace host-slug convention — an open design call.
- `validateBlueprint` is called WITHOUT `knownOps` at every current call site, so a
  program op that doesn't exist is caught at RUN time (`requireCoordOp` throws), not
  load time. Register your op (import the family index) wherever the program runs.
- A deterministic op must **fail loud** on a missing `ctx.workspaceId` (a
  misconfigured fire), not silently mine the wrong scope.
- `runProgramCore` maps a gateless completed run (`no-gate-match` from the generic
  runner) to a clean `done` — don't reintroduce a gate just to terminate.
- **Gating varies per loop** — replicate the ACTUAL gate: most are flag + learning-
  governor; change-ledger is flag-only (pure bookkeeping); scout is structural
  (cadence/fire-gate/claim/budget, no flag); iq-battery is owner-budget (refuse if no
  `budgetUsd`). Read the action; don't assume flag+governor.
- **Editing the seed `.ts` does NOT repoint the LIVE routine row — you MUST re-run the
  seed (step 4 is a runtime act, not just a source edit).** Changing `target` /
  `payload_template` in the seed script only affects FUTURE upserts. An already-seeded
  `harness_shared.routines` row — *especially one an owner ACTIVATED before the
  migration deployed* — still has `target_role = 'system:<loop>'` (now retired, no
  registered handler) and the old payload shape, so when it fires it hits a dead target
  and silently no-ops. After the migration lands, **re-run each loop's seed against the
  live workspace DB** (`PAPERCUSP_WORKSPACE_ID=<ws> tsx lib/.../seed-<loop>-routine.ts
  [--active]`); the upsert's `ON CONFLICT` repoints target + payload (and the well-
  written seeds preserve owner payload keys — change-ledger keeps `sinceDays`, iq-battery
  keeps `budgetUsd`). This bit **`iq-battery-gen`, `scout-cycle`, `change-ledger-scan`**
  — all active, all firing at a retired target (Scout + change-ledger loops were dead)
  until re-seeded 2026-06-13. **Corollary — the INACTIVE migrated rows are latent
  traps:** flipping `active=true` in the routines admin WITHOUT re-seeding fires the
  retired target. Arm a migrated loop by **re-running its seed with `--active`**, never
  by an admin active-flip alone. (Quick audit: `SELECT name,target_role,active FROM
  harness_shared.routines WHERE target_role <> 'system:blueprint-run'` — every row whose
  target isn't a still-registered action is suspect.)

## Files (pilot A — negative-space, the reference)

- Schema/validator: `libs/papercusp/packages/orchestrator/src/blueprint/validate.ts` (gate optional)
- Runner: `packages/operator-core/lib/coord-ops/program-runner.ts` (gateless → done)
- Scheduled fire: `packages/operator-core/lib/blueprint/blueprint-run-action.ts` (`runScheduledProgram`)
- Op family: `packages/operator-core/lib/blueprint-steps/`
- Shared orchestration: `packages/operator-core/lib/negative-space/mine.ts`
- Blueprint: `libs/papercusp/packages/harness/blueprints/negative-space/blueprint.yaml`
- Tests: `packages/operator-core/lib/blueprint-steps/negative-space-blueprint.test.ts`
