# BRIEF — Three demonstration blueprints (review · migration · deliberation)

**Owner:** aviynw@gmail.com · **Created:** 2026-06-04 · **For:** one agent, all three.

## Goal
The blueprint engine is **live and blueprint-driven** — the DBOS orchestrator runs `deriveNext(spine, …)` (`packages/operator-core/lib/dbos/orchestrator-workflow.ts:226`), and `base` / `coding` / `research` / `gym` blueprints already exist (`libs/papercusp/packages/harness/blueprints/*/blueprint.yaml`). Add **three new blueprints** that each demonstrate a *distinct orchestration shape* the existing set doesn't, and unlock a capability we currently hand-roll: **review/audit**, **migration/codemod**, **deliberation/vote**. These are showcases of the engine's range, not toys.

## Conventions (study the existing ones first)
- **Read `coding/blueprint.yaml` and `research/blueprint.yaml` before writing anything** — match their structure exactly: `id`, `extends: base`, `version`, `description`, `workItem {kind, idPrefix}`, `spine {decider, maxTurns, default, edges}`, `planner {kind}`, `roles[]`, `reactive[]`, `gym {collectTrace, signals}`, `knobs`. **`extends: base`** — keep each blueprint thin.
- The spine is **decider-driven**: a director role emits a `DecisionVerb` each turn; `deriveNext` maps it via `edges` to an action (`to: done|escalate|idle|role`). Define an explicit edge per verb (parity with the existing blueprints).
- Each new role needs a **persona** at `libs/papercusp/packages/harness/prompts/<role>.md` (mirror an existing one).
- **Honor anti-over-decomposition (D-010), like `research`:** the *default* path is the cheapest single agent; heavier roles are **reactive-overlay** roles the director dispatches only when warranted. Don't make every blueprint a big pipeline.
- **Validate** with the `blueprint:validate` tool / `blueprint/validate.ts`, and add a loader test that the spine parses and `deriveNext` resolves every edge (mirror the coding equivalence-test harness, minus the byte-equivalence — these are *new* shapes, so there's no legacy path to match; the test asserts the spine is well-formed + drives a smoke task).
- **Coordinate:** the orchestrator/blueprint area is active (su-adb1b, the harness-blueprint owners) — coord-check before editing shared engine files; these blueprints should be **additive** (new dirs + new role prompts), touching the engine only if a capability is genuinely missing (see "parallel dispatch" gotcha).

## ① `review` — parallel-dimension review → adversarial verify → synthesize
**Shape (new):** fan-out across review *dimensions*, adversarially *verify* each finding, then *synthesize*. **Unlocks:** code review, security audit, plan audit, PR review — the exact pattern done by hand this session.
- `workItem: { kind: review-task, idPrefix: RV }`. `requiresRepo: true` (configurable — it can also review a plan/doc; gate on a knob).
- Roles: `review-director` (decider), `reviewer` (per-dimension), `verifier` (reactive — *adversarial*, tries to refute a finding), `synthesizer` (dedup + rank confirmed findings).
- Spine verbs/edges: `NEXT_REVIEWER` (dispatch a dimension reviewer), `NEXT_VERIFIER` (adversarially verify a finding), `NEXT_SYNTHESIZER`, `DONE`, `ESCALATE`, `IDLE`.
- `reactive`: `verifier` runs `afterRole: reviewer` (verify each finding before it counts).
- `knobs`: `dimensions: [bugs, security, perf, style, …]` (configurable), `confidenceThreshold`.
- `gym: { collectTrace: work-item-output }` (the findings report — like research, not a git diff).
- The **adversarial verifier is the key demo** — it's what makes review trustworthy (refute-by-default, majority-refute → drop the finding).

## ② `migration` — discover sites → transform each (isolated) → verify
**Shape (new):** discover a work-list, transform each item **in isolation, in parallel**, verify. **Unlocks:** safe large mechanical change (renames, codemods, dep bumps — the operator-core carve / `.harness→.papercusp` rename patterns).
- `workItem: { kind: migration-task, idPrefix: M }`. `requiresRepo: true`.
- Roles: `migration-director` (decider), `discoverer` (find all sites matching the migration pattern → a site list), `transformer` (transform ONE site — declare **`isolation: worktree`** so parallel transforms don't collide), `verifier` (tests/build green per site + overall).
- Spine verbs/edges: `NEXT_DISCOVERER`, `NEXT_TRANSFORMER` (per site), `NEXT_VERIFIER`, `DONE`, `ESCALATE`, `IDLE`.
- `knobs`: `pattern` (what to find/transform), `maxParallel`, `verifyCmd`.
- `gym: { collectTrace: git-diff }` (it produces code changes).
- The **worktree isolation on `transformer` is the key demo** — many sites transformed concurrently without stomping (mirror the Agent tool's `isolation: worktree`).

## ③ `deliberation` — coordination-ops as spine steps (vote) — **GATED**
**Shape (new):** the spine invokes **coordination ops** (open-thread → fan-out diverse voters + advocate → collect-to-quorum → aggregate → gate resolve/escalate). **Unlocks:** autonomous decision-making / the uncertainty-ladder (turn `needs-human` → peer-resolved).
- **DEPENDENCY:** this is the canonical worked example of `coordination-ops-as-blueprint-primitives-2026-06-04` (Option B — coord ops as declarative spine steps). **Build it AFTER that plan lands** (it needs the `collect`/`aggregate` ops + the spine's coord-op step type). If that's not built yet: **write the blueprint.yaml + role personas as the ready spec and stop there** — don't hand-roll the spine generalization here; that's the other plan's job. Flag the blocker in the plan's `## Now`.
- `workItem: { kind: decision, idPrefix: D }`. `requiresRepo: false`.
- Roles: `vote-director` (decider), `voter` (count = `payload.lenses.length`, **one per lens** — diversity is the anti-correlated-error defense), `advocate` (argue *against* the leading option).
- Spine (coord-op steps): `open-thread` → `fan-out` (spawn voters+advocate, inject the question) → `collect` (until `posts ≥ quorum OR timeout`) → `aggregate` (confidence-weighted) → gate: decisive → `resolve` / split → `coord:escalate(human, {thread, split, objection})`.
- `knobs`: `{ quorum, max_voters, timeout_s, budget }`. `recursion: { max_depth: 2 }`.
- See the full worked IR + execution trace in `coordination-ops-as-blueprint-primitives-2026-06-04` (the `vote` blueprint section).

## Build order
1. **`review`** — buildable now on the existing engine. Start here.
2. **`migration`** — buildable now (verify the engine supports a `worktree`-isolation role; if not, see the gotcha).
3. **`deliberation`** — gated on `coordination-ops-as-blueprint-primitives`. If unbuilt, ship the spec (yaml + personas) only.

## Gotchas / things to verify against the real engine
- **Parallel role dispatch:** the existing spines are *sequential* (one decider verb per turn). `review` (dimensions) and `migration` (per-site transforms) *want* parallelism. **Check whether the engine/orchestrator supports fan-out (multiple role agents at once) or only sequential dispatch.** If only sequential, model the director as *iterating* dispatches (accumulating findings/sites in the work-item) — still correct, just serial — and note parallel fan-out as a follow-up engine capability. **Don't silently assume parallelism exists.**
- **`isolation: worktree`** — confirm the blueprint role schema supports it (the Agent/Workflow layer has it; verify the harness spine role does). If not, that's a small engine addition to flag, not hack around.
- **Anti-over-decomposition:** `review` with one dimension, or `migration` with one site, should degrade to a single agent — keep the cheap path cheap (like `research`'s single-`researcher` default).
- **Personas matter:** a blueprint with no role persona is inert. Write `prompts/<role>.md` for every new role (reviewer, verifier, synthesizer, discoverer, transformer, voter, advocate, the three directors).

## Deliverable / acceptance
- `review/blueprint.yaml` + `migration/blueprint.yaml` (+ `deliberation/blueprint.yaml` spec) under `libs/papercusp/packages/harness/blueprints/`, each `extends: base`, each passing `blueprint:validate`.
- Role personas for every new role.
- A loader/spine test per blueprint (parses, every edge resolves, a smoke task drives `deriveNext` to `done`).
- A short note in each blueprint's header comment (like coding/research have) stating its shape + what it demonstrates.
- For `deliberation`: the spec + the explicit "gated on coordination-ops-as-blueprint-primitives" note if that plan hasn't landed.

---

## Outcome (2026-06-04, su-fd902)

**All three demonstrated.** ① + ② built + tested green; ③ was already built by the
gating plan, so it's satisfied without duplication.

### ① `review` — DONE (built + tested)
- `blueprints/review/blueprint.yaml` (decider-mode, `extends: base`) — verbs
  `NEXT_REVIEWER` / `NEXT_VERIFIER` / `NEXT_SYNTHESIZER` / `DONE` / `ESCALATE` / `IDLE`;
  `workItem: {review-task, RV}`; `gym.collectTrace: work-item-output`; knobs
  `dimensions` + `confidenceThreshold`; the adversarial verifier is a reactive
  overlay `afterRole: dimension-reviewer`.
- Personas: `review-director`, `dimension-reviewer`, `finding-verifier`
  (refute-by-default), `findings-synthesizer`. (NOT the existing
  `reviewer`/`verifier`/`synthesizer` ids — those resolve different prompts:
  coding-proposal-reviewer, research-claim-checker, code-merge-synthesizer. Distinct
  ids avoid wrong-prompt collisions.)
- Test: `orchestrator/src/blueprint/review.test.ts` — loads/validates, shape, every
  role has a prompt, and `deriveNext` drives a smoke review through every edge to `done`.
- `blueprint:validate review` → `{ok:true, 0 errors, 0 warnings}`.

### ② `migration` — DONE (built + tested)
- `blueprints/migration/blueprint.yaml` (decider-mode, `extends: base`) — verbs
  `NEXT_DISCOVERER` / `NEXT_TRANSFORMER` / `NEXT_VERIFIER` / `DONE` / `ESCALATE` /
  `IDLE`; `workItem: {migration-task, M}`; `gym.collectTrace: git-diff` +
  `regressionsFromTests`; knobs `pattern` / `maxParallel` / `verifyCmd` +
  `worktrees.enabled`.
- The **transformer declares `isolation: worktree`** (the key demo). This required a
  small additive engine change: `BlueprintRoleSchema` gained an optional
  `isolation: 'none' | 'worktree'` field (`orchestrator/src/blueprint/schema.ts`) —
  without it Zod silently strips the unknown key. Purely additive, all 675
  orchestrator tests + 7 operator-core blueprint-tool tests still green.
- Personas: `migration-director`, `discoverer`, `transformer`, `migration-verifier`.
- Test: `orchestrator/src/blueprint/migration.test.ts` — loads/validates, shape,
  asserts `transformer.isolation === 'worktree'` survives the load, every role has a
  prompt, `deriveNext` drives a smoke migration to `done`. Plus a focused
  `schema.test.ts` case pinning the isolation enum.
- `blueprint:validate migration` → `{ok:true, 0 errors, 0 warnings}`.

### ③ `deliberation` — ALREADY SATISFIED by the landed `vote` + `deliberate`
The gating plan `coordination-ops-as-blueprint-primitives-2026-06-04` **landed**
(D-011, su-d8fe0) BEFORE this brief was worked. Its `vote/blueprint.yaml` IS this
brief's deliberation worked example — program-mode spine `open-thread → fan-out →
collect → aggregate → gate`, `workItem: decision`, roles `voter` (one per lens) +
`advocate`, knobs `quorum`/`max_voters`/`timeout_s`/`budget`, `recursion.maxDepth:2`,
personas `vote/prompts/{voter,advocate}.md`. `deliberate` adds the uncertainty-ladder
(`coord:ask → coord:vote → coord:escalate`). Both load + validate + are tested in
`program-blueprints.test.ts`. **I did NOT create a duplicate `deliberation`
blueprint** — that would be redundant with `vote`/`deliberate` (the brief itself
names the `vote` blueprint as the worked example). The only cosmetic divergence from
the brief sketch: idPrefix is `VOTE`/`DLIB` (not `D`), and it's a program-mode spine
(not a `vote-director` decider) — which is the *better*, intended Option-B realization.

### Gotchas resolved (per the brief's "things to verify")
- **Parallel dispatch:** the decider spine is **sequential** (one verb/turn;
  confirmed via `deriveNext` + `rejectWhenParallel`). Both new directors therefore
  *iterate* dispatches, accumulating dimensions/sites on the work-item — correct,
  serial. True fan-out (N reviewers / N transformers at once) is a **flagged
  follow-up** = a global-orchestrator capability the per-pipeline spine doesn't have.
- **`isolation: worktree`:** the role schema did **not** support it → added the
  field (above). The *declaration* is validated + carried; **runtime honoring**
  (actually spawning the transformer in a worktree, in parallel) is the same
  follow-up gated on fan-out.
- **Anti-over-decomposition (D-010):** both degrade to the cheap single-agent path
  (one dimension / one site) — documented in each header + director persona.

### Follow-ups flagged (NOT done — out of brief scope)
1. **Parallel role fan-out** in the engine (global-orchestrator capability) so
   `review` dimensions / `migration` sites run concurrently; then the transformer's
   `isolation: worktree` is *honored* at dispatch (today it's a validated declaration).
2. **`:3070` restart** to make the new `isolation` schema field live in the running
   host (server-side lib has no hot-reload). Validation + tests use the freshly
   compiled schema and are green; the live `blueprint:validate` already reads the
   YAML fresh from disk and reports both blueprints valid. git-sync will commit the
   tree; the field goes live on the next natural host restart.
