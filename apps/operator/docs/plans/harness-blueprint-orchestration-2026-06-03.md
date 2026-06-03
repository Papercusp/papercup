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

**State:** Design **locked** across a multi-session brainstorm → deep-research (LLM frameworks + analogous domains) → a 5-surface codebase audit → a **peer code-review (2026-06-03), now incorporated** (6 gaps fixed: the gym's repo-coupling, the regression-gate method, the work-item substrate, the live-edit projection trigger, the proof-slice role count, and the cutover handoff). Execution model is **A** (durable-workflow). Not yet started in code; this is the reviewable + buildable spec.

**Next:** (1) **O-1 decided → 1b** canonical `work_items` (D-013); (2) O-2/O-3 are reviewer-endorsed (flat-graph-first, vertical-slice-first), **pending avi's explicit ratification**; (3) an explicit **handoff/pairing on `featurePipelineImpl`** with the cutover peer `su-ba55b115` **before** either side edits it (D-017); (4) populate formal P-items, then begin Phase A behind a flag with the **coding-blueprint gym A/B as the zero-regression gate** (A5 / D-014).

## Background

### The problem (the four issues)
The harness system was built configurable (per-harness prompts/settings) but assumed **humans** would author harnesses and submit them to a marketplace. We need **agents** to spin up and configure harnesses — coding and non-coding (first target: **research**) — from a declarative, inheritable, shareable definition, cheaply (low tokens, via inheritance). Concretely this dissolves four issues: (1) promoting a plan can only drop features into the parent coding harness's queue, all inheriting the parent's config — no separate config; (2) the promote step can't configure a new harness's roles/settings; (3) the system isn't configurable enough for a genuinely different workflow (research); (4) the gym is coding-specific and there is no gated way for a managing agent to fix a misbehaving role live.

### What the research established
The field is **bifurcated**, and the union is unoccupied — that gap is the differentiation:
- **Camp A (production orchestration):** Microsoft Agent Framework (the SK+AutoGen successor, 1.0 Apr-2026; graph workflows + HITL + YAML/JSON defs), LangGraph, AutoGen, CrewAI, Temporal. Durable + graph, but **code-authored, not self-improving, not agent-authored, no marketplace / work-item lifecycle.**
- **Camp B (self-designing, research):** ADAS / Meta Agent Search (arXiv 2408.08435 — agents authoring agents), AFlow (2410.10762, MCTS over code-workflows), AgentSquare, Gödel Agent, Flow (2501.07834 — runtime-regenerated AOV DAG = our Level-2), DSPy + GEPA/MIPROv2 (the gym's cousin). Agent-authored + optimizing, but **throwaway prototypes optimizing benchmark accuracy — not durable, gated, observable, or shareable.**
- **Nobody fuses them** into a durable + gated + observable **and** self-improving + agent-authored + shareable harness. That fusion is ours.
- *(Verification caveat: the deep-research harness's verify phase broke; prong-1 facts were re-confirmed by hand against primary sources; prong-2 is stable textbook knowledge.)*

### Borrowable patterns (prong 2 — borrow patterns, not frameworks)
BPM / Temporal (durable engine ⟂ workflow definition; human-task gates; Saga compensation) · scientific workflows **CWL / Nextflow** (a portable, shareable, reproducible workflow *document* + resume — the model for our blueprint format + marketplace) · CI/CD (composable reusable units + matrix fan-out; avoid YAML-as-a-programming-language) · **behavior trees** (composability beats FSMs — informs the spine) · robotics **3T + blackboard** (deliberative / executive / reactive = our spine / planner / overlay; the reactive tier can preempt) · TPS **jidoka / andon** (stop-the-line + fix-at-source + kaizen = live-edit → gym) · Erlang **OTP supervision** (declared restart/escalation strategy = sub-harness recursion) · **NAS** ("search-space design dominates the optimizer" → invest in the blueprint schema) · Holacracy (governance-as-versioned-data → blueprint amendment).

### The model — a layered hybrid (each layer corroborated)
1. **Spine** — a declared graph of phases the **director** (LLM) walks, deterministic edges where possible. *(MAF graph + behavior-tree composability.)*
2. **Runtime task DAG (Level 2)** — a per-goal plan a planner role generates; **we already have this** (plans → features w/ `wave`/`blocked_by`/`for_each`). *(Flow's runtime AOV.)*
3. **Reactive expert overlay** — condition-triggered roles that can **preempt** the spine; seed exists (`alwaysFireOn`, experts). *(3T + blackboard.)*
4. **Harness-boundary recursion** — a role spawns a durable sub-harness carrying a **declared restart/escalation strategy**; this is issue #3 (a coding harness spinning up a research sub-harness). *(OTP supervision.)*

**Anti-over-decomposition is first-class** (D-010): the minimal blueprint (1 role, 1 node) must be as cheap to express as the maximal, and the gym must be able to discover that *fewer* roles is better.

### Build vs borrow vs have
- **BUILD (our whitespace, unprovided anywhere):** blueprint-as-data, the generalized gym, the marketplace, agent-authoring, the work-item lifecycle, the acceptance/gate system.
- **BORROW (patterns):** the list above. LangGraph specifically: borrow its `Send`/`StateGraph` ergonomics, **do not adopt** (its checkpointing is *not* durable execution — weaker than DBOS — and it owns none of our differentiation).
- **HAVE (reuse):** DBOS durable execution; plans = the Level-2 DAG; `harness_prompt_overrides` + the gym control-plane (D-020); experts = the reactive seed; per-harness PG schemas; the endpoint system; the `defineTool` agent-tool surface.

### Execution model: A (durable-workflow) — corrected
We keep the **durable-workflow** model the system already uses and the in-flight cutover is hardening — **not** a plain-loop / per-task model ("B"). Rationale: "deterministic" in durable execution means *replay-safety of the control flow* (real-world non-determinism — LLM calls, time, randomness — is captured inside recorded **steps**), **not** a limit on behavior. A already runs maximally dynamic, LLM-routed, reactive, long-lived flows — the current `featurePipelineImpl` is exactly that. B unlocks **no** flow A cannot run, and B's ergonomic wins also wash (A already has a pure decision core — `classifyDecision` — and DBOS runs on Postgres). So the blueprint interpreter `deriveNext(blueprint, runState)` is a **pure function called inside the existing durable `featurePipelineImpl`**, swapping its hardcoded decision switch for a blueprint-driven graph walk. Idempotency stays on **DBOS `deduplicationID`** (`operator_claims` was dropped in migration 112). DBOS owns resume; no new per-feature pipeline-state table is needed.

## Plan
*(Code anchors verified against the repo at `/home/marsh-office/papercupai-workspace/papercup`, 2026-06-03. Formal P-items populated at kickoff.)*

### Phase A — Blueprint model + engine (keystone)
- **A1 Schema + storage.** `BlueprintSchema` (Zod) = `{ id, extends, version, workItem, roles[], spine, planner, reactive, gates, recursion, gym, knobs }`, a superset of `HarnessConfig` (`orchestrator/src/types.ts:23`). Stored as **git-canonical** `.harness/blueprint.yaml` (referencing role prompts as `.md`), **projected to PG** `harness_shared.blueprints` via the `TableProjection` pattern (`sync/hyperbee/projection.ts:30`). Loader sits beside `readConfig()` (`orchestrator/src/config.ts`).
- **A2 Spine-as-data interpreter.** Replace the hardcoded **22-case** switch in `classifyDecision()` (`orchestrator-decide.ts:31`, already pure) + the `DECISION_VERBS` list (`decision-parse.ts:19`) with a pure `deriveNext(spine, runState)` that walks declared `SpineNode`s. The **`coding` blueprint encodes today's verbs + switch as data → behavior-preserving**; `classifyDecision` stays as its reference and a unit-test surface (`orchestrator-decide.test.ts`) — but the real gate is the gym A/B (A5).
- **A3 Wire into the durable shell (model A).** `deriveNext()` is called inside `featurePipelineImpl` (`orchestrator-workflow.ts:143`) in place of the hardcoded classify; the `runner()` invocation (`orchestrator-runner.ts:116`) stays a durable step deduped by `deduplicationID` (`orchestrator-workflow.ts:269`). No new state table (DBOS holds it). **Promote** `MAX_TURNS` (already env-driven — `PAPERCUSP_DBOS_PIPELINE_MAX_TURNS ?? 200`, `orchestrator-workflow.ts:138`), the debugger threshold, and the finalization recipe (`orchestrator-finalize.ts`) **from env/hardcode → blueprint fields.**
- **A4 Validator** (the "agents can't author broken harnesses" guard): a pure `validateBlueprint(bp)` — reachability, termination, every node has an exit, guards well-formed, bounded recursion, work-item payload schema valid. Runs at author-time and on load. *(Compiler / type-checker framing; the gym is the secondary safety net.)*
- **A5 Base blueprints + the no-regress gate.** Ship `coding` (behavior-preserving lift) and a minimal `base`. The zero-regression gate is a **gym A/B** (D-014): run "hardcoded path" vs "blueprint path" as two variants over a task set; the judge + deterministic signals (regressions, terminal state) confirm equivalence. This is stronger than a unit test on the pure function — the decision surface is more than the 22-case switch (the `MAX_TURNS` loop, the retrying `decide-${turn}` step, debugger-before-worker, the chunk-loop worker, finalize, the auditor lane) — and it runs on the **existing repo-based gym** (no bootstrapping; needs the runner + judge + signals, not the proposer).

### Phase B — Agent-authorable creation
- **B1 Agent tools** `harness:create` + `blueprint:create/extend/validate`, via the `defineTool({...})` pattern (template: `agent-tools/memory/remember.ts`), registered by an `import` in `agent-tools/index.ts`. `harness:create` wraps `dispatchAction('scaffold_harness')` / `POST /api/harness/projects` (`projects.ts:175`) — confirmed safe (no direct `orchestrator.spawn`).
- **B2 Non-repo harness** (research case): make the `papercusp init` / git-init step in `doScaffoldHarness` (`execute-action.ts:607`) **conditional** on a `requiresRepo` blueprint flag. `scaffoldHarnessSchema` is pure SQL; the run path reads PG (no git); completion-ref verification is already skippable → low-risk (~2 migrations + a flag).
- **B3 Inheritance.** `extends` resolves a base blueprint + applies overrides; builds on the existing template / `spawnable` mechanism (`spawnable-templates.ts:35`). Authoring = extend a base (cheap, low-token).

### Phase C — Promote → new configured harness (issues #1 + #2)
Add `blueprint_slug?` to `plans:promote`. Seam at **`promote.ts:625`** (after the harness-exists validation): if a blueprint is supplied, `POST /api/harness/projects` to create the new harness, then route `postFeaturesImport` (`promote.ts:794`) to the **new** slug. `features/import` is already URL-parameterized (`features.ts:337`) — no handler change. Provenance (`source_plan_slug`, `claims`, `harness_plan_assertions`) carries for free.

### Phase D — Generalized gym + audited live-edits (issue #4)
- **D1 Generalize the gym** (control-plane already domain-free + per-(workspace,harness), D-020): inject a `blueprint` object into **five** coding-specific seams — `fileFeature → blueprint.fileWorkItem` (`gym-runner.ts:59`), `GYM_JUDGE_RUBRIC_V1 → blueprint.gym.rubric` (`judge-scoring.ts:46`), signals `→ blueprint.gym.signals` (`signals.ts`), pools `→ blueprint.gym.pools` (`task-generator.ts:23`), and — **the seam below the other four (D-015)** — the **trace collector** `→ blueprint.gym.collectTrace` (`collector.ts:24,67` builds the trace from `git diff`; `clone.ts` clones substrate@commit). Coding = git-diff over the clone; research = the work-item output + transcript. Without the fifth seam a `requiresRepo:false` blueprint cannot run on the gym.
- **D2 Live-edit = git commit** (the andon pull). A managing agent's fix to a misbehaving role = a **commit to the harness's blueprint / prompt files** (author + reason in the message). **Projection trigger + latency (D-007):** the tool-driven path (`blueprint:edit` / gym-accept) **re-projects to PG synchronously before returning** → deterministically effective on the next `deriveNext` step; a raw out-of-band commit is eventually-consistent via the git-export drain loop (worst-case = one drain interval). Light gate: warn if a gym cycle is running. **Unify with the gym** (jidoka/kaizen, D-011): `gym_proposals` (PG) is the transient review queue; **accept → commit**. `harness_prompt_overrides` (PG) is retained **only** as the narrow workspace-local-divergence escape-hatch for shared harnesses.

### Vertical proof slice — the research blueprint
A `research` blueprint (`extends: base`), **minimal by default per D-010/D-016**: one `researcher` role, `workItem.kind = question`, `requiresRepo: false`, gates = a verifier rubric. `searcher`/`verifier` are **reactive-overlay roles** (fire on conditions — a claim needs checking, scope too large) and an **overflow path** can spawn a sub-research-harness — so the slice exercises layers 3 (overlay) + 4 (recursion), not just a flat pipeline. Spun up by an agent from a plan (B + C), run end-to-end on A via the gym's `collectTrace` seam (D-015), with a live prompt-edit on a misbehaving role committed (D2) — all while the `coding` blueprint holds at **zero regression** via the gym A/B (A5 / D-014). Dogfoods the system: the `deep-research` skill is a candidate to become exactly this kind of minimal-default-with-overflow blueprint.

## Open decisions (reviewer-endorsed; pending avi's explicit ratification)
- **O-2 Spine representation.** Flat declared graph first (a 1:1 lift of the existing switch — lowest risk) vs behavior-tree composition. **Rec + reviewer-endorsed: flat first, BT later.**
- **O-3 Build strategy.** Thin vertical slice (research blueprint) first vs full Phase-A generality first. **Rec + reviewer-endorsed: vertical slice, coding-blueprint-as-anchor.**
*(O-1 work-item substrate is now decided → 1b; see D-013.)*

## Risks & mitigations
- **DBOS-cutover sequencing** — we stay on A (aligned). A2/A3 touch `orchestrator-workflow.ts` / `orchestrator-decide.ts`, the exact files the cutover peer is editing → an **explicit coord handoff on `featurePipelineImpl`** before either side edits it (D-017), not just "after."
- **Gym repo-coupling** (would have blocked the research slice) → the `collectTrace` fifth seam (D-015).
- **Regression measurement** → the gym A/B gate (D-014), stronger than a unit test.
- **1b migration touches the consolidated triggers/sync** (substrate_outbox, hyperbee projection) → sequence it carefully around the cutover (D-013).
- **Over-rename churn** — keep `featureId` as the opaque work-item id in the coding path (the view's id column); generality lives in `work_items` + the blueprint declaration, not a rename.
- **Blueprint validator gaps** → A4 + the gym safety net + the `coding` blueprint as a golden reference.
- **YAML footguns** → agents author via validated `blueprint:*` tools that serialize canonical YAML; Zod catches type bugs on load.

## Decisions

### D-001 Keystone: the Harness Blueprint

Date: 2026-06-03

A harness's entire shape — work-item type, role set, orchestration spine, gates, gym rubric/signals, knobs — becomes one declarative, versioned, **agent-authorable, inheritable** Blueprint. This single object dissolves all four issues. Inheritance (`extends`) supplies the "shared structure so agents don't author from zero / don't burn tokens."

### D-002 Full pipeline-as-data

Date: 2026-06-03

The orchestration spine (today hardcoded `NEXT_*` verbs + a switch in the dispatcher) becomes declared data the engine interprets — not a fixed code path. Chosen over "prompts/roles-only" and "bounded shapes": maximum generality, and the genuinely different workflows (research) need it.

### D-003 Orchestration = a layered hybrid

Date: 2026-06-03

Declared-graph **spine** (director walks it; deterministic edges where possible) + runtime-generated **task DAG** (the plan — already exists) + reactive **expert overlay** (can preempt) + **harness-boundary recursion** (sub-harness with a declared restart/escalation strategy). Each layer is corroborated by external prior art (MAF/BT, Flow, 3T/blackboard, OTP). Recursion lives at the *harness* boundary, not as free agent-call recursion, to preserve durability + gates + observability.

### D-004 Execution model = A (durable-workflow), not B

Date: 2026-06-03

Keep the durable-workflow model (DBOS) the system already uses and the cutover is hardening. The blueprint interpreter `deriveNext(blueprint, runState)` is a **pure function called inside `featurePipelineImpl`**, replacing the hardcoded `classifyDecision` switch. Reasoning: "deterministic" = replay-safety of control flow (non-determinism captured in recorded steps), NOT a behavior limit — A already runs dynamic / LLM-routed / reactive / long-lived flows. B unlocks no flow A cannot, and B's ergonomic wins wash (A already has a pure decision core; DBOS runs on PG). This reverses an earlier mistaken lean to B; staying on A is less work and aligns with the in-flight cutover.

### D-005 Build on DBOS + PG; borrow patterns, not frameworks

Date: 2026-06-03

No framework accommodates our feature set — they compete with one layer (the orchestration engine), not the gym / marketplace / agent-authoring / work-item lifecycle. LangGraph is capable on spine + Level-2 (`Send`/`StateGraph`) but its checkpointing is **not** durable execution (weaker than DBOS) and owns none of our differentiation → borrow its ergonomics, don't adopt. Durable execution = DBOS (already chosen, Postgres-native). Borrow design from MAF, CWL/Nextflow, behavior trees, 3T, OTP, jidoka, NAS, Holacracy.

### D-006 Blueprint storage = git-canonical, projected to PG

Date: 2026-06-03

The blueprint lives as a versioned file in the **managed harness's own repo** (`.harness/blueprint.yaml` + referenced prompt `.md`s), projected into PG (`harness_shared.blueprints`) so the interpreter reads PG. `git log` = audit history, `git diff` = change view, `git revert` = revert — all free. Follows the document-table git-sync pattern (storage-unification D-002), not the PG-canonical machine-row pattern.

### D-007 Live-edit = a git commit; no PG versions table

Date: 2026-06-03

The "andon pull" (a managing agent fixing a misbehaving role live) is a **commit to the blueprint / prompt files**, not a PG override-versions table (retracted from an earlier draft). **Projection trigger + latency:** the tool-driven path (`blueprint:edit` / gym-accept) **re-projects to PG synchronously before returning** → deterministically effective on the next `deriveNext` step; a raw out-of-band git commit is eventually-consistent via the existing git-export drain loop (worst-case staleness = one drain interval). `gym_proposals` (PG) stays the transient review queue; **accept → commit**. `harness_prompt_overrides` (PG) is kept ONLY as the narrow workspace-local-divergence escape-hatch for *shared* harnesses imported into multiple workspaces; single-workspace harnesses just commit. (Three of four earlier objections to git — repo-churn, latency, gym-unification — did not survive scrutiny; the surviving one, multi-workspace divergence, is the escape-hatch's sole purpose.)

### D-008 Data format = YAML + referenced `.md` prompts + Zod

Date: 2026-06-03

Structural blueprint in **YAML** (`.harness/blueprint.yaml`) — the declarative-workflow lingua franca (CWL/Nextflow/Actions/k8s), with comments + clean diffs. Role prompts stay as **separate `.md` files** referenced by the blueprint (reuses `prompt-resolve.ts`; gives clean per-prompt git history; avoids inlining long markdown). A **Zod schema is the validator-of-record** (tool input + file load + marketplace import). Agents author via validated `blueprint:*` tools that serialize canonical YAML, defusing YAML footguns. JSON is the conservative fallback (reuses the `config.json` idiom, no YAML dependency).

### D-009 No deprecation aliases

Date: 2026-06-03

Pre-alpha (no users, no production): clean renames + migrations now, no back-compat shims or "deprecate over a release cycle" (overriding two audit agents' suggestions). This principle drove the O-1 resolution to **1b** (D-013). Exception: do **not** do a repo-wide `featureId → workItemId` rename — keep `featureId` as the opaque work-item id in the coding path; put generality in the canonical `work_items` table + blueprint declaration (avoids massive churn mid-cutover; see Risks).

### D-010 Anti-over-decomposition is a first-class requirement

Date: 2026-06-03

The deep-research harness (105 agents) failed at a task a single agent does better — its decomposition added the failure surface. A harness earns its overhead only when the task overflows one context, needs independence, needs durability/gating/observability, or needs parallel scale. So the Blueprint must let a harness's shape collapse to a single role/step as cheaply as a maximal one, and the **gym must be able to discover that fewer roles is better** (NAS: search-space design dominates). Standing default for this work: do research/analysis inline; invoke the deep-research *harness* only on genuine overflow. Applied concretely in D-016.

### D-011 Live-edit ↔ gym fusion (jidoka / kaizen)

Date: 2026-06-03

TPS andon: any worker stops the line and fixes at source, AND the pull triggers a kaizen record that improves the standard. So a live edit is not just an instance fix — it is a candidate blueprint revision the gym can evaluate, and gym acceptance is the same commit action. This fuses issue #4a (generalize gym) and #4b (live edits) into one surface rather than two mechanisms.

### D-012 operator_claims is gone; idempotency = DBOS deduplicationID

Date: 2026-06-03

Migration 112 dropped `harness_shared.operator_claims`; the per-feature mutex is now DBOS `deduplicationID` on workflow enqueue (`orchestrator-workflow.ts:269`), and file claims use the PG-backed `SuLocksCoordinator`. This corrects the earlier plan's "reuse the claims table" — there is no claims table to reuse.

### D-013 Work-item substrate = 1b (canonical `work_items`); resolves O-1

Date: 2026-06-03

Decided by avi (over 1a). A single canonical `work_items(workspace_id, harness_slug, item_id, kind, payload jsonb, status, …provenance)` becomes the generic store; `harness_features_consolidated` becomes a typed view/projection over `work_items WHERE kind='feature'`, and the per-schema `harness_features` stays the auto-updatable view it **already is** (`scaffold-harness-schema.ts:115`) — a three-layer chain (per-schema view → consolidated → `work_items`). Chosen to honor D-009 (do the right migration now, no permanent surgical `work_items_all` compromise). The coding path keeps `featureId` as the view's id column (per D-009); the generic layer uses `item_id`. Risk: the migration touches the consolidated table's triggers (`substrate_outbox`, hyperbee projection, sync) — sequence it carefully around the DBOS cutover (D-017).

### D-014 The zero-regression gate is a gym A/B, not a unit test

Date: 2026-06-03

(Peer review #2.) The `coding`-blueprint no-regress gate (A5) is an actual gym A/B: "hardcoded path" vs "blueprint path" as two variants over a task set, with the judge + deterministic signals (regressions, terminal state) confirming equivalence. Far stronger than "classifyDecision stays as the reference" — the decision surface is more than the 22-case switch (MAX_TURNS loop, retrying decide step, debugger-before-worker, chunk-loop worker, finalize, auditor lane) — and it dogfoods the gym on the very refactor that generalizes it. Runs on the existing repo-based gym (no bootstrapping; needs runner + judge + signals, not the proposer).

### D-015 A fifth gym seam: `blueprint.gym.collectTrace`

Date: 2026-06-03

(Peer review #1 — code-verified.) The gym runner is repo-coupled *below* the four Phase-D seams: `collector.ts` builds the trace from `git -C <clone> diff <base> HEAD` (`collector.ts:24,67`) and `clone.ts` clones substrate@commit. A `requiresRepo:false` research blueprint has no clone/diff, so D1 adds a fifth seam — `blueprint.gym.collectTrace` (coding = git-diff over the clone; research = the work-item output + transcript). Without it the research proof slice cannot run on the gym or the live-edit→gym loop.

### D-016 The research proof slice defaults minimal (applies D-010)

Date: 2026-06-03

(Peer review #5.) The proof-slice `research` blueprint defaults to **1–2 roles** (a single `researcher`), with `searcher`/`verifier` as **reactive-overlay roles** that fire on conditions and an **overflow path** that can spawn a sub-research-harness — honoring D-010 (anti-over-decomposition) and exercising layers 3 (overlay) + 4 (recursion), which a flat 5-role pipeline exercises neither of. (Corrects an earlier self-contradiction in this plan: a 5-role research pipeline violated its own D-010.)

### D-017 Explicit handoff on `featurePipelineImpl` with the cutover peer

Date: 2026-06-03

(Peer review #6.) A2/A3 edit the exact files the DBOS-only cutover peer (`su-ba55b115`) is actively changing (`orchestrator-workflow.ts`, `orchestrator-decide.ts`). "After the cutover settles" is replaced by an explicit coord pairing/handoff on `featurePipelineImpl` specifically — neither side edits it without the handoff — not just temporal ordering.

### D-018 — Blueprint ⟂ scheduler: separate engines; blueprint declares schedule defaults materialized into `routines`
Date: 2026-06-03
Scheduling (WHEN work is triggered) and the blueprint (HOW work flows) are separate engines, joined at one seam. The blueprint optionally declares `triggers.schedule` defaults (cron/event/on-demand + concurrency/catchup policy) — git-canonical, part of the shape. `harness:create` MATERIALIZES those defaults into the PG `harness_shared.routines` registry, which is the runtime-editable source of truth thereafter (pause/retime/disable via upsert — no commit, no blueprint edit). The DBOS `routinesTick` (the scheduler's chosen "Fate 1": keep the routines table + per-row policies, replace its in-process setTimeout loop with a durable DBOS-driven tick; do NOT add a second scheduler like pg-boss/BullMQ) fires the due routine → emits a `pending_events` row → a consumer creates a `work_item` (e.g. a `question`) → the blueprint spine processes it. `pending_events → work-item → spine` is the single handoff. Keep this DISTINCT from (a) the blueprint's reactive overlay (intra-run, engine-owned condition/verb triggers, D-003 layer 3) and (b) the orchestrator's existing 30s "process existing ready work" tick — three different things that all happen to be DBOS ticks. The blueprint is a PRODUCER of routines rows; it does not own the scheduler.

### D-019 — Distribution = git(definition) + plugins(tools) + snapshot(state); templates subsumed by blueprints
Date: 2026-06-03
A shareable harness unit is a Blueprint, distributed across three layers that map onto systems we already have: (1) DEFINITION (blueprint YAML + referenced prompt `.md` + the `extends` chain) travels via GIT — the harness's own repo — fronted by the real Cupboard listings service (`apps/operator-public/`, Cloudflare-Worker + D1, keyed by `github_repository_id`); the Entry-4 `papercusp://harness?...` join already git-clones `.harness/*`. (2) CODE deps (custom tools a blueprint's roles need) travel as PLUGINS — the existing runtime-installable, capability-gated code unit (`libs/papercusp/plugins/`, `papercusp.json` declares `tools[]`+capabilities, auto-installed by `init --from`); since `defineTool` is now host-agnostic (`@papercusp/tooldef`, with `@papercusp/agent-mcp` re-exporting it), a portable tool is just a `(input,ctx)=>result` function bundled in a plugin. (3) STATE (work_items, runs, history) travels via a NARROWED snapshot (`snapshots:*` / `@papercusp/export-state`) only for "fork with data." TEMPLATES — today a SPEC.md/file-copy seed bundle (stale: still seeds deprecated SPEC.md/validation-contract; only one real built-in; flag-gated off) — are SUBSUMED: a "template" = a blueprint + optional seed content. Key gap to close: an IMPORT-TIME tool-dependency manifest (today a blueprint referencing an absent tool fails at call-time with `unknown_tool`, no upfront validation — confirmed at `dispatch-stack.ts:192`). Full redesign: companion plan `harness-blueprint-distribution-2026-06-03`.
