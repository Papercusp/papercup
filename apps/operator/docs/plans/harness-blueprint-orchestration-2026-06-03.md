---
title: Harness Blueprint — declarative, agent-authorable, self-improving orchestration layer
slug: harness-blueprint-orchestration-2026-06-03
status: draft
created: 2026-06-03
updated: 2026-06-03
owner: avi@storewolf.com
---

# Harness Blueprint — declarative, agent-authorable, self-improving orchestration layer

## Now

**State:** Design **locked + peer-reviewed + adversarially code-audited + cross-plan-audited**; **all five open decisions ratified 2026-06-03**. Both plans carry **P-item build lists**. Execution model A (durable-workflow); the **gym is a blueprint** (D-022); all harness artifacts move to **`.papercusp/`** (D-020). The full DBOS-only cutover is **complete + shipped** (`dbos-durable-flows-adoption`), so the A-model substrate is settled. Companion: `harness-blueprint-distribution-2026-06-03`. Not started in code.

**Next:** Build the **vertical slice (O-3/D-025)** — Phase A engine → `coding`-blueprint lift (the gym-A/B anchor) → research slice. Coordinate with the DBOS-orchestrator owner before editing `featurePipelineImpl` (P-022/D-017) — ordinary coordination now that the cutover is done, not a race.

## Background

### The problem (the four issues)
Built configurable but assumed **humans** author harnesses. We need **agents** to spin up + configure harnesses — coding and non-coding (first: research) — from a declarative, inheritable, shareable definition, cheaply. Dissolves: (1) promote only drops features into the parent's queue; (2) promote can't configure a new harness; (3) not configurable enough for research; (4) the gym is coding-specific + no gated live-fix.

### What the research established
The field is **bifurcated**, the union unoccupied (the differentiation): **Camp A** (MS Agent Framework, LangGraph, AutoGen, CrewAI, Temporal) = durable + graph but code-authored, not self-improving/agent-authored, no marketplace. **Camp B** (ADAS 2408.08435, AFlow 2410.10762, AgentSquare, Gödel Agent, Flow 2501.07834, DSPy+GEPA/MIPROv2) = agent-authored + optimizing but throwaway prototypes. Nobody fuses them.

### Borrowable patterns (patterns, not frameworks)
BPM/Temporal (durable engine ⟂ workflow def; human-task gates; Saga) · CWL/Nextflow (portable shareable reproducible workflow *document* + resume) · CI/CD (composable units + matrix fan-out) · behavior trees (composability beats FSMs) · robotics 3T + blackboard (deliberative/executive/reactive = spine/planner/overlay; reactive preempts) · TPS jidoka/andon (stop-the-line + fix-at-source + kaizen = live-edit → gym) · Erlang OTP supervision (declared restart/escalation = sub-harness recursion) · NAS (search-space design dominates) · Holacracy (governance-as-versioned-data).

### The model — a layered hybrid
1. **Spine** — a declared graph the **director** walks, deterministic edges where possible (MAF/BT). *Flat-graph-first per D-024.*
2. **Runtime task DAG (Level 2)** — a per-goal plan a planner generates; **already have it** (plans→features) (Flow).
3. **Reactive expert overlay** — condition-triggered roles that can **preempt** (3T/blackboard).
4. **Harness-boundary recursion** — a role spawns a durable sub-harness w/ a declared restart/escalation strategy (OTP).

**Anti-over-decomposition is first-class** (D-010): the minimal blueprint must be as cheap as the maximal; the gym must discover that *fewer* roles is better.

### Build vs borrow vs have
- **BUILD:** blueprint-as-data, the generalized gym, the marketplace, agent-authoring, the work-item lifecycle, the gate system.
- **BORROW (patterns):** above; LangGraph `Send`/`StateGraph` ergonomics — don't adopt (checkpointing ≠ durable execution).
- **HAVE:** DBOS durable execution; plans = the Level-2 DAG; `harness_prompt_overrides` + the gym control-plane (migration 110); experts = the reactive seed; per-harness PG schemas; the `defineTool` surface (`@papercusp/tooldef`); the durable `routinesTick` scheduler (git-sync-auto-commit).

### Execution model: A (durable-workflow)
`deriveNext(blueprint, runState)` is a **pure function inside `featurePipelineImpl`**, swapping the `classifyDecision` switch. "Deterministic" = replay-safety (non-determinism in recorded steps), not a behavior limit. Idempotency = DBOS `deduplicationID`. The full DBOS-only cutover is **complete + shipped** (`dbos-durable-flows-adoption`, 2026-06-02: `operator_claims` dropped [migration 112], the legacy route-fallback removed) — DBOS is the **sole** orchestrator, so the A-substrate is settled. Corroborated by `dbos-durable-jobs` D-004: *DBOS wraps execution as durable steps; it does not replace the LLM-driven routing* — exactly our `deriveNext`/director split.

## Phase A — Blueprint model + engine (keystone)
- **P-001** `todo` A1 — `BlueprintSchema` (Zod) = { id, extends, version, workItem, roles[], spine, planner, reactive, gates, recursion, gym, knobs }; superset of HarnessConfig's **shape/knob fields only** (instance fields stay in `.papercusp/config.json`). The Zod schema = validator-of-record.
- **P-002** `todo` A1 — store the blueprint git-canonical at `.papercusp/blueprint.yaml` (referencing `.md` prompts); build the **file-read/parse → PG `harness_shared.blueprints` loader** (D-021, NOT the Hyperbee `TableProjection`), beside `readConfig()`.
- **P-003** `todo` A2 — pure `deriveNext(spine, runState)` interpreter replacing the 22-case `classifyDecision` switch (`orchestrator-decide.ts:42`); the `coding` blueprint encodes today's verbs+switch as data (behavior-preserving); flat-graph (D-024).
- **P-004** `todo` A3 — wire `deriveNext` into `featurePipelineImpl` (`orchestrator-workflow.ts:166`, at the line-199 classify call); keep the `runner()` durable step + `deduplicationID` (:310); promote `MAX_TURNS` (:161) / debugger-threshold / finalize-recipe → blueprint fields. (after P-003)
- **P-005** `todo` A4 — pure `validateBlueprint(bp)`: reachability, termination, every node has an exit, guards well-formed, bounded recursion, work-item payload valid. Author-time + on load.
- **P-006** `todo` A5 — ship `coding` (behavior-preserving lift) + minimal `base`; wire the **gym-A/B no-regress gate** (`runAbEvaluation`): hardcoded path vs blueprint path over a task set. (after P-004)

## Phase B — Agent-authorable creation
- **P-007** `todo` B1 — `harness:create` + `blueprint:create/extend/validate` defineTool tools (registered in `agent-tools/index.ts`), wrapping `dispatchAction('scaffold_harness')` / `POST /api/harness/projects` (`projects.ts:175`). No `orchestrator.spawn`.
- **P-008** `todo` B2 — `requiresRepo` flag → conditional git-init in `doScaffoldHarness` (`execute-action.ts:612`); confirm the PG-only run path for non-repo harnesses.
- **P-009** `todo` B3/D-023 — generate-from-repo for kind #1: deterministic detection (test-gate **verified by running it**, tool set, monorepo/UI flags) + harvest `AGENTS.md`/`CLAUDE.md`/`TESTING.md` → an `extends: coding` override; LLM-refinement deferred.

## Phase C — Promote → new configured harness (issues #1 + #2)
- **P-010** `todo` C — add `blueprint_slug?` to `plans:promote`; at the `promote.ts:625` seam create the new harness (`POST /api/harness/projects`) then route `postFeaturesImport` (:794) to the **new** slug. `features/import` (`features.ts:333`) is URL-parameterized — no handler change. (Builds on `dbos-system-completion` D-009/D-011: promote already emits wave/`blocked_by` parallelism = the Level-2 DAG.)

## Phase D — Port the gym to a blueprint (the gym is a meta-harness, D-022)
- **P-011** `todo` D1 — define the `gym` blueprint: roles `task-generator`/`judge`/`proposer`; spine `generate-tasks → run-target-variant (sub-harness) → judge → propose → A/B-gate → accept (commit target blueprint)`.
- **P-012** `todo` D3 — re-expose `lib/gym` primitives as tools/engine-primitives: `judgeGymRun` (`judge-scoring.ts:46`), `runAbEvaluation` (`ab-runner.ts`), signals (`signals.ts`), the collector.
- **P-013** `todo` D3 — the **A/B eval-matrix** (variants × tasks × repeats + comparison) on the runtime-DAG (Level 2) + a comparison/aggregation primitive — the one genuinely-new piece.
- **P-014** `todo` D2/D-015 — per-blueprint `blueprint.gym.collectTrace` (coding=git-diff over the clone; research=work-item-output + transcript), breaking the `collector.ts:24/28` repo-coupling.
- **P-015** `todo` D4 — gym extensions = harness **plugins**; keep `control-plane.ts` (`gym_proposals`/`gym_autoloop_config`, migration 110) as the gym blueprint's UI/state surface.
- **P-016** `todo` D5 — live-edit = commit→reproject (D-007/D-021), replacing the ungated `PUT /harness/:slug/prompts/:role`; reconcile/absorb `harness-gym-eval-optimizer-2026-06-02` (coordinate with its active owner).

## Phase E — Vertical proof slice (research 7a + coding lift 7b)
- **P-017** `todo` — author the `research` blueprint: minimal 1-`researcher` default (D-016) + reactive `searcher`/`verifier` + an overflow path that spawns a sub-research-harness (layers 3+4); `requiresRepo:false`.
- **P-018** `todo` — end-to-end: an agent spins up the research harness from a plan (B+C), runs on A via `collectTrace`, live-edits a misbehaving role (commit); the `coding` blueprint holds at **zero regression** via the gym A/B. (after P-006, P-014, P-017)

## Phase F — Cross-cutting migrations (own gated steps)
- **P-019** `todo` D-020 — full `.harness/` → `.papercusp/` namespace migration (config/state/prompts/blueprint). **Cross-plan coordination required:** `.harness/` is load-bearing for the dogfood federation (`shared.json`, `contributors/<login>.json`), git-sync (`.harness/state/`), and the storage-unification git-export — coordinate with those owners before the rename.
- **P-020** `todo` D-013 — **1b**: **generalize the existing `harness_features_consolidated` base into a canonical `work_items` table** (add `kind`+`payload`), keep the triggers (incl. `capture_substrate_outbox` federation CDC) **on the base**, and make `harness_features_consolidated` a thin `kind='feature'` view — per the storage-unification 032 view-pattern. Its own gated migration, after the slice proves out.
- **P-021** `todo` D-018 — register a **`system:blueprint-run` action** (`registerSystemAction`) that a scheduled `routines` row dispatches **directly** (via `routinesTick`) to start a blueprint run / create a `work_item`. **No `pending_events` consumer** — that hop is retired (`git-sync-auto-commit` D-006).
- **P-022** `todo` D-017 — coordinate with the DBOS-orchestrator owner before P-003/P-004 edit `featurePipelineImpl`. The cutover is complete, so this is ordinary coordination, not a race.

## Risks & mitigations
- **DBOS-cutover** — **complete + shipped**; the A-model substrate is settled (no in-flight race). Still coordinate before editing `featurePipelineImpl` (P-022/D-017).
- **1b migration** — generalize the consolidated base into `work_items` (triggers stay on the base; add a `kind='feature'` view) per the 032 pattern; federation capture now spans all work-item kinds (P-020/D-013).
- **`.papercusp/` migration** — wide mechanical rename; **cross-plan**: touches federation/git-sync/storage `.harness/` paths — coordinate (P-019/D-020).
- **Blueprint→PG** — file-read/parse pattern, NOT the Hyperbee `TableProjection` (D-021).
- **Gym-port** — the A/B eval-matrix on the runtime-DAG is the one new piece (P-013/D-022); the rest re-exposes `lib/gym`; coordinate with the active gym-plan owner.
- **Scheduler** — `routinesTick` dispatches **directly** (`pending_events` retired); the blueprint integration is a `system:blueprint-run` action (P-021/D-018), not a consumer.
- **Over-rename churn** — keep `featureId` in the coding path; generality in `work_items` + the blueprint.
- **Validator gaps** → A4 + the gym safety net + the `coding` golden reference.
- **YAML footguns** → tool-authored canonical YAML + Zod on load.

## Decisions

### D-001 Keystone: the Harness Blueprint
Date: 2026-06-03
A harness's entire shape — work-item type, role set, orchestration spine, gates, gym rubric/signals, knobs — becomes one declarative, versioned, **agent-authorable, inheritable** Blueprint. Dissolves all four issues. Inheritance (`extends`) supplies the "shared structure so agents don't author from zero / don't burn tokens."

### D-002 Full pipeline-as-data
Date: 2026-06-03
The orchestration spine (hardcoded `NEXT_*` verbs + a switch) becomes declared data the engine interprets. Chosen over "prompts/roles-only" and "bounded shapes": maximum generality; research needs it.

### D-003 Orchestration = a layered hybrid
Date: 2026-06-03
Declared-graph **spine** + runtime-generated **task DAG** (already exists) + reactive **expert overlay** (can preempt) + **harness-boundary recursion** (declared restart/escalation). Corroborated (MAF/BT, Flow, 3T/blackboard, OTP). Recursion at the *harness* boundary to preserve durability + gates + observability.

### D-004 Execution model = A (durable-workflow), not B
Date: 2026-06-03
`deriveNext` is a pure function inside `featurePipelineImpl`, replacing the `classifyDecision` switch. "Deterministic" = replay-safety, not a behavior limit — A already runs dynamic/LLM-routed/reactive/long-lived flows; B unlocks no flow A can't and its ergonomic wins wash. The full DBOS-only cutover is **complete + shipped** (`dbos-durable-flows-adoption`, 2026-06-02); DBOS is the sole orchestrator. Corroborated by `dbos-durable-jobs` D-004 (*DBOS wraps execution as durable steps; it does not replace the LLM-driven routing*).

### D-005 Build on DBOS + PG; borrow patterns, not frameworks
Date: 2026-06-03
No framework accommodates our feature set — they compete with one layer (the engine). LangGraph: capable on spine+Level-2 but checkpointing ≠ durable execution → borrow, don't adopt. Durable execution = DBOS. Borrow from MAF, CWL/Nextflow, BTs, 3T, OTP, jidoka, NAS, Holacracy.

### D-006 Blueprint storage = git-canonical, projected to PG
Date: 2026-06-03
The blueprint is a versioned file in the harness's own repo (`.papercusp/blueprint.yaml` + `.md` prompts), projected into PG (`harness_shared.blueprints`) so the interpreter reads PG. `git log/diff/revert` = audit/diff/revert, free. **Projection mechanism: file-read/parse, not the Hyperbee projector — D-021.**

### D-007 Live-edit = a git commit; mechanism is to-build
Date: 2026-06-03
The andon-pull live fix = a **commit to the `.papercusp/` blueprint/prompt files**, not a PG versions table. **Audit:** today `setPromptOverride` writes PG directly (no projection); under git-canonical the `commit → reproject → effective-next-step` path is **NEW work** riding the D-021 file→PG loader. `gym_proposals` = the transient review queue; accept → commit. `harness_prompt_overrides` kept ONLY as the workspace-divergence escape-hatch.

### D-008 Data format = YAML + referenced `.md` prompts + Zod
Date: 2026-06-03
Structural blueprint in YAML (`.papercusp/blueprint.yaml`) — comments + clean diffs. Role prompts stay as separate `.md` files (reuses `prompt-resolve.ts`; clean per-prompt git history). A Zod schema = validator-of-record. Agents author via validated `blueprint:*` tools (canonical YAML). JSON is the fallback.

### D-009 No deprecation aliases
Date: 2026-06-03
Pre-alpha: clean renames + migrations now, no shims. Drove 1b (D-013) and the `.papercusp/` migration (D-020). Exception: no repo-wide `featureId → workItemId` rename — keep `featureId` in the coding path; generality in `work_items` + the blueprint.

### D-010 Anti-over-decomposition is a first-class requirement
Date: 2026-06-03
The deep-research harness (105 agents) failed at a task a single agent does better. A harness earns its overhead only on context-overflow, independence, durability/gating/observability, or parallel scale. The Blueprint must collapse to one role as cheaply as the maximal, and the gym must discover that fewer roles is better (NAS). Standing default: research inline; the deep-research harness only on overflow. Applied in D-016.

### D-011 Live-edit ↔ gym fusion (jidoka / kaizen)
Date: 2026-06-03
A live edit is a candidate blueprint revision the gym can evaluate; gym acceptance is the same commit action — fusing issue #4a + #4b into one surface. Realized by the gym-as-blueprint port (D-022).

### D-012 operator_claims is gone; idempotency = DBOS deduplicationID
Date: 2026-06-03
Migration 112 dropped `harness_shared.operator_claims` (part of the completed DBOS-only cutover); the per-feature mutex is DBOS `deduplicationID` (`orchestrator-workflow.ts:310`); file claims use the PG-backed `SuLocksCoordinator`.

### D-013 Work-item substrate = 1b (canonical `work_items`)
Date: 2026-06-03
Decided by avi. A single canonical `work_items(workspace_id, harness_slug, item_id, kind, payload jsonb, status, …)`. **Reconciled with the storage-unification 032 view-pattern (`harness-state-storage-unification` D-007):** rather than `INSTEAD OF` triggers on a view, **generalize the existing `harness_features_consolidated` *base* table into `work_items`** (add `kind`+`payload`) — the triggers (`capture_substrate_outbox` federation CDC [now spans all kinds], `emit_change_notify` SSE, `fill_needs_design`, `fill_ws_features`) **stay on the base** (normal triggers), and `harness_features_consolidated` + per-schema `harness_features` become thin `kind='feature'` views (the latter already is, `scaffold-harness-schema.ts:114`). Less invasive than the earlier "4 INSTEAD OF" framing. A gated migration (P-020), after the slice proves out on `harness_features` as-is. No `work_items` exists today.

### D-014 The zero-regression gate is a gym A/B, not a unit test
Date: 2026-06-03
A5's gate = a gym A/B (`runAbEvaluation`): hardcoded path vs blueprint path over a task set, equivalence by judge + deterministic signals. Audit-confirmed it runs on the existing repo-based gym **without the proposer**. Dogfoods the gym on the refactor that generalizes it.

### D-015 Per-blueprint gym trace collector (`blueprint.gym.collectTrace`)
Date: 2026-06-03
Audit-confirmed: the gym is repo-coupled below the config seams — `collector.ts:24/28` builds the trace from `git diff`; `clone.ts` clones substrate@commit. A `requiresRepo:false` blueprint can't run on it. The target's `blueprint.gym.collectTrace` is the fifth seam: coding=git-diff, research=work-item output + transcript.

### D-016 The research proof slice defaults minimal (applies D-010)
Date: 2026-06-03
The proof-slice `research` blueprint defaults to **1–2 roles** (one `researcher`), with `searcher`/`verifier` as reactive-overlay roles + an overflow path that spawns a sub-research-harness — honoring D-010 and exercising layers 3+4.

### D-017 Coordinate on `featurePipelineImpl` — the cutover is COMPLETE (not a race)
Date: 2026-06-03
A2/A3 edit `orchestrator-workflow.ts` / `orchestrator-decide.ts`. **Cross-plan correction:** the full DBOS-only cutover is **complete + shipped** (`dbos-durable-flows-adoption`, 2026-06-02 — route-fallback removed, `operator_claims` dropped) — so the A-substrate is settled and this is **ordinary coordinate-before-editing**, not the "in-flight race" earlier drafts implied. Still pair with the DBOS-orchestrator owner before editing `featurePipelineImpl`.

### D-018 Scheduler integration = a `system:blueprint-run` action (pending_events is RETIRED)
Date: 2026-06-03
Blueprint ⟂ scheduler: separate engines. A blueprint declares `triggers.schedule` defaults; `harness:create` materializes them into `harness_shared.routines` (runtime-editable; pause/retime via upsert). **Cross-plan correction:** the durable DBOS `routinesTick` is shipped (`git-sync-auto-commit`) and **dispatches targets DIRECTLY** — a `system:<action>` (inline durable step via `registerSystemAction`) or an agent role (via `launchAgent`). The `routines → pending_events → consumer` hop is **RETIRED** (D-006 there). So the blueprint integration is a **`system:blueprint-run` action** that starts a blueprint run / creates a `work_item` — *not* a `pending_events` consumer (that would resurrect dead infra). Keep distinct from the reactive overlay + the orchestrator's 30s tick. No second scheduler.

### D-019 Distribution = git(definition) + plugins(tools) + snapshot(state); templates subsumed
Date: 2026-06-03
A shareable harness unit is a Blueprint distributed across three layers: definition = git (the harness's repo) fronted by the Cupboard; code deps = plugins (`@papercusp/tooldef`, host-agnostic); optional state = a narrowed snapshot. Templates are subsumed (a "template" = a blueprint + seed content). Gap: an import-time tool-dependency manifest. Full redesign: `harness-blueprint-distribution-2026-06-03`.

### D-020 Full `.harness/` → `.papercusp/` namespace migration
Date: 2026-06-03
Per avi: `.harness/` is too generic / not ours-branded. Migrate ALL Papercusp harness artifacts to `.papercusp/` (config/state/prompts/blueprint). One wide-but-mechanical rename touching config resolution (`readConfig`), the CLI (`papercusp init`), `scaffoldHarnessSchema`, every `.harness/` literal. Pre-alpha → no compat alias. **Cross-plan:** `.harness/` is load-bearing for the dogfood federation (`shared.json`, `contributors/<login>.json`, `.harness/state/` git-export) and git-sync — this rename must be **coordinated with the dogfood-federation, git-sync, and storage-unification owners**, not landed unilaterally.

### D-021 Blueprint → PG via file-read/parse, NOT the Hyperbee TableProjection
Date: 2026-06-03
Audit correction: `sync/hyperbee/projection.ts`'s `TableProjection` is peer-sync CRDT machinery (LWW, provenance, federation) — wrong for a single-writer local git file. The git-canonical blueprint projects to its PG cache via the **same file-read/parse path plans/specs/config use**. The live-edit `commit → reproject` (D-007) rides this loader; both are to-build.

### D-022 The gym is a blueprint (a meta-harness); gym extensions = plugins
Date: 2026-06-03
Per avi: a gym is just a harness whose work is "improve another harness's blueprint." Port `lib/gym/*` to a `gym` blueprint — roles generator/judge/proposer; spine generate→run-target(sub-harness)→judge→propose→A/B-gate→accept; the *target* declares its own `blueprint.gym` rubric/signals/collectTrace; the gym's primitives (`judgeGymRun`, `runAbEvaluation`, `signals`, `collector`) become tools; the A/B eval-matrix runs on the runtime-DAG. **Gym extensions = harness plugins.** "Special" = it's a built-in reference blueprint operating on a *target*. Consequences: the gym is itself gym-able, and this **absorbs `harness-gym-eval-optimizer-2026-06-02`** (coordinate with its active owner).

### D-023 Kind-#1 creation generates an `extends: coding` blueprint from the repo
Date: 2026-06-03
Creating from an existing git repo generates an `extends: coding` blueprint by inferring the **overrides** (cheap). Deterministic detection fills the gate (**test command, VERIFIED by running it once**), the tool set, and structural flags (monorepo → sub-harness; frontend → ui-qa), + harvests `AGENTS.md`/`CLAUDE.md`/`TESTING.md`. LLM-refinement deferred; the gym optimizes the seed. If the repo already has `.papercusp/blueprint.yaml`, skip. (Kinds #2/#3 generate-from-plan.)

### D-024 O-2 ratified: spine = flat declared graph first (BT later)
Date: 2026-06-03
avi ratified. The spine is a **flat declared graph** — a near-1:1 transcription of the 22-case `classifyDecision` switch into nodes + edges (lowest risk, behavior-preserving). Behavior-tree composition deferred until the flat engine is proven.

### D-025 O-3 ratified: build strategy = thin vertical slice first
Date: 2026-06-03
avi ratified. Build the **research vertical slice** through Phase A→B→C→D end-to-end first, with the `coding` blueprint as the zero-regression gym-A/B anchor — not full Phase-A generality before anything runs.
