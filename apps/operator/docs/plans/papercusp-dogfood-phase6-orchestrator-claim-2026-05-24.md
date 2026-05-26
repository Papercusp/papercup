---
title: Papercusp dogfood — Phase 6 (orchestrator distributed claim)
slug: papercusp-dogfood-phase6-orchestrator-claim-2026-05-24
created: 2026-05-24
updated: 2026-05-26
status: draft
---

# Papercusp dogfood — Phase 6 (orchestrator distributed claim)

## Now

**State:** **Phase 6 + P-038 end-to-end SHIPPED 2026-05-25.**

P-036/P-039a/P-037 substrate + production wiring + audit UI (prior commits — `ba1ba191`, submodule `66b18043`, `3adb7b86`).

**P-038 — manual "set active" full stack today (6 commits):**
- `a6f30883` substrate read side: harness_shared.feature_working_set table + Hyperbee projection + key-types entry + register-all wiring.
- `9f8d83d5` write helper (setActiveFeature/clearActiveFeature) + PG reader (loadWorkingSet) with writerPubkey + clobber-events integration. 14 tests.
- `0b6e4619` HTTP endpoints (GET membership + POST set-active/clear-active). 8 tests.
- `cf216aad` P-038b orchestrator eligibility: claim-feature endpoint refuses claims when a non-self contributor is in the working set.
- `d1d931dd` UI primitives: useWorkingSet hook + SetActiveButton (3-state: Start working / Working / Taken) + Client wrapper. 18 tests.
- `9b1607bd` FeatureList Queue column wiring (now 260px) — third button next to pull-to-queue.

P-038 verdict: COMPLETE for substrate + production wiring + UI. Acceptance map:
- P-038a (user-initiated working flip writes working_users) → ✅
- P-038b (orchestrator excludes any feature with non-empty working set) → ✅
- P-038c (race between user-active and orchestrator claim) → ✅ (Autobase merge order; claim-feature rejects on non-empty other-pubkey working set, eligible-self bypasses).

P-039b admin claim-attempt timeline UI shipped earlier today (`3adb7b86`).

Phase 6 is now COMPLETE.

**Next:** All Phase 6 tasks shipped. Remaining outstanding items live in other phases (Phase 9 deploy = user-driven; Phase 5a native verification = user-driven; P-047c new-column scope).

## Background

Phase 6 implements `## Phase 6 — Orchestrator distributed claim [M]` from v5 (~line 1254). The new distributed primitive is described in §0.6: append-claim → await-own-merge → check-first-in-order → fire-or-drop. No quiescence window, no central coordinator.

**Gate:** Phase 5a complete (Autobase primitive available).

## Phase tasks

### P-036 — `feature_claims` Autobase log structure [M]

v5 §0.6: append claim record `{kind: 'feature_claim', feature_id, claimer_pubkey, claimer_github_user_id, ts, schema_version}` to Autobase; await the local view to include it.

**Files:**
- `apps/operator/lib/orchestrator/feature-claim.ts` (new) — `claimFeature(feature_id): Promise<{won: boolean, claim_seq: number}>`.
- `apps/operator/lib/orchestrator/feature-claim.test.ts` — unit tests with mocked Autobase.

**Sub-acceptances:**
- **P-036a** — Single-writer case: append + await + first-in-order check → returns `won: true`.
- **P-036b** — Two-writer race (test simulates both peers appending within 50ms): exactly one returns `won: true`; the other returns `won: false`.
- **P-036c** — Claim record persists in `feature_claims` HYPERBEE table (from Phase 1a P-013).
- **P-036d** — Schema-version field per D-024.

### P-037 — Orchestrator integration [M]

v5: on feature pickup, call claim arbitration; on win, proceed; on loss, drop + retry on next feature.

**Files:** patch to the existing orchestrator (`apps/operator/lib/autoloop.ts` or wherever the harness orchestrator lives — locate first).

**Sub-acceptances:**
- **P-037a** — Orchestrator no longer picks features without calling `claimFeature` first.
- **P-037b** — On `won: false`, orchestrator drops the candidate and selects the next eligible feature within the same tick.
- **P-037c** — Latency: end-to-end claim + decision adds ≤300ms to the orchestrator's pickup path (within Phase 0 P-003 stability).
- **P-037d** — Backoff: if a feature is contested 3x in a row (lost claim three times), orchestrator stops trying it for 60s to avoid hot-spot.

### P-038 — Manual "set active" flow [S]

v5 §0.5: user flips queued feature to `working` directly via UI. Orchestrator respects (won't pick up actively-flipped).

**Files:** patch to features UI (Phase 8 P-047) + orchestrator's claim eligibility check.

**Sub-acceptances:**
- **P-038a** — User-initiated `working` flip writes `working_users` directly, bypassing orchestrator.
- **P-038b** — Orchestrator's eligibility check excludes any feature whose `working_users[]` is non-empty.
- **P-038c** — If the user-active and an orchestrator claim race (orchestrator submitted claim 10ms before user flipped manually), Autobase's merge order decides; the loser drops cleanly.

### P-039 — Claim audit [S]

v5: every claim attempt + outcome captured in LOCAL `claim_audit` for diagnostics.

**Files:**
- `apps/operator/lib/orchestrator/claim-audit.ts` — `recordClaimAttempt({feature_id, attempt_ts, outcome, latency_ms})`.
- Schema already exists from Phase 1a P-013 (`claim_audit` table in `ensure-schema-dogfood.ts`).
- Small admin UI surface (perhaps in `/admin/run` or similar) — claim-attempt timeline per harness for debugging contested features.

**Sub-acceptances:**
- **P-039a** — Every `claimFeature` call writes a `claim_audit` row.
- **P-039b** — Admin surface renders the last 50 attempts per harness with `won|lost` outcomes.

## Decisions

(None yet.)

## Named fallback rollout

If Phase 6's claim mechanism is unreliable in practice (high false-loss rate, Autobase divergence under contention), fall back to a designated-coordinator pattern: one peer per harness owns claim arbitration; others ask it. This is D-002's rejected alternative — only revisit if the Autobase approach measurably fails. Document a flip via a `papercusp:feature_flag` rather than code rewrite.

## Cross-references

- Index: `papercusp-dogfood-execution-plan-index-2026-05-24.md`.
- Master: v5 `## Phase 6`, `### §0.5 — Feature state machine`, `### §0.6 — Orchestrator distributed claim`, D-002.
- Prereq plans: `phase5a`.

## Open questions

### Q-1 — What's the Autobase merge-order tie-break exactly?

v5 §0.6 says "ordered deterministically by `(writer_pubkey, seq)`." Confirm against Autobase's actual API; spec the canonical pubkey comparison (bytewise lex).

### Q-2 — Should manual `working` flips also write to `feature_claims` log?

For audit consistency. Suggested yes — the log captures everything that takes a feature into `working`, regardless of orchestrator vs manual source.

## For the next agent (Phase 7)

Phase 7 (PR lifecycle) consumes:
- Features in `working` state (from Phase 6's claim).
- `completion_ref` schema from Phase 2.
- Two-channel binding for the trust list (Phase 1b P-075).

Phase 7 is L-sized — the largest UI + integration phase.
