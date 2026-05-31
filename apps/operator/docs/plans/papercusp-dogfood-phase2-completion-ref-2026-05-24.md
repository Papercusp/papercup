---
title: Papercusp dogfood — Phase 2 (`completion_ref` + status verification)
slug: papercusp-dogfood-phase2-completion-ref-2026-05-24
status: shipped
created: 2026-05-24
updated: 2026-05-30
owner: avi@storewolf.com
---

# Papercusp dogfood — Phase 2 (`completion_ref` + status verification)

## Now

**State:** ✅ **ALL ITEMS DONE.** P-014/P-015/P-016/P-017 all shipped. Phase 2 complete.

**Summary of shipped work:**
- P-014/P-015: migrations 080 (completion_ref, working_users, etc.)
- P-016: verifier daemon with backoff + toast (commits `4b950a07`, `aeb48d83`)
- P-017: `CompletionRefCard.tsx` + `GET /api/harness/:slug/features/:id` endpoint + 13 tests (commit `c4da3a20`). P-017d dropped (no escalation row).

**Next:** Phase 4 (single-engineer dogfood loop) or Phase 1b (OAuth + attestation). Phase 1b's attest.ts + keychain.ts are still types-only stubs — the design memos for binding-service and device-attestation-ux were accepted; the runtime implementations are the remaining work before dogfood kickoff.

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

### P-016 — Background verifier daemon [M] — ✅ DONE

v5 one-liner: *"Background verifier daemon. `git ls-remote` polling. Cache + divergence-warning surfacing."*

**Status:** ✅ DONE. `completion-ref-verifier.ts` shipped (`4b950a07` + backoff fix `aeb48d83`). Migration `082-completion-ref-verifier-columns.sql` landed `verified_done_at_remote_ts`, `verifier_last_error`, `verifier_last_checked_at`. Daemon wired at `instrumentation-node.ts:313`.

**Expansion.** A daemon that periodically polls every harness's canonical remote via `git ls-remote`, verifies each feature's `completion_ref.commit_sha` is reachable from the remote, and stamps a `verified_done_at_remote_ts` on the feature row. On divergence (the SHA is *gone* — force-push, reverted PR), writes `verifier_last_error = 'sha_not_found'` directly on the feature row. **The signal lives on the feature row, NOT in `harness_escalations`** — the escalations table is a per-(slug, phase) file-mirror and the wrong shape for a per-feature signal. P-017's UI reads `verifier_last_error` directly.

**Files (shipped):**
- `apps/operator/lib/harness/completion-ref-verifier.ts` — daemon module. Exports `startCompletionRefVerifier()` and `verifyHarnessFeatures(slug)`. Daemon tick uses `verifyHarnessFeaturesWithBackoff()` internally (backoff-aware); `verifyHarnessFeatures()` is the unfiltered on-demand path.
- `apps/operator/lib/harness/completion-ref-verifier.test.ts` — unit tests: `parseLsRemoteOutput`, `decideVerificationOutcome`, `BINDING_CACHE_TTL_MS`, `BindingServiceErrorThrowable`.
- `apps/operator/instrumentation-node.ts` — `startCompletionRefVerifier()` called at line 313.
- Migration `082-completion-ref-verifier-columns.sql` — `verified_done_at_remote_ts TIMESTAMPTZ`, `verifier_last_error TEXT`, `verifier_last_checked_at TIMESTAMPTZ`.

**Sub-acceptances:**
- **P-016a — Happy path verification.** Daemon picks up `pending_done` feature with `completion_ref`; `git ls-remote` finds SHA; stamps `verified_done_at_remote_ts = NOW()`, clears `verifier_last_error`. ✅
- **P-016b — Divergence detection.** SHA force-pushed away → `git ls-remote` returns empty → daemon writes `verifier_last_error = 'sha_not_found'` on the feature row. Feature remains `pending_done`; no harness_escalations row emitted (design departure from original spec — per-feature signal is the right shape). ✅
- **P-016c — Network unreachable.** Network error → exponential backoff (60s → 120s → 240s → cap 5min); `verifier_last_error` NOT poisoned on transient errors. After 5 consecutive errors: writes one `warning` toast to `toast_log` with feature context. ✅ (fixed `aeb48d83`)
- **P-016d — Cadence + scope.** 60s poll; coalesced to harnesses with ≥1 `pending_done` or recently-`shipped` (24h) feature. ✅
- **P-016e — On-demand re-check.** `verifyHarnessFeatures(slug)` exported; no backoff filter on on-demand path. Used by P-017c UI button. ✅

**Decision rule:** PASS.

---

### P-017 — UI surfacing of `completion_ref` + divergence [S] — ✅ DONE

v5 one-liner: *"Surface in PlanDetail / FeatureDetail UI: `completion_ref` + verification timestamp; warn on divergence."*

**Expansion.** The feature-detail UI (find the existing component in `apps/operator/app/harness/`) gains a small "Completion" section that shows the `completion_ref` fields plus the verification status with appropriate tier badge per §17 / D-030.

**Files:**
- `apps/operator/app/harness/FeatureDetail.tsx` (or wherever the feature-detail panel lives — locate first) — add a `Completion` section conditionally rendered when `feature.status ∈ {'pending_done', 'shipped', 'failing'}`.
- `apps/operator/app/harness/CompletionRefCard.tsx` (new) — the visual rendering. Three states:
  - **Verified** (✓ tier-B): "Merged at `<commit_sha[:8]>` on `<branch>` — verified `<relative-time>`". Tier-B badge per §17.
  - **Unverified-pending** (unmarked tier-C): "Merged at `<commit_sha[:8]>` on `<branch>` — verifying…" with a small spinner. Tier-C until P-016 stamps `verified_done_at_remote_ts`.
  - **Divergent** (⚠ warning): "The recorded commit `<commit_sha[:8]>` is no longer present on `<remote>`. The PR may have been force-pushed or reverted." Plus a "Re-check" button (P-017c) to verify again once resolved.

**Sub-acceptances:**
- **P-017a — Card renders for each of the three states.** Render tests in `apps/operator/app/harness/__tests__/CompletionRefCard.test.tsx`.
- **P-017b — Tier badges per §17.** Verified state uses the tier-B ✓; pending state is unmarked tier-C; divergent state uses the ⚠ pattern from existing escalation surfaces. Mock the trust-tier helper from §17 if it doesn't exist yet (it will in P-073 / Insights work) — encapsulate as `getTrustTierBadge(tier: 'A' | 'B' | 'C' | 'D' | 'warning')` to swap in the real helper later.
- **P-017c — Force re-check button on divergent state.** Calls `verifyHarnessFeatures(slug)` from P-016e; shows a brief loading state; updates the card based on the new verification result. Useful when the divergence was transient (network issue) and the user wants to confirm.
- **P-017d — ~~Escalations-panel link~~ (DROPPED).** Original spec said "deep-link to the escalation row P-016 emitted." P-016's implementation departed from the spec: divergence signal lives on the feature row (`verifier_last_error`), NOT in `harness_escalations`. There is no escalation row to deep-link. The Re-check button (P-017c) covers the user's action need.

**Decision rule:** P-017 passes when P-017a-c pass.

## Decisions

(No execution-time decisions yet.)


### D-001 — completion_ref writer belongs in prs.ts reviewPr, gated on a feature_id-linkage gap (P-016 follow-up)
Date: 2026-05-30
Audit + investigation (2026-05-30) pinned down WHY `completion_ref` is never written and where the writer must go. Recorded so the next pass implements it correctly (an attempt this session targeted the wrong file and was reverted).

**Where the writer goes:** NOT `pr-host/poll-daemon.ts` — that daemon only lists OPEN PRs and has zero production callers (dead code). The real merge happens in `apps/operator/lib/endpoint-route/routes/harness/prs.ts` `reviewPr` (the `approve_and_merge` action → `tryAutoMerge`, ~line 207). `tryAutoMerge` returns `{ action:'merged', mergeCommitSha, prNumber }`; `remote` is already in scope (prs.ts:164); the PR runtime object is the flat shape (`base_branch`, `html_url`, `number`).

**The blocker (feature_id linkage):** `harness_features_consolidated` PK is `(harness_slug, feature_id)`, but `reviewPr` has only `slug` + PR `number` — NOT `feature_id`. The PR→feature map is `harness_shared.harness_feature_prs` (keyed by pr_url, NO pr_number column), populated ONLY by the Hyperbee projection `sync/hyperbee/projections/prs.ts`, which is gated behind `PAPERCUSP_DOGFOOD_SUBSTRATE_ENABLE=1` (off by default) — so by default that table is empty and PR→feature can't be resolved. Fix: thread `feature_id` from the PrsTab POST body (the UI knows it; the route already takes `reviewer_github_id`/`reviewer_login` body fields), with a `harness_feature_prs` lookup-by-pr_url fallback. Stamp only when feature_id resolves; skip silently otherwise.

**The write (mirror the verifier's PG pattern, completion-ref-verifier.ts:262-297):**
`const { sql } = getOrgPg();` then
`UPDATE harness_shared.harness_features_consolidated SET completion_ref = ${JSON.stringify(buildCompletionRef({remote, branch: base_branch, commit_sha: mergeCommitSha.toLowerCase(), pr_url: html_url, pr_number}))}::jsonb, status = 'shipped', updated_ts = ${Date.now()} WHERE harness_slug = ${slug} AND feature_id = ${featureId} AND completion_ref IS NULL`.
Scope by (harness_slug, feature_id) only — NO workspace_id (that's only on harness_feature_prs). Guard against empty merge SHA (github.ts returns `?? ''` which would make buildCompletionRef throw). Idempotent via `completion_ref IS NULL`.

**Why status='shipped' is required:** the verifier's select (completion-ref-verifier.ts:250-259) is `completion_ref IS NOT NULL AND (status='pending_done' OR (status='shipped' AND updated_ts within 24h))`. So the stamp MUST also set status='shipped' + bump updated_ts, or the verifier never picks it up and the tier-B "shipped ✓" stat stays 0.

**Branch/SHA caveat:** recording (base_ref, merge_commit_sha) verifies via `git ls-remote refs/heads/<branch>` only until the base branch advances past the merge commit. Follow-up: teach the verifier to check ancestry (`git merge-base --is-ancestor`) rather than exact head for merged refs.

**Trigger caveat:** confirm the `sync_features_consolidated` trigger (001-shared.sql ~95-120) doesn't clobber a direct `status` write from a later per-harness feature mutation (low risk since 'shipped' is terminal, but verify).

Status: ✅ **WRITER LANDED 2026-05-31** (commit `5e3f9e0c5`). `apps/operator/lib/harness/completion-ref-writer.ts` exposes `resolveMergedPrFeatureId` (caller `feature_id` → `harness_feature_prs` lookup-by-pr_url → null) + `stampCompletionRefOnMerge` (stamps `completion_ref` + `status='shipped'` + fresh `updated_ts`, idempotent via `completion_ref IS NULL`, skips silently on no-feature/empty-SHA/invalid-ref), with 8 unit tests. Wired into `prs.ts` `reviewPr` on the `'merged'` branch of `tryAutoMerge`; the route body now accepts an optional `feature_id`.

**Default activation is still BLOCKED** — but NOT on UI threading as originally framed. The deeper blocker: the PR→feature linkage (`harness_feature_prs`) has **no model-independent producer**. Its only writer is the gated Hyperbee `prs` projection (`PAPERCUSP_DOGFOOD_SUBSTRATE_ENABLE=1`); `PrHost.openPr` has **zero callers** (Papercusp doesn't open PRs through that path yet); the pr-host poll-daemon is dead code. So with the substrate off, `harness_feature_prs` is empty, `resolveMergedPrFeatureId` returns null, and nothing is stamped. The `PrsTab` UI can't supply `feature_id` either — its `PrRowData` carries no feature linkage (the list endpoint can't resolve one without the same gated table). Closing the gap requires a PR-open-time linkage write **outside** the substrate (overlaps the deferred substrate/gate arc) — i.e. when Papercusp itself starts opening PRs for features via `PrHost.openPr`, write `(harness_slug, feature_id, pr_url)` into `harness_feature_prs` there. Until then the writer is correct + dormant.
Related: P-016

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

### Q-3 — UI for the escalation row when the daemon emits one? — ✅ RESOLVED

**Resolution:** P-016 does NOT emit a `harness_escalations` row. The divergence signal (`verifier_last_error = 'sha_not_found'`) lives on the feature row itself. This was an intentional design departure — `harness_escalations` is per-(slug, phase) file-mirrored; per-feature signals need to live on `harness_features_consolidated`. P-017d dropped accordingly. The P-017 UI reads `verifier_last_error` directly from the feature row.

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
