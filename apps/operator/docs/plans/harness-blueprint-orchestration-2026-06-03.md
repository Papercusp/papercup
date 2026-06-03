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

**State:** Design **locked + peer-reviewed + adversarially code-audited (2026-06-03)**, with the audit's mechanism corrections applied (see D-020/D-021 and the anchor fixes). Execution model is **A** (durable-workflow). Two structural reframes since the first draft: (1) **the gym is a blueprint** (a meta-harness, D-022) — Phase D is now "port the gym," not "inject seams"; (2) all Papercusp harness artifacts move to **`.papercusp/`** (D-020). Companion plan `harness-blueprint-distribution-2026-06-03` covers packaging + sharing. Not started in code.

**Next:** (1) **O-2/O-3** still await your explicit ratification (flat-graph-first, vertical-slice-first); (2) build order: **engine (Phase A) → coding-blueprint lift (the gym-A/B anchor) → research vertical slice → gym-port (Phase D) → distribution (companion)**; (3) explicit **`featurePipelineImpl` handoff** with the DBOS-cutover peer (D-017) before Phase A touches it.

## Background

### The problem (the four issues)
The harness system was built configurable but assumed **humans** would author harnesses + submit them to a marketplace. We need **agents** to spin up + configure harnesses — coding and non-coding (first: **research**) — from a declarative, inheritable, shareable definition, cheaply. This dissolves four issues: (1) promote can only drop features into the parent's queue (no separate config); (2) the promote step can't configure a new harness; (3) the system isn't configurable enough for a genuinely different workflow (research); (4) the gym is coding-specific + there's no gated way to fix a misbehaving role live.

### What the research established
The field is **bifurcated**, and the union is unoccupied (the differentiation): **Camp A** (MS Agent Framework, LangGraph, AutoGen, CrewAI, Temporal) = durable + graph but code-authored, not self-improving/agent-authored, no marketplace. **Camp B** (ADAS 2408.08435, AFlow 2410.10762, AgentSquare, Gödel Agent, Flow 2501.07834 = runtime AOV DAG, DSPy+GEPA/MIPROv2) = agent-authored + optimizing but throwaway prototypes, not durable/gated/shareable. Nobody fuses them. *(Verify caveat: the deep-research harness's verify phase broke; prong-1 re-confirmed by hand; prong-2 is stable knowledge.)*

### Borrowable patterns (borrow patterns, not frameworks)
BPM/Temporal (durable engine ⟂ workflow def; human-task gates; Saga) · CWL/Nextflow (portable shareable reproducible workflow *document* + resume — the blueprint-format + marketplace model) · CI/CD (composable units + matrix fan-out) · behavior trees (composability beats FSMs) · robotics 3T + blackboard (deliberative/executive/reactive = spine/planner/overlay; reactive preempts) · TPS jidoka/andon (stop-the-line + fix-at-source + kaizen = live-edit → gym) · Erlang OTP supervision (declared restart/escalation = sub-harness recursion) · NAS ("search-space design dominates" → invest in the schema) · Holacracy (governance-as-versioned-data).

### The model — a layered hybrid (each layer corroborated)
1. **Spine** — a declared graph the **director** walks, deterministic edges where possible *(MAF/BT)*.
2. **Runtime task DAG (Level 2)** — a per-goal plan a planner role generates; **already have it** (plans→features w/ wave/blocked_by/for_each) *(Flow)*.
3. **Reactive expert overlay** — condition-triggered roles that can **preempt**; seed exists (`alwaysFireOn`, experts) *(3T/blackboard)*.
4. **Harness-boundary recursion** — a role spawns a durable sub-harness w/ a declared restart/escalation strategy (issue #3) *(OTP)*.

**Anti-over-decomposition is first-class** (D-010): the minimal blueprint (1 role) must be as cheap as the maximal, and the gym must be able to discover that *fewer* roles is better.

### Build vs borrow vs have
- **BUILD (our whitespace):** blueprint-as-data, the generalized gym, the marketplace, agent-authoring, the work-item lifecycle, the acceptance/gate system.
- **BORROW (patterns):** the list above. LangGraph: borrow `Send`/`StateGraph` ergonomics, **don't adopt** (checkpointing ≠ durable execution; owns none of our differentiation).
- **HAVE (reuse):** DBOS durable execution; plans = the Level-2 DAG; `harness_prompt_overrides` + the gym control-plane (migration 110); experts = the reactive seed; per-harness PG schemas; the endpoint system; the `defineTool` surface (`@papercusp/tooldef`).

### Execution model: A (durable-workflow)
Keep the durable-workflow model. "Deterministic" in durable execution = *replay-safety of the control flow* (non-determinism — LLM calls, time, randomness — captured in recorded **steps**), NOT a behavior limit. A already runs dynamic/LLM-routed/reactive/long-lived flows (`featurePipelineImpl` is exactly that). B unlocks no flow A can't; B's ergonomic wins wash (A already has a pure decision core — `classifyDecision`; DBOS runs on PG). So `deriveNext(blueprint, runState)` is a **pure function called inside `featurePipelineImpl`**, swapping the `classifyDecision` switch for a graph walk. Idempotency = DBOS `deduplicationID` (`operator_claims` dropped, migration 112). *(Audit note: the DBOS orchestrator is opt-in today — `PAPERCUSP_DBOS_ORCHESTRATOR=1`, legacy default — with the full-DBOS-only cutover in flight per coord; D-017.)*

## Plan
*(Anchors verified against `/home/marsh-office/papercupai-workspace/papercup`, adversarial audit 2026-06-03. P-items at kickoff.)*

### Phase A — Blueprint model + engine (keystone)
- **A1 Schema + storage.** `BlueprintSchema` (Zod) = `{ id, extends, version, workItem, roles[], spine, planner, reactive, gates, recursion, gym, knobs }` — a superset of `HarnessConfig`'s **shape/knob fields only** (instance fields — slug/token/parent_slug/phase/dept — stay in `.papercusp/config.json`, A1-fix). Stored git-canonical at **`.papercusp/blueprint.yaml`** (referencing role prompts as `.md`), projected to PG `harness_shared.blueprints` via the **file-read/parse pattern (like plans/config/docs), NOT the Hyperbee `TableProjection`** (D-021). Loader beside `readConfig()` (`orchestrator/src/config.ts`).
- **A2 Spine-as-data interpreter.** Replace the **22-case** switch in `classifyDecision()` (`orchestrator-decide.ts`, switch at :42, already pure) + `DECISION_VERBS` (`decision-parse.ts:19`) with a pure `deriveNext(spine, runState)`. The `coding` blueprint encodes today's verbs+switch → **behavior-preserving**; `classifyDecision` stays as the reference + unit anchor (`orchestrator-decide.test.ts`); the real gate is the gym A/B (A5).
- **A3 Wire into the durable shell (model A).** `deriveNext()` is called inside `featurePipelineImpl` (`orchestrator-workflow.ts:166`) in place of the `classifyDecision` call (line 199); the `runner()` invocation (`orchestrator-workflow.ts:183/230`; spawn impl in `orchestrator-runner.ts`) stays a durable step deduped by `deduplicationID` (`orchestrator-workflow.ts:310`). No new state table (DBOS holds it). Promote `MAX_TURNS` (env-driven `PAPERCUSP_DBOS_PIPELINE_MAX_TURNS ?? 200`, `orchestrator-workflow.ts:161`), the debugger threshold, and the finalization recipe (`orchestrator-finalize.ts`) → blueprint fields.
- **A4 Validator** (the "agents can't author broken harnesses" guard): pure `validateBlueprint(bp)` — reachability, termination, every node has an exit, guards well-formed, bounded recursion, work-item payload valid. Author-time + on load.
- **A5 Base blueprints + the no-regress gate.** Ship `coding` (behavior-preserving lift) + a minimal `base`. The zero-regression gate is a **gym A/B** (D-014) on the existing repo-based gym (`ab-runner.ts` `runAbEvaluation` — audit-confirmed: A/Bs two variants over a task set via judge + deterministic signals, **no proposer**): hardcoded path vs blueprint path, equivalence confirmed.

### Phase B — Agent-authorable creation
- **B1 Agent tools** `harness:create` + `blueprint:create/extend/validate`, via `defineTool({...})` (from `@papercusp/tooldef`, re-exported by `@papercusp/agent-mcp`; template `agent-tools/memory/remember.ts`), registered by an `import` in `agent-tools/index.ts`. `harness:create` wraps `dispatchAction('scaffold_harness')` / `POST /api/harness/projects` (`projects.ts:175`) — audit-confirmed safe (no `orchestrator.spawn`).
- **B2 Non-repo harness:** make the `papercusp init` / git step in `doScaffoldHarness` (`execute-action.ts:612`) conditional on a `requiresRepo` flag. `scaffoldHarnessSchema` is pure SQL; the run path reads PG (no git); completion-ref is skippable. Nuance (audit): clean when the blueprint/template is pre-scaffolded, not cloned.
- **B3 Inheritance + generate-from-repo (D-023).** `extends` resolves a base + overrides (cheap authoring); builds on `spawnable-templates.ts:35`. For **kind #1 (from a git repo)**: generate an `extends: coding` blueprint from the repo by *deterministic detection* (language/test-gate/monorepo/UI) with the **test gate verified by actually running it once**; LLM-refinement deferred; the gym optimizes the seed.

### Phase C — Promote → new configured harness (issues #1 + #2)
Add `blueprint_slug?` to `plans:promote`. Seam at **`promote.ts:625`** (after the harness-exists check); if a blueprint is supplied, `POST /api/harness/projects` to create the new harness, then route `postFeaturesImport` (`promote.ts:794`, defined :289) to the **new** slug. `features/import` (`features.ts:333`, resolves target purely from `:slug`) is already URL-parameterized — **no handler change** (audit-confirmed). Provenance (`source_plan_slug`, `claims`, `harness_plan_assertions`) carries free. *(Cleanest phase; fully grounded.)*

### Phase D — Port the gym to a blueprint (the gym is a meta-harness) [D-022]
- **D1 The gym is a harness.** Reframe `lib/gym/*` from a bespoke subsystem into a `gym` blueprint: work-item = a candidate **blueprint variant** of a *target* harness; roles = `task-generator`, `judge`, `proposer`; spine = `generate-tasks → run-target-variant (sub-harness, layer 4) → judge → propose → A/B-gate → accept (commit to the target's blueprint)`. The "different verbs" are this blueprint's spine verbs.
- **D2 Gym config splits.** The *target* blueprint declares its eval criteria in *its* `blueprint.gym` (rubric/signals/pools/**collectTrace** — D-015); the *gym harness* reads the target's `blueprint.gym` to score it.
- **D3 Re-expose `lib/gym` primitives as tools/engine-primitives.** `judgeGymRun` (`judge-scoring.ts:46` `GYM_JUDGE_RUBRIC_V1`), `runAbEvaluation` (`ab-runner.ts`), signals (`signals.ts` — `regressionsFromTests:22`, `plantedBugCaught:46`), the trace collector (`collector.ts:24/28` `git diff` + `clone.ts` — the repo-coupling D-015 breaks via the per-blueprint `collectTrace`: coding=git-diff, research=work-item-output). The **A/B eval-matrix** (variants × tasks × repeats + comparison) runs on the **runtime-DAG (Level 2)** fan-out + a comparison/aggregation primitive — the one genuinely-new piece.
- **D4 Gym extensions = harness plugins.** A custom signal/judge/proposer = a plugin/tool the gym blueprint references; **no separate "gym plugin."** The control-plane (`control-plane.ts`, `gym_proposals`/`gym_autoloop_config`, migration 110, domain-free) stays as the gym blueprint's UI/state surface.
- **D5 Live-edit = commit (the andon pull).** The proposer's accept = a **commit to the target's blueprint** (D-007); `gym_proposals` is the transient review queue. Replaces the ungated `PUT /harness/:slug/prompts/:role` (`prompts.ts:91` → `setPromptOverride` `harness-prompt-overrides.ts:55`) with the commit→reproject path (D-007/D-021). `harness_prompt_overrides` kept only as the workspace-divergence escape-hatch.
- **Consequence:** gym = harness ⇒ the gym is itself **gym-able** (meta), and this **absorbs `harness-gym-eval-optimizer-2026-06-02`** (its content becomes this blueprint's implementation).

### Vertical proof slice — the research blueprint (your 7a)
A `research` blueprint (`extends: base`), **minimal by default (D-016)**: one `researcher`, `workItem.kind=question`, `requiresRepo:false`, gates = a verifier rubric; `searcher`/`verifier` are reactive-overlay roles; an **overflow path** spawns a sub-research-harness (layers 3+4). Spun up from a plan (B+C), run end-to-end on A via the gym's per-blueprint `collectTrace` (D-015), with a live prompt-edit **committed** (D5) — while the **`coding` blueprint (your 7b)** holds at **zero regression** via the gym A/B (A5/D-014).

## Open decisions (reviewer-endorsed; pending avi's explicit ratification)
- **O-2 Spine representation.** Flat declared graph first (1:1 lift of the switch — lowest risk) vs behavior-tree composition. **Rec + reviewer-endorsed: flat first, BT later.**
- **O-3 Build strategy.** Thin vertical slice (research) first vs full Phase-A generality first. **Rec + reviewer-endorsed: vertical slice, coding-blueprint anchor.**

## Risks & mitigations
- **DBOS-cutover** — DBOS orchestrator is opt-in today (legacy default); the full-DBOS-only cutover is in flight (peer `su-ba55b115`). Explicit `featurePipelineImpl` handoff before Phase A edits it (D-017).
- **1b migration cost** — `harness_features_consolidated` carries **4 triggers** (incl. the safety-critical `capture_substrate_outbox` federation CDC + `emit_change_notify` SSE); turning it into a view over `work_items` requires `INSTEAD OF` rewrites + re-testing those paths → its own gated migration (D-013).
- **`.papercusp/` migration** — a wide, mechanical rename touching config resolution, the CLI, `scaffoldHarnessSchema`, and the `.harness/state/` git-export + `shared.json` federation paths (D-020).
- **Blueprint→PG** — must use the file-read/parse pattern, **not** the Hyperbee `TableProjection` (peer-sync CRDT machinery) (D-021).
- **Gym-port** — the A/B eval-matrix on the runtime-DAG is the one genuinely-new piece (D-022); the rest is re-exposing existing `lib/gym` primitives.
- **Scheduler** — the durable `routinesTick` exists; the missing link is the `pending_events → work_item` consumer (D-018).
- **Over-rename churn** — keep `featureId` in the coding path; generality lives in `work_items` + the blueprint, not a rename.
- **Validator gaps** → A4 + the gym safety net + the `coding` blueprint as a golden reference.
- **YAML footguns** → agents author via validated `blueprint:*` tools (canonical YAML); Zod on load.

## Decisions

### D-001 Keystone: the Harness Blueprint
Date: 2026-06-03
A harness's entire shape — work-item type, role set, orchestration spine, gates, gym rubric/signals, knobs — becomes one declarative, versioned, **agent-authorable, inheritable** Blueprint. Dissolves all four issues. Inheritance (`extends`) supplies the "shared structure so agents don't author from zero / don't burn tokens."

### D-002 Full pipeline-as-data
Date: 2026-06-03
The orchestration spine (today hardcoded `NEXT_*` verbs + a switch) becomes declared data the engine interprets. Chosen over "prompts/roles-only" and "bounded shapes": maximum generality; research needs it.

### D-003 Orchestration = a layered hybrid
Date: 2026-06-03
Declared-graph **spine** + runtime-generated **task DAG** (the plan — already exists) + reactive **expert overlay** (can preempt) + **harness-boundary recursion** (declared restart/escalation). Each layer corroborated (MAF/BT, Flow, 3T/blackboard, OTP). Recursion at the *harness* boundary, not free agent-call recursion, to preserve durability + gates + observability.

### D-004 Execution model = A (durable-workflow), not B
Date: 2026-06-03
Keep the durable-workflow model. `deriveNext(blueprint, runState)` is a pure function called inside `featurePipelineImpl`, replacing the `classifyDecision` switch. "Deterministic" = replay-safety (non-determinism captured in steps), not a behavior limit — A already runs dynamic/LLM-routed/reactive/long-lived flows; B unlocks no flow A can't, and B's ergonomic wins wash. Aligns with the in-flight DBOS-only cutover.

### D-005 Build on DBOS + PG; borrow patterns, not frameworks
Date: 2026-06-03
No framework accommodates our feature set — they compete with one layer (the engine), not the gym/marketplace/agent-authoring/work-item lifecycle. LangGraph: capable on spine+Level-2 (`Send`/`StateGraph`) but checkpointing ≠ durable execution → borrow, don't adopt. Durable execution = DBOS. Borrow from MAF, CWL/Nextflow, BTs, 3T, OTP, jidoka, NAS, Holacracy.

### D-006 Blueprint storage = git-canonical, projected to PG
Date: 2026-06-03
The blueprint lives as a versioned file in the managed harness's own repo (**`.papercusp/blueprint.yaml`** + referenced `.md` prompts), projected into PG (`harness_shared.blueprints`) so the interpreter reads PG. `git log`/`diff`/`revert` = audit/diff/revert, free. Document-table git-sync pattern. **Projection mechanism: file-read/parse, not the Hyperbee projector — see D-021.**

### D-007 Live-edit = a git commit; no PG versions table (mechanism is to-build)
Date: 2026-06-03
The andon-pull live fix = a **commit to the blueprint/prompt files** (`.papercusp/`), not a PG override-versions table. **Audit correction:** today `setPromptOverride` writes PG *directly* (no projection); under the git-canonical model the **`commit → reproject → effective-next-step` path is NEW work** that rides the D-021 file→PG loader (it does not exist today). `gym_proposals` (PG) = the transient review queue; accept → commit. `harness_prompt_overrides` (PG) kept ONLY as the workspace-divergence escape-hatch for shared harnesses.

### D-008 Data format = YAML + referenced `.md` prompts + Zod
Date: 2026-06-03
Structural blueprint in **YAML** (`.papercusp/blueprint.yaml`) — the declarative-workflow lingua franca, comments + clean diffs. Role prompts stay as **separate `.md` files** referenced by the blueprint (reuses `prompt-resolve.ts`; clean per-prompt git history; avoids inlining long markdown). A **Zod schema is the validator-of-record**. Agents author via validated `blueprint:*` tools that serialize canonical YAML, defusing footguns. JSON is the conservative fallback.

### D-009 No deprecation aliases
Date: 2026-06-03
Pre-alpha: clean renames + migrations now, no back-compat shims. Drove O-1→1b (D-013) and the `.papercusp/` migration (D-020). Exception: do **not** repo-wide-rename `featureId → workItemId` — keep `featureId` in the coding path; put generality in `work_items` + the blueprint declaration.

### D-010 Anti-over-decomposition is a first-class requirement
Date: 2026-06-03
The deep-research harness (105 agents) failed at a task a single agent does better — decomposition added the failure surface. A harness earns its overhead only on context-overflow, independence, durability/gating/observability, or parallel scale. The Blueprint must let a harness collapse to one role as cheaply as the maximal, and the **gym must discover that fewer roles is better** (NAS). Standing default: do research inline; invoke the deep-research *harness* only on overflow. Applied in D-016.

### D-011 Live-edit ↔ gym fusion (jidoka / kaizen)
Date: 2026-06-03
TPS andon: stop-the-line + fix-at-source + a kaizen record that improves the *standard*. A live edit is a candidate blueprint revision the gym can evaluate, and gym acceptance is the same commit action — fusing issue #4a (generalize gym) and #4b (live edits) into one surface. Realized by the gym-as-blueprint port (D-022).

### D-012 operator_claims is gone; idempotency = DBOS deduplicationID
Date: 2026-06-03
Migration 112 dropped `harness_shared.operator_claims`; the per-feature mutex is now DBOS `deduplicationID` on workflow enqueue (`orchestrator-workflow.ts:310`); file claims use the PG-backed `SuLocksCoordinator`. Corrects the earlier "reuse the claims table."

### D-013 Work-item substrate = 1b (canonical `work_items`); resolves O-1 — HIGH-COST migration
Date: 2026-06-03
Decided by avi (over 1a). A single canonical `work_items(workspace_id, harness_slug, item_id, kind, payload jsonb, status, …)` becomes the generic store; `harness_features_consolidated` becomes a view over `work_items WHERE kind='feature'`, and per-schema `harness_features` stays the auto-updatable view it already is (`scaffold-harness-schema.ts:114`). **Audit cost correction:** `harness_features_consolidated` carries **4 triggers** — `capture_substrate_outbox` (federation CDC, safety-critical), `emit_change_notify` (SSE), `fill_needs_design`, `fill_ws_features`. Turning it into a view requires rewriting all 4 as **`INSTEAD OF`** triggers on the view + re-testing the federation/SSE paths. This is a major, gated migration — sequence it as its own step, after the vertical slice proves out on `harness_features` as-is. No `work_items` table exists today (100% to-build; no naming conflict).

### D-014 The zero-regression gate is a gym A/B, not a unit test
Date: 2026-06-03
A5's gate is a gym A/B (`runAbEvaluation`, `ab-runner.ts`): hardcoded path vs blueprint path over a task set, equivalence confirmed by judge + deterministic signals. Audit-confirmed it runs on the existing repo-based gym **without the proposer** (needs runner+judge+signals only). Dogfoods the gym on the refactor that generalizes it.

### D-015 Per-blueprint gym trace collector (`blueprint.gym.collectTrace`)
Date: 2026-06-03
Audit-confirmed: the gym is repo-coupled below the four config seams — `collector.ts:24/28` builds the trace from `git diff <base> HEAD`; `clone.ts` clones substrate@commit. A `requiresRepo:false` blueprint can't run on it. So the target's `blueprint.gym.collectTrace` is the fifth seam: coding = git-diff over the clone; research = the work-item output + transcript.

### D-016 The research proof slice defaults minimal (applies D-010)
Date: 2026-06-03
The proof-slice `research` blueprint defaults to **1–2 roles** (one `researcher`), with `searcher`/`verifier` as reactive-overlay roles + an overflow path that spawns a sub-research-harness — honoring D-010 and exercising layers 3+4 (overlay + recursion), which a flat 5-role pipeline exercises neither of.

### D-017 Explicit handoff on `featurePipelineImpl` with the cutover peer
Date: 2026-06-03
A2/A3 edit the exact files the DBOS-only cutover peer (`su-ba55b115`) is changing (`orchestrator-workflow.ts`, `orchestrator-decide.ts`). "After the cutover settles" → an explicit coord pairing/handoff on `featurePipelineImpl` before either side edits it. Note: the DBOS orchestrator is opt-in today (legacy default), with the full-DBOS-only cutover (fallback removal) in flight.

### D-018 Scheduler: the durable `routinesTick` EXISTS; the gap is the `pending_events → work_item` consumer
Date: 2026-06-03
Blueprint ⟂ scheduler: separate engines. A blueprint optionally declares `triggers.schedule` defaults; `harness:create` materializes them into the PG `harness_shared.routines` registry (the runtime-editable source of truth — pause/retime via upsert, no commit). **Audit correction:** the durable DBOS `routinesTick` **already exists** (opt-in `PAPERCUSP_DBOS_ROUTINES=1`, `routines-workflow.ts`, registered in `bootstrap.ts`) — "Fate 1" is built, not future. The in-process loop (`routines-runtime.ts`) was designed but never started. The **real gap**: routine fires → `pending_events` row ✓, but **no consumer turns a routine `pending_events` row into a work-item** (a listener only observes via LISTEN/NOTIFY) — that consumer is the missing link for scheduled runs. Keep distinct from the reactive overlay (intra-run) and the orchestrator's 30s "process existing work" tick. No second scheduler (no pg-boss/BullMQ).

### D-019 Distribution = git(definition) + plugins(tools) + snapshot(state); templates subsumed
Date: 2026-06-03
A shareable harness unit is a Blueprint distributed across three layers: definition (blueprint YAML + prompts + `extends`) = git (the harness's repo) fronted by the **Cupboard**; code deps (custom tools) = **plugins** (runtime-installable, capability-gated; `defineTool` is host-agnostic via `@papercusp/tooldef`); optional state (work_items/runs/history) = a narrowed snapshot. Templates (a stale SPEC.md/file-copy seed bundle) are **subsumed**: a "template" = a blueprint + optional seed content. Gap to close: an import-time tool-dependency manifest (`dispatch-stack.ts:192` fails only at call-time). Full redesign: `harness-blueprint-distribution-2026-06-03`.

### D-020 Full `.harness/` → `.papercusp/` namespace migration
Date: 2026-06-03
Per avi: the generic `.harness/` conflicts with other tools and isn't ours-branded. Migrate ALL Papercusp harness artifacts to **`.papercusp/`** (config → `.papercusp/config.json`, state → `.papercusp/state/`, prompts → `.papercusp/prompts/`, blueprint → `.papercusp/blueprint.yaml`). One wide-but-mechanical rename touching config resolution (`readConfig`), the CLI (`papercusp init`), `scaffoldHarnessSchema`, the `.harness/state/` git-export + `shared.json` federation paths, and every `.harness/` literal. Pre-alpha → no compat alias. Avoids the split-brain of blueprint-in-`.papercusp/` + everything-else-in-`.harness/`.

### D-021 Blueprint → PG via the file-read/parse pattern, NOT the Hyperbee TableProjection
Date: 2026-06-03
Audit correction: `sync/hyperbee/projection.ts`'s `TableProjection` is **peer-sync CRDT machinery** (LWW, provenance, cross-machine federation) — wrong for a single-writer local git file. The git-canonical blueprint projects to its PG cache (`harness_shared.blueprints`) via the **same file-read/parse path plans/specs/config use** (parse-on-read / a git-export drain). The live-edit `commit → reproject` (D-007) rides this loader; both are to-build.

### D-022 The gym is a blueprint (a meta-harness); gym extensions = plugins
Date: 2026-06-03
Per avi's insight: a gym is just a harness whose work is "improve another harness's blueprint." Port `lib/gym/*` to a `gym` blueprint — roles generator/judge/proposer; spine generate→run-target(sub-harness)→judge→propose→A/B-gate→accept; the *target* declares its own `blueprint.gym` rubric/signals/collectTrace; the gym's primitives (`judgeGymRun`, `runAbEvaluation`, `signals`, `collector`) become tools/engine-primitives; the A/B eval-matrix runs on the runtime-DAG. **Gym extensions = harness plugins** (no separate "gym plugin"). The only thing "special": it's a built-in reference blueprint that operates on a *target* harness. Consequences: the gym is itself gym-able (meta), and this **supersedes/absorbs `harness-gym-eval-optimizer-2026-06-02`**. Reframes Phase D from "inject seams" to "port the gym."

### D-023 Kind-#1 creation generates an `extends: coding` blueprint from the repo
Date: 2026-06-03
Creating a harness from an existing git repo (kind #1) generates an `extends: coding` blueprint by inferring the **overrides**, not authoring from scratch (cheap, per D-001). Deterministic detection fills the high-value repo-specific bits — the **acceptance gate (test command, VERIFIED by running it once)**, the tool set (language/stack), and structural flags (monorepo → sub-harness, frontend → ui-qa role) — plus harvesting the repo's existing `AGENTS.md`/`CLAUDE.md`/`TESTING.md` as prompt context. LLM-refinement deferred past v1; the gym optimizes the seed (so it needn't be perfect). If the repo already has `.papercusp/blueprint.yaml`, skip generation. (Kinds #2/#3 generate-from-plan, the analogue.)
