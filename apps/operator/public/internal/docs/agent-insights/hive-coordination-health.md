# Rubric method: hive-coordination-health (the 14-criteria scorecard)
URL: /internal/docs/agent-insights/hive-coordination-health

The investigation method behind the `hive-coordination-health` rubric — the model, how-to-investigate (live DB signals), and drift markers for each of the 14 per-characteristic criteria that Overwatch (and any agent) grades a structured observation against. This MDX is the rubric's `method_ref`; the structured part (criteria keys, rating scale, drift markers) lives in the `rubrics` store.

## What this is

`hive-coordination-health` is the first ratified **rubric** in the rubric-driven-observations
system (`rubric-driven-observations-2026-06-20`). A rubric is the reusable STANDARD for a
system characteristic; the agent's output against it is a **structured observation** (rubric
ratings + mandatory evidence), with free-text observations still first-class.

This rubric generalizes the owner's one-off 13-question hive-coordination scorecard
(`hive-coordination-test-loop-2026-06-20` D-001) into a standing capability, since extended to
**14 criteria** (the founding 13 + `scheduler-usage`, added by
`hybrid-bee-scheduler-work-stealing-2026-06-22` P-004). The **Overwatch** role MUST emit a
structured scorecard against it **every turn** (owner requirement #1): rate each of the 14
criteria + cite evidence, in addition to its free-form observations.

This page is the rubric's **`method_ref`** — the long-form METHOD. The structured part (the 14
criteria `key`s, per-criterion `model`/`method`/`driftMarkers`, the default rating scale) lives
in the `rubrics` store (`rubrics:get { rubric_id: 'hive-coordination-health' }`). Author this
prose; grade against the store.

## The shared rating scale

Every criterion is rated on the shared vocabulary (so the Overwatch scorecard and Scout's
grouping line up):

```
healthy   — works as the model describes; no drift
degraded  — partially working; a drift marker is present but the stage still produces output
broken    — the model's invariant is violated; the stage produces no usable output
unknown   — not assessable from the current evidence (idle stage, no signal) — NOT a failure
```

A rating without **evidence is rejected** at capture time. "unknown" is a first-class, honest
rating — an idle stage with no signal is `unknown`, never `broken`.

## Three pitfalls that invalidate a naive read

These trip every first-time hive auditor. Apply them to EVERY criterion below.

1. **Multi-workspace.** Started hives live across MULTIPLE `workspace_id`s (`papercusp`,
   `default`, `generic-test`, `lane7`, wildcard `*`, plus eval instances). Recon scoped to ONE
   workspace mis-reads the loop as dead. ALWAYS enumerate first:

   ```sql
   SELECT workspace_id, hive_slug, max(tick_at)
   FROM harness_shared.hive_throughput_ticks
   WHERE tick_at > now() - interval '30 min'
   GROUP BY 1, 2;
   ```

2. **Idle is not dead; activity is not health — check WHY.** A Queen can be idle by GOOD
   judgment (frontier drained, holding undecided/needs-design items, leaving cursed alone,
   long cadence on a vacuous frontier). Conversely "woke, burned budget, 0 placements" can be
   a broken/cursed/unpromoted frontier. Distinguish by reading the carryNote
   (`hive_wake.payload`) + actual completions — NOT wake-count or spend.

3. **Silence is not health (the cursed-latch).** A cursed item stops escalating by design, and
   a stale alarm can keep firing on a premise live state already contradicts. "No alarms" is
   not evidence of health. Report stage-by-stage numbers + WHICH workspace/hive, never "no
   alarms / looks fine".

## The 14 criteria

Each criterion lists its `key` (the stable id graded against), its MODEL (how it is supposed
to work), the METHOD (live signals to investigate — source of truth is code + DB, never
docs/tool-summaries), and the DRIFT MARKERS (what a big drift looks like).

### 1. `end-to-end-flow` — the full loop turns end-to-end

* **Model.** The self-improving loop is a closed cycle: observe → scout-ideate → grade →
  plan-start/promote → queen-place → bee-complete → commit/git-sync → observe. Health = the
  WHOLE loop turning. Each stage must hand off to the next with no structural dead-end; any one
  broken hand-off breaks closure even if other stages look busy.
* **Method.** Walk every stage in the live DB after enumerating hives across all workspaces:
  (a) observations flowing — `engineer_issues` where `payload.lane = 'observation'`, recent
  distinct authors; (b) `scout_ticks` ran AND ideas greater than 0; (c) plans started +
  promoted to `work_items`; (d) `hive_placements` with a completion in the last hour;
  (e) git-sync auto-commits recent. The tell of a BROKEN vs merely-quiet loop: input present
  at stage N, output absent at stage N+1.
* **Drift markers.** A stage emits zero output for more than one cycle while upstream produces
  input: Scout 0 ideas in 24h with a non-empty observation corpus; Queen 0 placements with a
  ready actionable frontier + idle bees; bees claim an item but make 0 tool calls (zombie).

### 2. `ideation-quality` — Scout idea quality and thematic diversity

* **Model.** Scout generates grounded, systemic, evidence-backed ideas from the
  observation/change-feed corpus, AND spans diverse themes (low duplication, broad coverage of
  the friction surface) rather than converging on one theme.
* **Method.** Read recent Scout ideas (`scout_ticks`, `routed_ideas`); judge each for grounding
  (cites real evidence), systemic value (root-cause not symptom), and novelty. Cluster the last
  batch by theme — a healthy batch spreads; a degraded one converges (e.g. 5 of 8 on one queue
  theme, near-duplicate ideas). 0 ideas with a non-empty corpus AND zero budget spent is
  transport-death (a TRANSPORT failure), not low quality — check per-ideator ok/error.
* **Drift markers.** Thematic convergence (a majority of a batch on one theme; near-dup ideas);
  shallow symptom-only ideas; OR a hard 0-ideas transport-death.

### 3. `queen-workitem-selection` — Queen picks the right work-items

* **Model.** From the ready frontier the Queen places the most valuable ACTIONABLE items,
  correctly HOLDS undecided/needs-design items, leaves cursed items alone, and refuses to place
  a vacuous/unpromoted frontier. Reasoned idleness is correct, not a failure.
* **Method.** Compare placements against the ready frontier (`work_items` todo/ready) — would
  you pick these? Read the carryNote (`hive_wake.payload`) for WHY she held or placed. A Queen
  holding undecided items + leaving cursed alone + long cadence on a vacuous frontier is GOOD.
  "Woke, burned budget, 0 placements" with a ready actionable frontier is the problem case —
  distinguish by carryNote + completions, not wake-count/spend.
* **Drift markers.** Places low-value/cursed/needs-design items; OR leaves clearly-actionable
  high-value items unplaced while idle with capacity (the "88 unplaced, idle fleet" pattern);
  places into a vacuous frontier and manufactures zombies.

### 4. `queen-plan-selection` — Queen pursues the right plans

* **Model.** The Queen starts/pursues the right plans in priority order and does NOT
  auto-materialize plans that are not ready (she does not force-start a draft).
* **Method.** Look at started plans across member harnesses and the Queen's plan-selection
  reasoning. Signal is limited when Scout is not routing plans — assess what she does with what
  is available; she should respect plan readiness (draft vs ready) and not auto-start.
* **Drift markers.** Starts unready/draft plans; ignores a high-priority ready plan; or churns
  on a dying system's plans. Low evidence is `unknown`, not `broken`.

### 5. `parallel-distribution` — batch placement + tight topic scope

* **Model.** When multiple independent items are ready, the Queen places a parallel BATCH
  (`fleet:place_batch`), distributes across bees by affinity (disjoint files/topics), and scopes
  each bee's topic-subscriptions TIGHTLY (its own item + plan topics) to avoid chatter.
* **Method.** Observe a parallel seed: did she batch-place concurrent bees on disjoint work? Is
  file/topic affinity overlap minimized? Are per-bee topic subscriptions narrow? Only
  observable when a parallel-ready frontier exists.
* **Drift markers.** Serializes genuinely-parallel work; places overlapping bees that collide on
  locks; over-broad topic subscriptions causing chatter. Idle is `unknown`, not `broken`.

### 6. `bee-execution` — bees complete real, verified work

* **Model.** A bee boots with full MCP tools, claims its item, makes real tool calls, and
  completes a well-scoped, correct, VERIFIED change in one turn (tests run, not diagnosis-only),
  then commits.
* **Method.** For observable bees: did it boot clean (WaitForMcpServers; tools present — no
  zombie)? Did it make tool calls (a claim with 0 tool calls is the EI-1758 zombie)? Was the
  completion well-scoped + verified (tests run) vs diagnosis-only / observability-only when a
  root-cause fix was scoped? Watch token-budget exhaustion truncating non-trivial fixes.
* **Drift markers.** Zombie bees (claim, 0 tool calls, no MCP tools at bootstrap);
  diagnosis-only completions where a fix was scoped; uncommitted/undeployed fixes
  (self-referential infra deadlock); token-budget truncation on ambiguous items.

### 7. `bee-observation-quality` — bees file good observations

* **Model.** Bees emit specific, root-cause-oriented, quantified, actionable turn-end
  observations (`lane = observation`) — the raw material Scout ideates on — reliably, not
  unevenly.
* **Method.** Read recent `lane = observation` entries by bee authors; judge
  specificity/root-cause/quantification. Check emission COVERAGE — every turn, or uneven?
  Emission is prompt-driven, not enforced, so under-emission is a known risk.
* **Drift markers.** Sparse/absent observations from active bees; vague symptom-only
  observations; no quantification or evidence.

### 8. `overwatch-observation-quality` — overwatch observations + the mandatory scorecard

* **Model.** Overwatch is the system's self-monitor: it emits specific, self-aware observations
  AND (owner requirement #1) ALWAYS emits a STRUCTURED scorecard against THIS rubric every turn
  (rate each criterion + cite evidence), in addition to free-form.
* **Method.** Read recent overwatch observations/escalations — specific + self-aware (catching
  stale panels, conflations, over-fires)? Verify the structured scorecard is emitted EVERY turn
  against `hive-coordination-health` (`rubricRef` set, all 14 criteria rated, evidence
  non-empty on each). A missing scorecard is an owner-#1 violation even if the free-form is
  good.
* **Drift markers.** Free-form only, no structured scorecard (owner #1 violation); a scorecard
  with missing criteria or empty evidence; stale/echoed observations that contradict live state.

### 9. `watchdog-determinism` — deterministic fires that self-clear

* **Model.** The watchdog fires deterministically and correctly on real conditions, and its
  alarms SELF-CLEAR against live state rather than continuing to fire on a stale premise.
* **Method.** Check fires (`watchdog_ticks`) — deterministic + correct? Are they noisy (hundreds
  of "no wake armed" fires in a reboot window)? Critically: do alarms self-clear when the
  premise is contradicted by live state (e.g. an "EI-1758 fire-path down" echo contradicted by
  live completions)?
* **Drift markers.** Fires on stale premises that live state contradicts (alarms do not
  self-clear); excessive noise drowning real signal; or non-deterministic/missed fires.

### 10. `coordination-comms` — handoffs, evidence, mutual correction

* **Model.** Agents communicate constructively: clean handoffs, evidence-citing messages,
  mutual correction — without re-litigation waste (many agents re-verifying the same thing).
* **Method.** Read the coord stream — handoffs accepted, evidence cited, peers correcting each
  other constructively? Look for RE-LITIGATION waste (N agents re-verifying the same reds; a
  stale echo re-broadcast as live).
* **Drift markers.** Re-litigation (duplicate verification of the same fact by many agents);
  stale claims re-broadcast as live; handoffs dropped; non-evidence-based assertions.

### 11. `chatter-economy` — excess chatter removable by design

* **Model.** Coordination volume is economical — structural mechanisms (a verify-already-done
  auto-resolver, self-clearing alarms, less watchdog spam) remove duplicate/ceremonial chatter
  rather than relying on agent discipline.
* **Method.** Measure coord volume + the duplicate fraction (e.g. 1650 messages, much dup
  verification). Identify chatter removable BY DESIGN (self-clearing alarms, auto-resolvers) vs
  irreducible. The trend should fall as structural fixes land.
* **Drift markers.** High dup-verification volume; ceremonial messages a structural fix could
  eliminate; watchdog-fire spam.

### 12. `coordination-utilization` — built channels actually used

* **Model.** Coordination surfaces that exist are USED: turn-end observation emission (enforced,
  not merely prompt-driven), Scout reading coord at cycle-start, the grade-to-lens-weight
  learning loop actually moving weights.
* **Method.** For each built mechanism, check live USAGE: is turn-end observation emission
  actually happening (or unenforced and under-used)? Does Scout use coord at all? Is
  grade-to-lens-weight learning live (`scout_lens_weights` off uniform 0.25, `decided` greater
  than 0) or dead?
* **Drift markers.** A built mechanism with near-zero usage (Scout uses no coord;
  grade-to-lens-weight dead with `decided = 0` + uniform weights; unenforced emission
  under-used).

### 13. `tool-utilization` — available tools reached for when apt

* **Model.** Tools that exist are reached for when apt: `scout:grade-idea` used regularly, the
  queen-scout coord+wake channel used, the `mcp-call.mjs` fallback wired into the bee path.
* **Method.** Check usage counts + recency for key tools (`scout:grade-idea` grade count + last
  use; the queen-scout channel; the bee curl-fallback). A tool with near-zero lifetime use that
  SHOULD be hot is a gap.
* **Drift markers.** A capability built but barely invoked (8 grades ever, none recent; an
  unused coord+wake channel); a fallback not wired into the path that needs it.

### 14. `scheduler-usage` — the within-hive scheduler used as designed

Added by `hybrid-bee-scheduler-work-stealing-2026-06-22` (P-004) once the deterministic
within-hive scheduler (per-bee claim SPECS + the `get_next` pull path) shipped. The point is
to continuously verify the scheduler is USED, not merely built.

* **Model.** The Queen authors + VERSIONS a per-bee claim SPEC (a scoped `view.filter` + `rank`
  over the live work-item DAG, composed from the primitive vocabulary) and re-steers a running
  bee by bumping the spec `revision` — she does NOT micro-dispatch each item. Bees PULL their
  next item through `get_next` (global hard floors AND the spec filter, `ORDER BY` the spec rank,
  `FOR UPDATE SKIP LOCKED`) rather than self-scanning the raw frontier or hand-claiming.
  Resolution is deterministic, the plan-item dedup floor holds (ZERO duplicate-plan-item claims),
  and completions flow from pulled work. Model-routing (`model_fit` / per-model capability) is
  DESCOPED behind its own flag (plan D-010) — its absence is NOT a drift.
* **Method.** Walk the live claim path: are bee claims stamped with a spec `specId@revision`
  (`get_next` records provenance), and do revisions bump when the Queen re-steers? Are there
  claims that did NOT go through `get_next` (a self-scanned / hand-claimed item — the bypass)?
  Query for duplicate-plan-item claims (two non-terminal claims sharing a `source_plan_item_id` —
  the dedup floor failing). Check pulled items reach completion (claim → working → done) rather
  than zombie-holding. Signal is limited when no spec-driven hive is running (rate `unknown`).
  `model_fit` is neutral until its lane ships — do NOT flag its absence.
* **Drift markers.** Queen micro-dispatching item-by-item instead of issuing/versioning specs;
  bees bypassing the scheduler (self-prioritizing the raw frontier, hand-claiming) instead of
  pulling via `get_next`; non-deterministic or floor-violating resolution; duplicate-plan-item
  claims (dedup floor breached); pulled claims that never make progress (zombie holds). NOT a
  drift: `model_fit` being neutral (descoped). Low evidence (no spec-driven hive running) is
  `unknown`, not `broken`.

## How to grade (the observation shape)

An agent grading this rubric files a structured observation (via
`improvements:capture { lane: 'observation', observation: { ... } }`). The `ratings` shape
follows the P-001 accept schema (`rubric-driven-observations-2026-06-20` D-003) — a map keyed
by the criterion `key`, one entry per criterion assessed, evidence MANDATORY (capture rejects
an empty-evidence rating):

```jsonc
{
  "rubricRef": "hive-coordination-health",
  "ratings": {
    "end-to-end-flow":          { "rating": "degraded", "evidence": "scout 0 ideas/24h (transport-death) but bees completing WI-214 03:43; closure broken at the scout->plan hand-off" },
    "queen-workitem-selection": { "rating": "healthy",  "evidence": "held WI-263/268 (needs-design), left WI-231 (cursed), placed the 2 actionable bugs — matches what I'd pick" }
    // ... key = a rubric criterion `key`; rating = a value from that criterion's scale
  }
}
```

Rate only what the live evidence supports; an unobservable criterion is `unknown` with the
reason as evidence. Never invent a rating to fill the scorecard.

## See also

* `rubric-driven-observations-2026-06-20` — the plan (D-001 model, D-002 scope + owner #1, D-003 the schema contract).
* `hive-coordination-test-loop-2026-06-20` D-001 — the owner's original 13-question scorecard this rubric crystallizes.
* `rubrics:get { rubric_id: 'hive-coordination-health' }` — the structured rubric (criteria keys, rating scale, drift markers).
