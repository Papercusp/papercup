---
title: Papercusp dogfood — Phase 7 (PR lifecycle)
slug: papercusp-dogfood-phase7-pr-lifecycle-2026-05-24
status: draft
created: 2026-05-24
updated: 2026-05-24
owner: avi@storewolf.com
---

# Papercusp dogfood — Phase 7 (PR lifecycle)

## Now

**State:** **draft execution plan.** Phase 7 owns the PR side of the shared-harness flow: PrHost abstraction, GitHub implementation via Octokit, PR poll daemon, auto-approve gated on trust, auto-merge gated on auto-approve + checks. L-sized; the most-touched-by-external-API phase.

**Next action:** install `@octokit/rest` as the first dep ever added under the new D-019 rule (gh-CLI for clone, octokit for PR APIs). Then P-040.

## Background

Phase 7 implements `## Phase 7 — PR lifecycle [L]` from v5 (~line 1260). All PR work flows through a `PrHost` interface — GitHub is the v1 implementation; GitLab/Gitea drop in later.

**Gate:** Phase 1b complete (OAuth + canonical binding); Phase 6 complete (orchestrator delivers features in `working` state to worker runs which produce branches to push).

## Phase tasks

### P-040 — PrHost abstraction + GitHub impl [M]

v5: `apps/operator/lib/pr-host/index.ts` interface + GitHub impl via `@octokit/rest`. Open PR, get PR, post review, merge, list-open-PRs (bulk per §8.4).

**Files:**
- `apps/operator/lib/pr-host/index.ts` — interface `PrHost` with `openPr`, `getPr`, `postReview`, `merge`, `listOpenPrs`.
- `apps/operator/lib/pr-host/github.ts` — implementation via Octokit; uses the OAuth token from `gh auth token` per D-019.
- `apps/operator/lib/pr-host/github.test.ts` — mocked Octokit happy paths + error mapping.

**Sub-acceptances:**
- **P-040a-e** — One per method: each returns structured results, maps GitHub errors to typed errors.

### P-041 — Auto-rebase-on-push [M]

v5 §16.3: before every agent push, `git fetch origin main && git rebase origin/main`; conflict → escalation.

**Files:**
- `apps/operator/lib/harness/auto-rebase.ts` (new).
- Wired into worker run's push step (locate in existing orchestrator code).

**Sub-acceptances:**
- **P-041a** — Clean rebase proceeds with push.
- **P-041b** — Conflict opens a `harness_escalations` row with stash-ref, conflicted-files list, and stashes WIP to `wip/conflict-F-<id>-<ts>` branch.
- **P-041c** — Feature status resets to `in_queue`, `working_users` cleared.
- **P-041d** — UI surface (§9.1 warning panel) shows the conflict + actions (resolve manually, re-queue, abandon).

### P-042 — PR poll daemon [M]

v5: 60s cadence per harness with ≥1 open PR; updates `harness_feature_prs` (HYPERBEE) + LOCAL `pr_check_status_cache`. Error handling per audit M.

**Files:**
- `apps/operator/lib/pr-host/poll-daemon.ts` (new).

**Sub-acceptances:**
- **P-042a** — Bulk `GET /repos/.../pulls?state=open&per_page=100` per harness per 60s.
- **P-042b** — Per-PR rows updated in `harness_feature_prs` HYPERBEE; check-run details cached LOCAL.
- **P-042c** — Exponential backoff on 5xx (max 5min).
- **P-042d** — Honors `X-RateLimit-Reset` header on 429.
- **P-042e** — OAuth-refresh on 401; alert user on 401-after-refresh.
- **P-042f** — 404 → mark PR as gone (deleted upstream); demote `completion_ref`.

### P-043 — PRs tab UI [M]

v5 §9.3.

**Files:** `apps/operator/app/harness/PrsTab.tsx` (new) + `PrRow.tsx`.

**Sub-acceptances:**
- **P-043a** — Each row: PR number + title, author avatar, checks status, reviews status, trust badge (✓ if author in my trust list), "cannot reach GitHub" badge if §8.4 polling has failed >5min.
- **P-043b** — Action buttons (if `pr_reviewer_role_enabled`): "Open on GitHub" (always), "Approve" (manual), "Approve + merge" (manual), "Auto-review on/off" indicator.
- **P-043c** — Filter chips: `mine`, `awaiting-me`, `awaiting-review`, `approved`, `merged`.

### P-044 — Auto-approve flow [M]

v5: gated on trust list. `pr_reviewer_settings` + per-PR check + Octokit approve call.

**Files:** `apps/operator/lib/pr-host/auto-approve.ts` (new), wired into P-042's poll daemon (on each PR update, check whether to fire auto-approve).

**Sub-acceptances:**
- **P-044a** — Only fires if `pr_reviewer_role_enabled` AND `auto_review` are both true for me on this harness AND the PR author is in my trust list AND the PR is in a state that allows approval (no requested-changes from me; no pending reviews from me).
- **P-044b** — Idempotent: re-running on an already-approved PR is a no-op.
- **P-044c** — Records the auto-approve action in LOCAL `auto_review_audit` table (Phase 1a P-013 schema).
- **P-044d** — Surfaces a one-line toast: "Auto-approved PR #123 by @alice (trust list)."

### P-045 — Auto-merge flow [S]

v5: gated on auto-merge toggle + auto-approve outcome + checks green.

**Files:** `apps/operator/lib/pr-host/auto-merge.ts`, wired same place as P-044.

**Sub-acceptances:**
- **P-045a** — Only fires if `auto_merge` is true AND the PR has been auto-approved by us AND checks are green.
- **P-045b** — Uses `merge_method` setting (squash/merge/rebase; default squash).
- **P-045c** — Records action in `auto_review_audit` with `action: 'merged'`.

### P-046 — Manual review path + trust-add consequence modal [S]

v5 §8.6.

**Files:** `apps/operator/app/harness/TrustAddConsequenceModal.tsx` (new), wired into the Contributors tab "Add to trust list" action (Phase 8 P-048).

**Sub-acceptances:**
- **P-046a** — When `auto_review` is on AND user adds someone to trust list, modal shows: "Future PRs from @alice will be auto-approved on this harness. Continue?"
- **P-046b** — Modal also surfaces if `auto_merge` is on: "...auto-approved AND auto-merged."
- **P-046c** — On confirm, contributor added; toast "@alice added to trust list."
- **P-046d** — On cancel, no change.

## Decisions

(None yet.)

## Named fallback rollout

If `@octokit/rest` proves unreliable or the rate limits bite harder than projected:
- Fall back to `gh api` shelling for the PR-related calls (same pattern as P-008's clone). Adds shell overhead per call (~50-100ms) but cuts the dep + uses the system git auth.
- Per-harness `pr_poll_interval_sec` raised to 300s default to halve API load.

No formal section needed.

## Cross-references

- Index: `papercusp-dogfood-execution-plan-index-2026-05-24.md`.
- Master: v5 `## Phase 7`, `### §8 — PR lifecycle`, `### §9.3 — PRs tab`, `### §9.4 — PR-reviewer settings`, `### §16.3 — Auto-rebase-on-push`, D-009 (GitHub-forced), D-018 (poll not webhook), D-019 (Octokit dep).
- Prereq plans: `phase1b`, `phase6`.

## Open questions

### Q-1 — Where do auto-approve / auto-merge actions show in the Insights activity feed?

§9.0 Insights "Activity feed" card should surface PR merges. Whether auto-merges look distinct from manual merges in the feed is a tier display decision. My lean: same icon, suffix `(auto)` for auto-merges; preserves the social signal but doesn't visually de-prioritize human action.

### Q-2 — Failed auto-approve handling?

If Octokit's `pulls.createReview` returns 422 (some PR-not-in-approvable-state errors), retry? Surface? Suggest: log to audit, retry once, then surface as a one-time error toast and stop trying for this PR.

## For the next agent (Phase 8)

Phase 8 (sidebar tabs + Insights + user profile) is L→XL. Phase 7's deliverables feed it:
- `harness_feature_prs` rows for Insights Activity feed + PRs tab.
- Auto-approve audit for Insights "Your place" card (showing whether reviewer role is active).
- PR poll daemon's `pr_check_status_cache` for the PR row check-detail expansion.
