---
title: Papercusp dogfood — Phase 4 (single-engineer dogfood — papercup as state:private)
slug: papercusp-dogfood-phase4-single-engineer-dogfood-2026-05-24
status: draft
created: 2026-05-24
updated: 2026-05-26
owner: avi@storewolf.com
---

# Papercusp dogfood — Phase 4 (single-engineer dogfood on papercup)

## Now

**State:** **P-024 + P-025 DONE. P-026 BLOCKED on operator registry-substrate drift (P-027 observation #1).**

First P-026 attempt 2026-05-26 surfaced this:
- `/api/admin/dogfood-substrate-status` shows 83 booted harnesses incl. `papercup-coding` + `papercup-org`, all healthy.
- `/api/harness/projects/lite` returns `{projects:[]}` for same operator.
- `/api/harness/papercup-coding/invoke?role=director` → 404 `{"error":"unknown project"}`. Same for /launch, /features, /spec.

**Root cause:** substrate's `getBootedHarness` reads boot_history + Hyperbee state; `resolveProject(slug)` reads `harness_registry` per-workspace. Two have drifted: registry empty, substrate full. Either boot wiring landed today without backfilling harness_registry, OR the operator session is on a workspace where papercup was never registered (per insight `dogfood-bootstrap` it was `papercusp-workspace`, but booted entries report `workspaceId: default`).

**Fix paths (pick one before re-attempting P-026):**
1. Bounce hono-host so `register-papercup.ts` re-fires.
2. Manually INSERT into harness_registry.
3. Switch operator's active workspace to `papercusp-workspace`.

Cupboard live at https://cupboard.papercusp.com (P-051b shipped today) — separate path, not blocking P-026.

**Next:** Hydrate harness_registry via one of the 3 fix paths above, then re-run P-026 per the runbook (commit 6ff3db32).

## Background

Phase 4 implements `## Phase 4 — Single-engineer dogfood (papercup as state: private) [M]` from v5 (~line 1230). It is qualitatively different from Phases 0-3:

- Phases 0-3 are **substrate**. Their deliverable is "code works."
- Phase 4 is **organizational**. Its deliverable is "the team uses the substrate to do real work."

The difference matters because Phase 4 cannot be marked DONE by a passing test. It's DONE when the answer to "are you running papercup's queue through Papercusp?" is "yes, for two weeks now, without bypassing it."

**Gate:** Phase 4 depends on:
- Phase 0 `GATE: PASS` (substrate gate).
- Phase 1a's outstanding P-010/P-012 done **enough to create new private harnesses through the picker** — strictly speaking Phase 4 doesn't need the picker since P-024 used the boot-path-bootstrap helper, but the picker is needed for *future* private harnesses the team may add during dogfood (e.g. for a different repo to compare).
- Phase 2 P-016 + P-017 done — **mandatory**, because the dogfood loop's first feature flow needs `completion_ref` verification to confirm "is this PR actually merged?"
- Phase 3 reactivity work done — **mandatory**, because the UI needs to live-update as features move through the queue (in-tree work substantially covers this; verify e2e before starting Phase 4).

Phase 4 **does not** depend on Phases 1b, 5, 6, 7, 8 — none of the shared-collab features. The whole point of `state: private` for the dogfood-bootstrap harness is to exercise the substrate without the P2P/sharing layer.

## Phase tasks

### P-024 — Register papercup as a harness in `papercusp-workspace` [S] — ✅ DONE

v5 one-liner: *"Use Entry 3 to register the papercup repo as a harness in the new `papercusp-workspace`, `state: private`. No GitHub auth needed at this step."*

**Status:** ✅ DONE in commit `b53185ee`.
- Helper: `apps/operator/lib/harness/register-papercup.ts` — `detectPapercupRoot()` walker + `registerPapercupHarness()` idempotent registration.
- Boot wiring: `apps/operator/instrumentation-node.ts` registers on every operator boot.
- Surgical workspace targeting: uses optional `workspaceId` param on `saveHarnessRegistry` to write into `papercusp-workspace` without disturbing the user's active session.
- Verified: PG `harness_registry` has the papercup row in `papercusp-workspace`.
- Tests: 5/5 detector unit tests pass.
- Insight: `/internal/docs/agent-insights/dogfood-bootstrap`.

**Decision rule:** PASS.

---

### P-025 — Seed initial features into the harness queue [S] — ✅ DONE

v5 one-liner: *"Seed initial features into the harness queue. Reuse existing feature-CRUD tools."*

**Expansion.** Pick three real, in-scope features for the next sprint and file them into the papercup harness's queue using the existing operator UI or `features:create` MCP tool. This is **not a code task** — it's the first behavioral commitment. The features chosen should be ones the team would actually do this week regardless of whether they used Papercusp; that way the dogfood doesn't add work, it just changes how work is tracked.

**Files:**
- None new. Uses existing feature CRUD (operator UI at `/harness/papercup/features` or MCP `features:create`).

**Sub-acceptances:**
- **P-025a — Three features filed.** Each carries: a clear title, acceptance criteria (1-3 bullets), and `created_by_github_user_id` populated (P-015 added the column; verify the seed flow populates it). Visible in the operator UI under the papercup harness.
- **P-025b — At least one feature is the dogfood-feedback feature itself.** Title suggestion: `F-DOGFOOD-001 — Phase 4 dogfood loop: capture observations`. Acceptance: at the end of Phase 4, this feature has accumulated a list of observations in its description / comments that became Phase 5+ scope items. This is the formal pain-capture surface (per Q-2 below + the "for next agent" handoff).
- **P-025c — Features survive an operator restart.** Boot the desktop, see the features still there, in the right harness, in queue. Confirms PG persistence + the registry's papercup-workspace pointer is durable.

**Decision rule:** PASS when P-025a-c all done. Should take <30 min wall-clock.

---

### P-026 — Run a feature end-to-end on papercup [M] — 🔴 NOT STARTED

v5 one-liner: *"Run a feature end-to-end on papercup: orchestrator picks → worker run → PR opened → manual review → merge → `shipped`. Verify `completion_ref` populates and status reaches `shipped`."*

**Expansion.** Pick ONE of the three seeded features and run it through the full Papercusp loop. This is the first proof that the substrate works for real work.

**Sub-acceptances:**
- **P-026a — Orchestrator picks the feature.** Within 5 min of the feature being filed (or after the user explicitly nudges via the UI), the orchestrator claims the feature and a worker run starts. Visible in the operator UI's lanes / Now-running panel.
- **P-026b — Worker run completes.** The worker produces a real diff against the papercup repo. The diff is reviewable in the harness's PR-precursor UI (or directly via `git diff` on the worker's branch — confirm which path is live).
- **P-026c — PR opens.** Either automatically (if Phase 7 PR lifecycle has shipped) or manually (push the branch + `gh pr create`). Either is acceptable for Phase 4; Phase 7 is the path that automates this.
- **P-026d — Manual review + merge happens on GitHub.** The user reviews the PR, requests changes if needed, ultimately merges to main.
- **P-026e — `completion_ref` populates.** Within 60s of the GitHub merge, the feature row's `completion_ref` is stamped with `{remote, branch, commit_sha, pr_url}`. Phase 2's P-016 verifier daemon then sets `verified_done_at_remote_ts`. The feature status flips to `shipped`. P-017's UI shows the tier-B ✓ badge.
- **P-026f — End-to-end wall-clock recorded.** From "I file the feature" to "feature is shipped with verified completion_ref," what's the total time? Capture as a data point — it's the baseline for whether the substrate's overhead is tolerable.

**Decision rule:** PASS when P-026a-e all happen. P-026f is a measurement, not a pass/fail.

**Likely friction points** (P-026 will surface these):
- Orchestrator pick latency or failure modes.
- Worker prompt quality on a real codebase vs. test harnesses.
- PR-open automation if Phase 7 isn't done — the manual fallback is fine but worth noting.
- `completion_ref` stamping path — is it the worker that writes it, or the merge-detector? Confirm and document in P-026e's implementation.

---

### P-027 — Observe scale + capture pain [S] — 🔴 NOT STARTED

v5 one-liner: *"Observe scale: existing UI on papercup's 175+ tables, 50+ existing features. Capture pain points as follow-up items."*

**Expansion.** With papercup registered as a harness, the operator's existing UIs (features list, lanes, agent runs, etc.) now have to render real volumes — 175+ DB tables, 50+ existing features (from years of papercup development), 100+ historical agent runs. This is the first time the UIs face this scale. Note everything that's slow, wrong, or surprising.

**Sub-acceptances:**
- **P-027a — Performance baseline.** For each major harness UI surface (features list, lanes, agent runs, dashboard, escalations), record: first-render time, scroll smoothness, time-to-interactive. Compare against the empty-harness baseline. Anything >2x slower is a candidate Phase 5+ task.
- **P-027b — Correctness audit.** Browse every tab. Anything that renders empty when it should have data, anything that paginates badly, anything that errors silently — write it down. Each item lands in the `F-DOGFOOD-001` feature's observations list (from P-025b).
- **P-027c — Boot-time impact.** With papercup registered, how much longer does the operator take to boot? `instrumentation-node.ts` now runs the papercup registration on every start — confirm it's still idempotent-fast (target <500ms added boot time). If not, defer registration to first UI nav.

**Decision rule:** P-027 always PASSES — it's an observation phase, not a gate. The output is the list of follow-ups.

---

### P-028 — Decision gate: pain → fix, otherwise → proceed [S] — 🔴 NOT STARTED

v5 one-liner: *"Decision gate: if Phase 4 surfaces blocker-level pain, fix before Phase 5; otherwise proceed."*

**Expansion.** A formal decision recorded at the end of Phase 4. The blocker bar is high — slow UI is not a blocker, but "the orchestrator pick path is unreliable" is. The decision lands in this plan's `## Decisions` section as `D-001`.

**Sub-acceptances:**
- **P-028a — Gate verdict recorded.** Either `GATE: PROCEED → Phase 5a` or `GATE: PAUSE → fix the following blockers before Phase 5a`. The pause variant lists each blocker with a proposed fix path (own task, sub-plan, or scope adjustment to a later phase).
- **P-028b — Observations triaged.** The list from P-027 gets categorized: `must-fix-now` (blocks Phase 5a), `track-as-Phase-12+-followup` (visible-but-tolerable), `wontfix` (acceptable as-is). The `F-DOGFOOD-001` feature's description gets updated with these categories.

**Decision rule:** Phase 4 is DONE when P-028a is recorded. The verdict determines whether Phase 5a starts next or whether a fix arc fires first.

---

## Decisions

(Recorded at P-028 time. None yet.)

## Named fallback rollout

Phase 4 has no substrate-class fallback (substrate is gated by Phase 0). The closest failure mode is "the dogfood loop is so painful that the team stops using it." Mitigation:

- The pause-gate in P-028 is the formal fix point. If the loop is unusable, pause; don't paper over.
- If `GATE: PAUSE` fires twice (after a fix arc), revisit the Phase 4 scope itself — maybe `state: private` is the wrong starting point and the team needs a smaller seed (a one-task feature, a non-papercup repo with simpler structure, etc.). Don't grind on the same gate.

No formal fallback rollout section needed.

## Cross-references

- **`papercusp-dogfood-execution-plan-index-2026-05-24.md`** — navigation across all phase plans.
- **`papercusp-dogfood-v5-2026-05-23.md`** — parent plan. `## Phase 4` (~line 1230); `### §0.5 — Feature state machine`; `### §15 — completion_ref + trust model`.
- **`papercusp-dogfood-phase2-completion-ref-2026-05-24.md`** — P-016 + P-017 are direct prerequisites; P-026e tests them in real use.
- **`papercusp-dogfood-phase1a-workspace-ui-shell-2026-05-24.md`** — its `## For the next agent` section already calls out that Phase 4 starts as soon as 1a/2/3 ship.
- **`/internal/docs/agent-insights/dogfood-bootstrap`** — the insight from P-024 explaining the workspace-targeted registration pattern.
- **D-005** in v5 — establishes Phase 4 uses `state: private` with no user-branch, no Hyperbee, no peer-mirror. **Honor this strictly** in implementation; don't be tempted to "just turn on Hyperbee for free."

## Open questions

### Q-1 — Who is "the team" for single-engineer dogfood?

v5 names Phase 4 "single-engineer" but the user is solo here. So "the team" = avi alone. That's fine — the deliverable is still that papercup's queue runs through Papercusp daily. Just be honest about it in the dogfood signal: P-028's gate isn't gated on multi-engineer use; that's Phase 11.

### Q-2 — How are pain observations captured, structurally?

P-027 says "capture as follow-up items" but doesn't specify where. Suggested mechanism (Q-2 resolution candidate):
- Each observation becomes a comment on the `F-DOGFOOD-001` feature (from P-025b).
- At P-028 time, observations are bulk-triaged + the survivors become individual feature rows in the queue, tagged `kind: dogfood-followup`.
- The Phase 4 plan-doc's `## Decisions` records the triage summary (counts, not individual items).

If a richer pain-capture surface exists in the operator UI (an "observations" panel), use that instead. Audit before P-027 starts.

### Q-3 — What's the success threshold for the "loop works" verdict?

Suggested: PROCEED if at least 1 feature reaches `shipped` end-to-end without manual rescue (no `git push` from the user that wasn't initiated by Papercusp; no `gh pr create` from the user; no manual `completion_ref` writes). Otherwise PAUSE.

Decide before P-026 starts. The threshold matters because it shapes how much the user lets the system fail before intervening — too strict and PROCEED never fires; too loose and PROCEED fires while the substrate's still broken.

## For the next agent (Phase 5a or fix arc)

If P-028 verdict is `GATE: PROCEED`:
- Phase 5a (Hyperbee plumbing) starts. Its execution plan exists at `papercusp-dogfood-phase5a-hyperbee-plumbing-2026-05-24.md` (or write it then). Phase 5a depends on Phase 1b being done too — coordinate; if 1b is still in flight, Phase 5a can read-prepare but not implement.
- Phase 4 stays "open" in the sense that the dogfood loop keeps running. The team doesn't stop using papercup-as-harness when Phase 5 starts; the harness migrates from `state: private` to `state: shared-private` via the §5 wizard (Phase 5a P-029) when the team is ready.

If P-028 verdict is `GATE: PAUSE`:
- Write a sub-plan for the named blockers. Don't dump them into Phase 5a as side-quests.
- The dogfood loop continues running through the fix arc (don't pause real work to fix Papercusp; that defeats the purpose). The fix arc may extend Phase 4 by 1-2 weeks before Phase 5a starts.

Either way, the `F-DOGFOOD-001` observations feature stays in the queue indefinitely as a long-running pain-capture surface. New observations from Phase 5+ also land there until the harness goes shared and the team uses comments on individual features instead.
