---
title: Papercusp dogfood — Phase 11 (multi-engineer dogfood)
slug: papercusp-dogfood-phase11-multi-engineer-dogfood-2026-05-24
status: superseded
created: 2026-05-24
updated: 2026-05-30
owner: avi@storewolf.com
---

# Papercusp dogfood — Phase 11 (multi-engineer dogfood)

## Now

**State:** **draft execution plan.** Phase 11 is the **final dogfood phase** — the moment the team commits to running papercup's queue through a *shared* Papercusp harness with multiple engineers. Like Phase 4, the deliverable is organizational, not just code: the multi-engineer flow must run end-to-end for two weeks before Phase 11 is DONE.

**Next action:** confirm a second engineer is committed to the dogfood loop (real or simulated via a second machine + GitHub account). Without two engineers actively participating, Phase 11 can't be tested.

## Background

Phase 11 implements `## Phase 11 — Multi-engineer dogfood [L]` from v5 (~line 1290). It's the capstone of the entire dogfood arc.

**Gate:** All of Phases 5a, 5b, 6, 7, 8, 9 complete. A shared-private harness must work end-to-end before multi-engineer use is attempted.

## Phase tasks

### P-061 — Paired feature flow [M]

v5: A files feature, B picks up via §9.1 queue, B works, B opens PR, A reviews on GitHub, B's auto-merge fires.

**Files:** none — pure behavioral test against the substrate.

**Sub-acceptances:**
- **P-061a** — A files a feature; B sees it within sub-second per §6 Hyperbee sync.
- **P-061b** — B pulls into queue; A's UI shows B's avatar on the feature row (§9.1 P-032).
- **P-061c** — Orchestrator picks for B (or B manually flips to working); A sees `working_users: [B]` live.
- **P-061d** — B's worker run produces commits + push to `user/<B_id>`; A sees Bob's branch update (via Phase 10 peer-mirror if enabled, else next manual `git fetch`).
- **P-061e** — B opens PR; A's PRs tab (Phase 7 P-043) shows it within 60s (poll cadence).
- **P-061f** — A reviews on GitHub; the review comes back to A's auto-approve trust-list check if A has trust-on; otherwise manual approval.
- **P-061g** — B's auto-merge fires (if enabled) on green checks; feature flips to `shipped` with `completion_ref` verified (Phase 2 P-016).
- **P-061h** — A's Insights "Activity feed" (Phase 8 P-073) shows the shipped event with B as the contributor, ✓ tier-B badge.

### P-062 — Stress test [S]

v5: 3+ engineers, 10+ features in flight simultaneously. Measure HYPERBEE convergence + UI invalidation latency end-to-end.

**Files:** `scripts/stress-test-multi-engineer.ts` (new) — simulator that drives feature CRUD + PR ops from N machines.

**Sub-acceptances:**
- **P-062a** — 3 simulated engineers + 10 features survive 1hr of concurrent operation without divergence, hung-state, or LWW clobbering at unacceptable rates.
- **P-062b** — HYPERBEE convergence latency p95 < 500ms (matches Phase 0 P-003 benchmark at this scale).
- **P-062c** — UI invalidation latency p95 < 1s (from PG trigger to UI render via SSE).
- **P-062d** — `feature_claims` arbitration produces 0 false-double-firings (orchestrator never fires two workers for the same feature).

### P-063 — Capture issues from multi-engineer dogfood [M]

v5: as Phase-12+ follow-up plans.

**Files:** pain-capture lives on the `F-DOGFOOD-001` feature from Phase 4 P-025b, plus a new `F-DOGFOOD-002` "Multi-engineer dogfood observations" feature filed at start of Phase 11.

**Sub-acceptances:**
- **P-063a** — `F-DOGFOOD-002` filed at start of Phase 11 as the observation-capture surface.
- **P-063b** — Every issue surfaced during the 2-week dogfood window gets a comment with reproduction context.
- **P-063c** — At end of Phase 11, observations triaged into: `Phase-12+-feature-rows` (most), `wontfix-document-only` (some), `must-fix-now` (rare). Categories written to F-DOGFOOD-002's description.

### P-064 — Contributor onboarding guide [S]

v5: "how to join a Papercusp harness" doc, lives in `apps/operator-docs/`.

**Files:**
- `apps/operator-docs/src/content/docs/contributing/joining-a-shared-harness.mdx` (new — confirm path against current Astro structure).

**Sub-acceptances:**
- **P-064a** — Step-by-step doc covering: install desktop → paste harness link → OAuth → device attestation → first feature pickup → first PR.
- **P-064b** — Screenshots from the post-Phase-8 UI.
- **P-064c** — Troubleshooting section: common errors from `clone-github.ts`, OAuth scope misses, branch-push permission gaps.

### P-065 — Cupboard publish [S]

v5: list the papercup harness as a canonical dogfood example.

**Sub-acceptances:**
- **P-065a** — papercup harness flipped from `shared-private` to `shared-public` via Phase 9 P-053.
- **P-065b** — Listing visible in Cupboard with tier-A stats populated (Phase 9 P-076).
- **P-065c** — A test "join" from a fresh-install Papercusp on a different machine succeeds end-to-end.

## Decisions

### D-001 — Phase 11 verdict

Recorded at end of Phase 11. Either:
- **PASS** — multi-engineer dogfood loop has run for 2 weeks with team using it as primary work surface (not bypassed). Arc COMPLETE.
- **PAUSE + fix** — specific blockers documented; fix arc fires; re-test Phase 11.
- **REGRESS** — revert to single-engineer dogfood (Phase 4 verdict) + re-scope shared-harness ambitions.

## Named fallback rollout

If Phase 11 hits PAUSE + fix more than twice, evaluate whether the architecture is correct. Possible deeper rethinks:
- Maybe Hyperbee LWW is too lossy at this team size; reconsider per-field CRDT vs LWW.
- Maybe the substrate is right but UX needs more pain-mitigation (better conflict warnings, more pre-action validation, etc.).
- Maybe shared-harness scope was too ambitious for v1 and should ship in narrower slices.

These are conversations, not concrete rollouts. Document in this plan's `## Decisions` as they happen.

## Cross-references

- Index: `papercusp-dogfood-execution-plan-index-2026-05-24.md`.
- Master: v5 `## Phase 11`, `### §0.5-0.6`, `### §6 — Hybrid sync model`.
- Prereq plans: all of `phase5a`, `phase5b`, `phase6`, `phase7`, `phase8`, `phase9`. Phase 10 optional.
- Parent dogfood plan: Phase 4 set the pattern for "real-use phase with success criteria + pain capture."

## Open questions

### Q-1 — Who is the second engineer?

If the dogfood team is solo (avi alone), Phase 11 needs either a second human or a simulated second machine + GitHub account. Decide before P-061 begins.

### Q-2 — Two-week threshold — is that the right duration?

Long enough to surface non-obvious issues; short enough that the team commits. Adjustable. The discipline is "no bypass for the duration," not the duration itself.

### Q-3 — What does "Arc COMPLETE" mean operationally?

Suggested: the dogfood plans cohort (v5 + carve-outs + Phase 0-11 execution plans) moves to `archive/`; the per-phase status fields are frozen; future Papercusp development uses the same patterns but in new plan files.

## For the next agent

There is no "next phase" after 11. If Arc COMPLETE: next work is whatever the team picks up using Papercusp as the substrate, with the deferred work (proxy-witness, plans-harness-scoped) being the natural follow-ups.

If Arc PAUSE: the fix arc gets its own sub-plan; new execution plans get written for each fix scope.

The substrate gained: a Papercusp instance that runs Papercusp's own development queue. The dogfood signal becomes continuous from this point on, not phase-bound.
