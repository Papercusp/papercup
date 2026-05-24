---
title: Papercusp dogfood — Phase 2 (`completion_ref` + status verification)
slug: papercusp-dogfood-phase2-completion-ref-2026-05-24
status: draft
created: 2026-05-24
updated: 2026-05-24
owner: avi@storewolf.com
---

# Papercusp dogfood — Phase 2 (`completion_ref` + status verification)

## Now

**State:** **draft execution plan**, third in the per-phase cohort after Phase 0 (spike gate) and Phase 1a (workspace + UI shell). Phase 2 status as of 2026-05-24 (overnight loop): **P-014 + P-015 done in-tree** (migration `080-harness-features-dogfood-columns.sql`); **P-016 verifier daemon SHIPPED** in commit `4b950a07` (parent) + `ad029f5` (libs/papercusp submodule, migration `082-completion-ref-verifier-columns.sql`). Remaining: **P-017 (UI surfacing of `completion_ref` + divergence warnings)**.

**Next:** Implement P-017 — locate the FeatureDetail surface in `apps/operator/app/harness/`, build `CompletionRefCard.tsx` for the verified / pending / divergent states. UI work — coordinate with paperclip (paperclip's edit zone is `apps/operator/app/admin/harness/*`; check first whether the FeatureDetail surface is admin or non-admin).

## Background

This execution plan implements `## Phase 2 — completion_ref + status verification [M]` from v5 (~line 1213). Phase 2 is the **tier-B verification anchor** that the trust-tier framework (§17, D-030) depends on. Without Phase 2, the "features shipped ✓" stat on the Insights page and Contributors tab is just tier-C self-assertion: a peer can claim "I shipped F-042" by writing `status='shipped'` to Hyperbee, and no one can re-derive the truth. Phase 2 closes that hole: the merge commit SHA + remote + branch get stamped onto the feature row as `completion_ref`, and a background poll verifies the SHA exists at the canonical remote.

Phase 2 runs **in parallel with Phase 1b** (per the Phase 1a handoff doc). The two phases don't touch the same files — Phase 1b is OAuth + clone + attestation, Phase 2 is the feature-row verifier — so parallelism is safe and cuts the critical path to dogfood-loop kickoff by ~M.

**Gate:** Phase 2 depends on Phase 0 passing (substrate gate). It does not depend on Phase 1a or Phase 1b — the verifier daemon polls remotes that already exist in `harness_features_consolidated`, no UI needed.

## Phase tasks

### P-014 — Schema add `completion_ref JSONB` [S] — ✅ DONE

v5 one-liner: *"Schema add `completion_ref JSONB` to `harness_features_consolidated` (SQL migration since the base table is in `001-shared.sql`)."*

**Status:** ✅ DONE in migration `080-harness-features-dogfood-columns.sql` (libs/papercusp submodule pointer at commit `2d9439ea`). Verified live against PG.

**Decision rule:** PASS.

---

### P-015 — Schema additions for working state + history [M] — ✅ DONE

v5 one-liner: *"Schema additions to `harness_features_consolidated` per §7.1 (`created_by_github_user_id`, `working_users[]`, `worked_by_history`). **Explicitly NOT adding** issue-equivalent columns to `harness_issues_consolidated` (D-017)."*

**Status:** ✅ DONE in migration 080 alongside P-014. Added: `created_by_github_user_id BIGINT`, `working_users BIGINT[] NOT NULL DEFAULT '{}'`, `worked_by_history JSONB NOT NULL DEFAULT '[]'::jsonb`. Indexes: `hfc_working_users_active_idx`, `hfc_created_by_idx`, `hfc_pending_done_idx`. D-017 honored: `harness_issues_consolidated` untouched.

**Decision rule:** PASS.

---

### P-016 — Background verifier daemon [M] — 🔴 NOT STARTED

v5 one-liner: *"Background verifier daemon. `git ls-remote` polling. Cache + divergence-warning surfacing."*

**Expansion.** A daemon that periodically polls every harness's canonical remote via `git ls-remote`, verifies each feature's `completion_ref.commit_sha` is reachable from the remote's `main` (or whatever the harness's main branch is), and stamps a `done_at_remote_ts` on the feature row. On divergence (the SHA is *gone* from the remote — force-push, reverted PR, etc.), emit an escalation.

**Files:**
- `apps/operator/lib/harness/completion-ref-verifier.ts` (new) — main daemon module. Exports `startCompletionRefVerifier({ pollIntervalMs }: { pollIntervalMs?: number })` and `verifyHarnessFeatures(slug: string): Promise<VerificationResult>`. The factored `verifyHarnessFeatures` is callable on-demand (from a UI "force re-check" button if needed); the daemon is just a polling wrapper.
- `apps/operator/lib/harness/completion-ref-verifier.test.ts` (new) — unit tests covering: SHA found on remote → stamps `done_at_remote_ts`; SHA missing → emits divergence escalation; remote unreachable (network down) → retry with backoff, no false-positive escalation; rate-limit handling (use `git ls-remote` against the local clone's already-configured remote, NOT GitHub API, so no rate-limit issue).
- `apps/operator/instrumentation-node.ts` — wire `startCompletionRefVerifier()` into the boot sequence after `ensurePapercuspWorkspace()`.
- `apps/operator/lib/ensure-schema-dogfood.ts` — confirm a column exists on `harness_features_consolidated` to hold the verification timestamp; if not, add `verified_done_at_remote_ts TIMESTAMPTZ` and `verifier_last_error TEXT` via the same migration-extension pattern. (Sanity-check the existing migration 080 — these columns may already be there from the schema work.)

**Sub-acceptances:**
- **P-016a — Happy path verification.** Daemon picks up a feature in `status='pending_done'` with a `completion_ref`; runs `git ls-remote origin <commit_sha>`; SHA is found; stamps `verified_done_at_remote_ts = now()`. UI consumers (P-017) can show ✓.
- **P-016b — Divergence detection.** Same feature, but the SHA has been force-pushed away from the remote (or the branch was deleted). `git ls-remote` returns empty for the SHA → daemon writes `verifier_last_error = 'sha_not_found'` and emits a `harness_escalations` row with `kind: 'completion_ref_divergence'`. Feature remains in `pending_done`; flips to `failing` only after the user acknowledges the escalation (don't silently revert status).
- **P-016c — Network unreachable.** `git ls-remote` fails with a timeout or DNS error → daemon backs off (exponential, max 5 min) and retries. No `verified_done_at_remote_ts` is stamped; no false-positive escalation. After 5 retries with no success, surface a quiet info-toast ("Verifier can't reach origin — retrying in background").
- **P-016d — Cadence + scope.** Poll every harness with ≥1 `pending_done` or recently-`shipped` (within 24h) feature, every 60s. Don't poll harnesses with no recent feature activity (cheap heuristic to keep network traffic down). Daemon uses the same coalesce-by-harness pattern as the existing PR poll (P-042 spec).
- **P-016e — On-demand re-check.** `verifyHarnessFeatures(slug)` callable from the UI; returns within 5s for a harness with <50 features. Used by a "Re-check verification" button in the harness escalations UI (added in P-017).

**Decision rule:** P-016 passes when P-016a-d all pass. P-016e is part of P-017's UI work — split into that phase if scope-cutting is needed.

---

### P-017 — UI surfacing of `completion_ref` + divergence [S] — 🔴 NOT STARTED

v5 one-liner: *"Surface in PlanDetail / FeatureDetail UI: `completion_ref` + verification timestamp; warn on divergence."*

**Expansion.** The feature-detail UI (find the existing component in `apps/operator/app/harness/`) gains a small "Completion" section that shows the `completion_ref` fields plus the verification status with appropriate tier badge per §17 / D-030.

**Files:**
- `apps/operator/app/harness/FeatureDetail.tsx` (or wherever the feature-detail panel lives — locate first) — add a `Completion` section conditionally rendered when `feature.status ∈ {'pending_done', 'shipped', 'failing'}`.
- `apps/operator/app/harness/CompletionRefCard.tsx` (new) — the visual rendering. Three states:
  - **Verified** (✓ tier-B): "Merged at `<commit_sha[:8]>` on `<branch>` — verified `<relative-time>`". Tier-B badge per §17.
  - **Unverified-pending** (unmarked tier-C): "Merged at `<commit_sha[:8]>` on `<branch>` — verifying…" with a small spinner. Tier-C until P-016 stamps `verified_done_at_remote_ts`.
  - **Divergent** (⚠ warning): "The recorded commit `<commit_sha[:8]>` is no longer present on `<remote>`. The PR may have been force-pushed or reverted. Resolve via escalation panel."

**Sub-acceptances:**
- **P-017a — Card renders for each of the three states.** Render tests in `apps/operator/app/harness/__tests__/CompletionRefCard.test.tsx`.
- **P-017b — Tier badges per §17.** Verified state uses the tier-B ✓; pending state is unmarked tier-C; divergent state uses the ⚠ pattern from existing escalation surfaces. Mock the trust-tier helper from §17 if it doesn't exist yet (it will in P-073 / Insights work) — encapsulate as `getTrustTierBadge(tier: 'A' | 'B' | 'C' | 'D' | 'warning')` to swap in the real helper later.
- **P-017c — Force re-check button on divergent state.** Calls `verifyHarnessFeatures(slug)` from P-016e; shows a brief loading state; updates the card based on the new verification result. Useful when the divergence was transient (network issue) and the user wants to confirm.
- **P-017d — Escalations-panel link on divergent state.** "Resolve via escalation panel" deep-links to the escalation row P-016 emitted.

**Decision rule:** P-017 passes when P-017a-c pass. P-017d is nice-to-have; can ship as a follow-up.

## Decisions

(No execution-time decisions yet.)

## Named fallback rollout

Phase 2 has no substrate-class failure mode. The closest failure is "the `git ls-remote` poll is too expensive at scale" (e.g. 100 active harnesses each polling every 60s). Mitigation:

- The poll cadence is configurable per harness (default 60s). If load becomes a concern, raise to 5min and surface "verification may take up to 5 minutes" in P-017's card copy.
- The poll uses `git ls-remote` against the harness's already-configured remote, which uses git's native SSH/HTTPS connection-pooling and doesn't hit GitHub's REST API. No rate-limit risk.

No formal named fallback section is needed.

## Cross-references

- **`papercusp-dogfood-v5-2026-05-23.md`** — parent plan. Specifically `## Phase 2` (~line 1213), `### §15 — completion_ref + trust model` (~line 919), `### §17 — Stat trust tiers` (~line 1105 — addendum 3).
- **`papercusp-dogfood-phase0-spike-2026-05-24.md`** — substrate gate. Must show `GATE: PASS` before P-016/P-017 implementation begins.
- **`papercusp-dogfood-phase1a-workspace-ui-shell-2026-05-24.md`** — runs in parallel; Phase 2 does not depend on it (verifier daemon doesn't need the new create-harness UI).
- **migration `080-harness-features-dogfood-columns.sql`** — landed P-014 + P-015; check this file when adding `verified_done_at_remote_ts` if needed for P-016.
- **D-030** (v5 addendum 3) — establishes that `completion_ref`-verified surfaces are tier-B ✓. P-017 directly implements the tier-B badge for the first surface (feature-detail).
- **P-042 (v5 Phase 7)** — the PR poll daemon, which P-016's coalesce-by-harness pattern should mirror. Coordinate the polling-budget shape across both phases when Phase 7's plan is written.

## Open questions

### Q-1 — Where exactly does the FeatureDetail component live?

I cited `apps/operator/app/harness/FeatureDetail.tsx` as a placeholder. The actual file may be named differently (e.g. inline in a parent component). Locate before implementing P-017. If the feature-detail surface doesn't exist as a discrete component yet, that's a small refactor on the critical path — flag in the implementation plan.

### Q-2 — Should the verifier daemon also poll `shipped` features (not just `pending_done`)?

A `shipped` feature's `completion_ref` could in principle become divergent if someone force-pushes main weeks later. Whether to keep polling is a tradeoff between catching late-divergences and not burning network on stable history. My lean: poll `shipped` features for 7 days, then stop (long-tail divergence is unlikely and an explicit "Re-check" button is available). Spec the 7-day cutoff in P-016d.

### Q-3 — UI for the escalation row when the daemon emits one?

P-016 emits a `harness_escalations` row with `kind: 'completion_ref_divergence'`. The existing escalations UI should pick this up — but does it have a dedicated UI for this `kind`, or does it fall through to a generic escalation card? Audit before P-017d (the deep-link target).

## For the next agent (Phase 3 or Phase 4)

Phase 2's deliverable (P-016 verifier + P-017 UI) unblocks two downstream items:

- **Phase 4's dogfood-loop kickoff.** Phase 4's first feature flow needs `completion_ref` to verify "is this PR actually merged?" — that's exactly what P-016 + P-017 deliver. Once Phase 2 ships, Phase 4 can start.
- **Phase 8's Insights tab (P-073).** The "Activity feed" card on Insights shows "features shipped ✓" as tier-B — that ✓ comes from `completion_ref`-verified status. Phase 8's UI work depends on P-017's tier-badge pattern being established.

What Phase 3 or Phase 4 should NOT carry forward from Phase 2:

- The verifier daemon is a singleton owned by the operator boot path. Don't spin up additional pollers for the same job from other phases.
- The `verified_done_at_remote_ts` column is the single source of truth for tier-B verification status. Other phases reading `harness_features_consolidated` should check this column, not re-implement verification logic.

Phase 3 (reactivity migration) is **already substantially done in-tree** (P-018, P-019 part 1 + 2 — see v5 §Phases). Its execution plan, if written, is small: P-021/P-022 (Zero retirement) + P-023 (already done) + P-067 (camelCase bridge). May be worth writing only if Phase 3 turns into a debug-heavy phase that benefits from the structured handoff. Otherwise the v5 phase entry is enough.

Phase 4 (single-engineer dogfood) is the **first real-use phase** and benefits from a worked execution plan because:
- It's the first phase where the team actively uses Papercusp.
- It defines the "what does the dogfood signal look like?" success criteria.
- It surfaces pain that becomes Phase 5+ scope.

My recommendation for whoever picks up next: skip Phase 3 execution plan (it's mostly done already, v5 entry suffices), write Phase 4 execution plan instead. Phase 4's plan should heavily emphasize **success criteria + pain capture** — what does it mean for the dogfood loop to be working? What does the team commit to using it for? How do issues found during dogfood get captured for Phase 5+?
