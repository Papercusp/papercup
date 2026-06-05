# Harness Blueprint — parallel-agent handoff briefs

**Source plan:** `harness-blueprint-orchestration-2026-06-03` (PG-canonical; `plans:get { slug, harness:'all' }`).
**Author / engine owner:** su-adb1b (coordinate via `coord:send`).
**Date:** 2026-06-04.

The blueprint **engine** (Phase A) is built, tested, and live: schema → `deriveNext`
interpreter (proven byte-equivalent to the legacy `classifyDecision` switch) →
validator → file/PG loader → the `coding`/`base` blueprints → migration 133 →
**`deriveNext` now drives the live `featurePipelineImpl`**. Agent-authoring tools
(`blueprint:validate/create/extend`, `harness:create`) + `requiresRepo` are shipped.

These briefs are the **independent** remaining pieces. Each is a self-contained
work order. Read the **Shared preamble** first, then your brief.

---

## Shared preamble — read before any brief

**The engine is FROZEN. Do NOT edit it. Coordinate with su-adb1b for any schema change.**

**Engine API** — `import { … } from '@papercusp/orchestrator/blueprint'`:
- `BlueprintSchema` (+ sub-schemas: `SpineSchema`, `GymSchema`, `KnobsSchema`, `TriggersSchema`, …)
- Types: `Blueprint`, `BlueprintSpine`, `SpineAction`, `BlueprintGym`, `BlueprintKnobs`, `PipelineAction`
- `deriveNext(spine, parsed, defaultFeature)` → `PipelineAction` (pure interpreter)
- `validateBlueprint(bp)` → `{ ok, errors, warnings }`
- `loadBuiltinBlueprint(id)`, `loadBlueprintFromFile(path, resolve?)`, `resolveBlueprint(raw, opts)`
- `resolveExtends(raw, resolveFn, seen?)`, `mergeRaw`, `blueprintHash`, `builtinBlueprintPath(id)`, `resolveBuiltinExtends`, type `ResolveExtendsPath`

**Built-in blueprints:** `libs/papercusp/packages/harness/blueprints/{base,coding}/blueprint.yaml`.
Resolve the dir via `@papercusp/harness/paths` → `harnessPath('blueprints', id, 'blueprint.yaml')`.
`base` is abstract (no spine; merge-only); `coding` is the behavior-preserving lift of the
20-verb switch. Merge rule: objects deep-merge (child wins on leaves); arrays + scalars replace.

**PG projection (operator):** `apps/operator/lib/blueprint/project-to-pg.ts` →
`projectBlueprintToPg` / `readBlueprintFromPg` / `getEffectiveBlueprint`.
Table `harness_shared.blueprints` (migration 133 — **applied live** on `:5432 papercusp`).
The file is source-of-truth; PG is a lazy cache.

**Live pipeline:** `apps/operator/lib/dbos/orchestrator-workflow.ts` —
`deriveNext(spine, …)` drives the loop; `PipelineInput.spine` carries a non-coding spine
(defaults to the built-in `coding` spine). `classifyDecision`
(`orchestrator-decide.ts`) is RETAINED as the equivalence-test oracle — don't delete it.

**Repo + workflow:** `/home/marsh-office/papercupai-workspace/papercup`, **stays on `main`**
(no branches/worktrees). git-sync owns commits/pushes — don't `git commit`/`push`. Use
`locks:*` + `coord:*` for collision-avoidance; the per-edit lock hook serializes edits.
Tests: Vitest at `<pkg>/lib/**/<name>.test.ts` (unit) / `apps/operator/test/*.integration.test.ts`
(real PG, `--config vitest.integration.config.ts`). Run `npm run test:affected` after editing.
New agent tool? Follow `CLAUDE.md` "Adding a tool" (`defineTool` + register in
`agent-tools/index.ts` + `guidance.when` + run `vitest run tools-md-sync`).

**ACTIVE CHURN:** su-9e6b89d7 is carving `packages/operator-core` out of `apps/operator/lib/**`.
Coordinate before large `lib/**` moves; prefer adding NEW files over editing churning ones.

**Declare intent + subscribe:** `coord:declare-intent { intent, current_plan_slug }`, and
`coord:send` su-adb1b when you start / hit a boundary.

---

## BRIEF 1 — Phase D: Gym-as-blueprint port (P-011–P-016) — LARGEST

**Plan items:** P-011, P-012, P-013, P-014, P-015, P-016 (D-022).
**Coordinate with:** the `harness-gym-eval-optimizer-2026-06-02` owner (P-016 reconciles/absorbs
it — check `coord:presence` / `plans:get` for its owner) **and** su-adb1b (engine).

**Premise (D-022):** a gym is just a harness whose work is "improve another harness's blueprint."
Port `lib/gym/*` to a `gym` blueprint; the *target* blueprint declares its own
`blueprint.gym` rubric/signals/collectTrace.

**Build:**
- **P-011** — Author `libs/papercusp/packages/harness/blueprints/gym/blueprint.yaml`: roles
  `task-generator`/`judge`/`proposer`; spine
  `generate-tasks → run-target-variant (sub-harness) → judge → propose → A/B-gate → accept
  (commit target blueprint)`. Use `recursion.enabled` + `recursion.spawnOn` for the sub-harness.
  Validate with `blueprint:validate`.
- **P-012** — Re-expose `lib/gym` primitives as tools / engine-primitives:
  `runAbEvaluation` (`apps/operator/lib/gym/ab-runner.ts:151`),
  `judgeGymRun` (`gym/judge.ts:90`; rubric `gym/judge-scoring.ts:46` `GYM_JUDGE_RUBRIC_V1`),
  signals (`gym/signals.ts` — `regressionsFromTests`, `plantedBugCaught`),
  the collector (`gym/collector.ts`).
- **P-013** — Build the **A/B eval-matrix** (variants × tasks × repeats + comparison) on the
  runtime DAG (Level 2) + a comparison/aggregation primitive. **This is the one genuinely-new
  piece** — the rest re-exposes existing `lib/gym`.
- **P-014** — Per-blueprint `blueprint.gym.collectTrace` (the **fifth seam**, D-015). Break the
  repo-coupling at `gym/collector.ts:24` (`buildDiffCommand`) / `:62` (`collectTrace`) **AND** the
  hardcoded `git diff` in `gym/ab-runner-real.ts:147` (a third seam the earlier audit missed).
  `coding` = git-diff over the clone; `research` = work-item-output + transcript. **The schema's
  `gym.collectTrace` field already exists** (`'git-diff' | 'work-item-output' | <custom>`) — wire
  the operator gym to read it from the target blueprint.
- **P-015** — Gym extensions = harness **plugins**. Keep `gym/control-plane.ts`
  (`gym_proposals`/`gym_autoloop_config`, migration 110) as the gym blueprint's UI/state surface.
- **P-016** — Live-edit = **commit→reproject** (D-007/D-021): an accepted proposal commits the
  target's `.papercusp/blueprint.yaml`/prompt, then re-projects via `projectBlueprintToPg`,
  replacing the ungated `PUT /harness/:slug/prompts/:role`. Reconcile/absorb
  `harness-gym-eval-optimizer-2026-06-02` (coordinate with its owner).

**Acceptance:** the `gym` blueprint validates; re-exposed primitives unit-tested; the A/B
eval-matrix tested; a `requiresRepo:false` (`work-item-output`) collectTrace path works; the
zero-regression coding A/B holds. **Out of scope:** editing `@papercusp/orchestrator/blueprint`.

---

## BRIEF 2 — P-009: Generate-from-repo (kind #1 harness creation)

**Plan item:** P-009 (D-023, Phase B). **Coordinate with:** su-adb1b on
`apps/operator/lib/agent-tools/harness/create.ts` (COMPOSE it, don't rewrite).

**Build:** a **deterministic** detection module that, given an existing git repo, infers an
`extends: coding` **override** (cheap; LLM-refinement deferred — the gym optimizes the seed):
- test command — **VERIFIED by running it once**,
- the tool set,
- structural flags: monorepo → sub-harness, frontend → ui-qa,
- harvest `AGENTS.md` / `CLAUDE.md` / `TESTING.md` into the override.
- If the repo already has `.papercusp/blueprint.yaml`, **skip**.

Expose a `harness:generate-from-repo` tool (or a `fromRepo` mode) that builds
`{ id, extends:'coding', …overrides }`, validates with the engine
(`resolveAndValidate` / `blueprint:validate`), then calls `harness:create`. (Kinds #2/#3
generate-from-plan are OUT of scope — superseded by the RFC, owned elsewhere.)

**Anchors:** `apps/operator/lib/agent-tools/harness/create.ts` (compose),
`apps/operator/lib/agent-tools/blueprint/_resolve.ts` (`resolveAndValidate`), the engine loader.

**Acceptance:** a test that detects a fixture repo's test command + flags + emits a valid
`extends:coding` blueprint that `validateBlueprint` accepts.

---

## BRIEF 3 — P-021: `system:blueprint-run` scheduler action

**Plan item:** P-021 (D-018, Phase F). **Coordinate with:** the scheduler owner
(`git-sync-auto-commit` / `dbos-scheduler-consolidation`).

**Build:** Register a **`system:blueprint-run` action** via `registerSystemAction` (find its
existing call sites — e.g. `system:git-sync`) that a scheduled `harness_shared.routines` row
dispatches **DIRECTLY** via `routinesTick` to start a blueprint run / create a `work_item`.

**Hard constraint:** **NO new `pending_events` consumer.** The
`routines → pending_events → consumer` hop is RETIRED (`git-sync-auto-commit` D-006); adding one
resurrects dead infra. (`pending_events` the table stays live — the operator scanner observes it
via LISTEN/NOTIFY — you just don't add a consumer.) Keep distinct from the reactive overlay + the
30s orchestrator tick. **No second scheduler.**

A blueprint declares `triggers.schedule` defaults (**`TriggersSchema` already exists**:
`schedule: { cron, action }[]`, default `action='system:blueprint-run'`); `harness:create`
materializes them into `routines` (runtime-editable; pause/retime via upsert).

**Acceptance:** a `routines` row with `action='system:blueprint-run'` fires through `routinesTick`
and starts a blueprint run / creates a work-item; a test.

---

## BRIEF 4 — P-019: `.harness/` → `.papercusp/` namespace migration (CROSS-CUTTING — assign a coordinator)

**Plan item:** P-019 (D-020, Phase F). **HEAVY coordination — do NOT land unilaterally.**

**Build:** rename all **per-project** harness artifacts `.harness/` → `.papercusp/`
(config/state/prompts/blueprint). **Per-project only** — host `~/.papercusp/` is already migrated
(D-028). **Pre-alpha → NO compat alias** (clean rename).

**Anchors:** `readConfig` (`libs/papercusp/packages/orchestrator/src/config.ts` reads
`.harness/config.json`), the `papercusp init` CLI, `scaffoldHarnessSchema`, every `.harness/`
literal (grep widely).

**Coordination (MANDATORY before landing):** `.harness/` is load-bearing for —
- **dogfood-federation** (`shared.json`, `contributors/<login>.json`),
- **git-sync** (`.harness/state/`),
- **storage-unification** git-export.
Coordinate with those owners first. **Also collides with the operator-core carve (su-9e6b89d7)** —
sequence around it. (Note: the blueprint loader already writes the new `.papercusp/blueprint.yaml`.)

**Acceptance:** all `.harness/` literals migrated; config/state/prompts resolve under `.papercusp/`;
federation + git-sync still work; `fresh-migrate.integration.test.ts` + e2e green.
**Risk: HIGH** (wide mechanical rename + cross-plan). Best for a coordination-disciplined agent.

---

## P-020 — `work_items` migration (gated; claim only if directed)

**Plan item:** P-020 (D-013/D-027/D-028, Phase F). **Gated:** *"after the vertical slice proves
out."* su-adb1b is keeping this by default — claim only if avi assigns it.

Generalize `harness_shared.harness_features_consolidated` *base* → canonical `work_items`
(add `kind`+`payload`); keep the triggers (incl. the `capture_substrate_outbox` federation CDC)
**on the base**; make `harness_features_consolidated` + per-schema `harness_features` thin
`kind='feature'` views (032 view-pattern). **MUST DROP `blocked_by`/`hfc_blocked_by_gin_idx`** and
point the P-042 dispatch frontier at the `coord_links` rel='blocks' edge-projection
(**D-027/D-028** — else blocking re-forks a 4th time). **Coordinate with** su-a5a32 (engineer-issues
/ `coord_links` substrate owner). Touches the federation CDC + the dispatch hot-path — high care.

---

## What su-adb1b is KEEPING (do not claim)

- **Phase E** — P-017 (research blueprint) + P-018 (e2e proof) + the **P-004 residual**
  (route `debugger-threshold` + `finalize-recipe` reads through the resolved blueprint, which
  Phase E's per-harness resolution forces).
- **Phase C (reframed)** — the plans↔blueprint "blueprint-as-emergent-tool" seam (entangled with
  the project-centric RFC).
- **P-020** unless reassigned (see above).

**Done so far (Phase A + B):** P-001, P-002, P-003, P-004, P-005, P-007, P-008 — all tested.
P-006 = coding/base shipped; no-regress gate satisfied by the equivalence proof.
