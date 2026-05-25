---
title: Papercusp dogfood — Phase 8 (sidebar tabs + Insights + contributor stats + user profile)
slug: papercusp-dogfood-phase8-sidebar-insights-profile-2026-05-24
status: in-progress
parent: papercusp-dogfood-v5-2026-05-23
created: 2026-05-24
updated: 2026-05-25
owner: avi@storewolf.com
---

# Papercusp dogfood — Phase 8 (sidebar tabs + Insights + contributor stats + user profile)

## Now

**State:** **Visual building blocks shipped 2026-05-25 — assembly TBD.**

Per-component progress:
- **P-071 ContributorBadge** + **ContributorBadgeRow** at `apps/operator/app/_components/ContributorBadge.tsx`. 4 trust tiers (A ✓ accent, B ✓ secondary, C unmarked, D ⏱ viewer-only with privacy gate). 10/10 tests pass.
- **P-069a ClaimStatusBadge** at `apps/operator/app/_components/ClaimStatusBadge.tsx`. 4 states (unclaimed / claimed / stale / superseded) with optional claimant login + successor href. 8/8 tests pass.
- **BindingStatusBadge** (P-048a partner / P-075 UI hook) at `apps/operator/app/_components/BindingStatusBadge.tsx`. 3 states (verified ✓ / pending ⏳ / unverified ⚠) with optional age text + failure reason. 6/6 tests pass.
- **P-072 User profile shell** at `apps/operator/app/users/github/[id]/`. Numeric canonical route + `app/users/[login]/page.tsx` username redirect. All 4 P-072 sub-acceptance regions render with stub data (header / per-harness blocks / activity feed / claimed-harnesses footer). 10/10 tests pass. Real data fetch is a follow-up.

Total Phase 8 tests landed: **34/34 pass**.

**Next action:** P-048 (Contributors tab) — composes ContributorBadgeRow + BindingStatusBadge per row. Reads from the now-existing `harness_shared.contributors` PG table (populated by either the existing PG path or the Phase 5a contributors projection). After P-048, P-073 Insights tab + P-069b/c/d wire-up of ClaimStatusBadge into the harness chrome.

The Phase 8a/8b split (originally proposed for parallelization) is moot now that the building blocks are shared components: any consumer can pick them up incrementally.

## Background

Phase 8 implements `## Phase 8 — Sidebar tabs + identity UI [L]` from v5 (~line 1267) plus the addendum-3 additions to that phase. UI-heavy; mostly wiring HYPERBEE-projected rows + trust-tier badges into operator components.

**Gate:**
- Phase 5b complete (HYPERBEE UI surfaces from `feature_queue`, `contributors`).
- Phase 7 complete (PR data flows from `harness_feature_prs`).
- **Phase 1b P-075 two-channel binding done — MANDATORY before any tier-A/B/C stat surfaces ship.** Per v5 §9.0 ordering constraint, do not start Insights (P-073) until P-075 is complete. The unverified contributors must render the `unverified ⚠` badge correctly OR no stat aggregations happen — both depend on P-075.

## Phase tasks

### P-047 — Features tab UI [M]

v5 §9.1.

**Files:** `apps/operator/app/harness/FeaturesTab.tsx` (extend, exists from Phase 5b P-032).

**Sub-acceptances:**
- **P-047a** — Queue/working/shipped filters.
- **P-047b** — Pull-into-queue actions (already shipped in P-032 — confirm wired).
- **P-047c** — Feature detail panel with description (vditor-rendered), notes, audit log, current PR.

### P-048 — Contributors tab UI (updated for addendum 3) [M]

v5 §9.2 + addendum-3 update: binding-status badges, tier-labeled activity badges, sortable columns, click-to-profile.

**Files:** `apps/operator/app/harness/ContributorsTab.tsx` (new), `ContributorRow.tsx`.

**Sub-acceptances:**
- **P-048a** — Per-row: avatar, display name + `@github_username`, **binding-status badge** (verified ✓ / pending ⏳ / unverified ⚠ per §0.2.7), joined date, **activity badges with trust tiers** (P-071), trust-list menu (if `pr_reviewer_role_enabled`), devices section (collapsed).
- **P-048b** — Avatar click routes to user profile (P-072).
- **P-048c** — Sortable by joined-recency, PRs-merged (✓ A), features-shipped (✓ B), activity (C). Visual grouping by tier so users see what they're sorting on.
- **P-048d** — Unverified contributors render with zeroed stats + greyed appearance.

### P-049 — PR-reviewer settings modal [S]

v5 §9.4.

**Files:** `apps/operator/app/harness/PrReviewerSettings.tsx` (new), gear icon in PRs tab (Phase 7 P-043).

**Sub-acceptances:**
- **P-049a** — Per-harness toggles: `pr_reviewer_role_enabled`, `auto_review`, `auto_merge`, `merge_method`.
- **P-049b** — Trust list view + remove inline.
- **P-049c** — Audit log: recent auto-review + auto-merge actions from LOCAL `auto_review_audit`.

### P-050 — vditor integration [M]

v5: vditor for BOTH editing AND reading of single-markdown surfaces per D-020. Migrate existing PlanEditor to vditor.

**Files:** confirm vditor wrapper exists at `apps/operator/app/_components/MarkdownEditor.tsx` (yes, per session memory); standardize usage across feature descriptions, decisions, design artifacts. Migrate `apps/operator/app/admin/plans/*` PlanEditor.

**Sub-acceptances:**
- **P-050a** — All identified single-markdown surfaces use the shared `MarkdownEditor` component.
- **P-050b** — PlanEditor migration: existing plan-edit flows preserved (vditor mode toggle for ir/wysiwyg/sv per the existing wrapper).

### P-069 — Claimed/unclaimed UI (addendum 1) [M]

v5 addendum 1: harness header badge, settings banner, create/join existing alert, provisional-owner explainer modal, Contributors claimants/provisional-owner indicators, claim CTA gated by GitHub repo permission.

**Files:** various — `apps/operator/app/harness/ChromeShell.tsx` (header badge), `apps/operator/app/harness/SettingsBanner.tsx` (new), `apps/operator/app/harness/ClaimCTA.tsx` (new), `apps/operator/app/harness/ProvisionalOwnerExplainer.tsx` (new — copy from §5.1).

**Sub-acceptances:**
- **P-069a** — Badge: `Unclaimed`, `Claimed`, `Stale claim`, `Superseded`.
- **P-069b** — Settings banner: "This harness is unclaimed. You're the provisional owner." OR "Claimed by @alice + 2 others."
- **P-069c** — Create/join: existing-binding alert with claimed/unclaimed status before Join.
- **P-069d** — Provisional-owner explainer fires on first share-create.
- **P-069e** — Claim CTA calls Phase 1b P-068's `claimBinding`; rejection surfaces structured perm error.

### P-071 — Contributor activity badges (addendum 3) [S]

v5 addendum 3 P-071: tier-labeled badges used in §9.2 Contributors, §9.0 Insights People, feature/PR card avatars, §18 user profile.

**Files:**
- `apps/operator/app/_components/ContributorBadge.tsx` (new) — shared component.
- Wire into the four consumer surfaces above.

**Sub-acceptances:**
- **P-071a** — Renders tier-A merged-PR pill (✓), tier-B features-shipped pill (✓), tier-C activity pill (unmarked, from `contributor_usage_events` rollup via Phase 5a P-070), viewer-only tier-D spend pill (⏱, self only).
- **P-071b** — Tier visual grouping; tooltip explains tier on hover.

### P-072 — User profile page (addendum 3) [M]

v5 addendum 3 §18 + D-028: route at `/users/github/<github_user_id>`; username route redirects.

**Files:**
- `apps/operator/app/users/github/[id]/page.tsx` (new).
- `apps/operator/app/users/[login]/page.tsx` (new — redirects to numeric route).
- `apps/operator/app/users/github/[id]/UserProfile.tsx` (new).

**Sub-acceptances:**
- **P-072a** — Numeric route renders header (avatar, name, login, verified-binding badge, GitHub link).
- **P-072b** — Per-harness collapsible blocks (one per visible harness — privacy-filtered per §18 invariants): tier-A PRs, tier-B features-shipped, tier-C activity. Tier-D omitted entirely from profile.
- **P-072c** — Recent activity feed across visible harnesses (last ~30 events).
- **P-072d** — Footer: claimed harnesses (where this user is a verified claimant per §5.1).
- **P-072e** — Username route redirects to numeric.
- **P-072f** — Marketplace `publishedBy` link target switches from GitHub-direct to Papercusp profile (with GitHub link still in profile header).

### P-073 — Insights tab UI (addendum 3) [M]

v5 §9.0: pinned-top sidebar tab; post-install default landing; six cards. **Blocked-by P-070 (Phase 5a) + P-071 + P-075 (Phase 1b).**

**Files:**
- `apps/operator/app/harness/InsightsTab.tsx` (new).
- Card components: `ProjectCard`, `ActivityFeedCard`, `PeopleCard`, `YourPlaceCard`, `HowItWorksHereCard`, `SpendCard` — under `apps/operator/app/harness/insights/`.

**Sub-acceptances:**
- **P-073a** — Project card: name, description, owner (with claimed/unclaimed badge), license, languages, GitHub link, Discord link (if §11 set). Tier-A.
- **P-073b** — Activity feed: last ~20 events with tier badges. Composes feature shipped (B), PRs merged (A), contributors joined (C), decisions added (C), escalations opened (C). Click → relevant detail.
- **P-073c** — People: horizontal avatar stack with verified-binding badges. Click → §18 user profile.
- **P-073d** — Your place: viewer-specific. Queue summary, role state, trust state, spend-this-week (⏱).
- **P-073e** — How it works here: prose composed from harness config (queue → claim → PR → shipped flow + this harness's customizations).
- **P-073f** — Spend (⏱): local `tool_invocations`-derived total + viewer's share-of-harness rough number. Banner with proxy-witness deferral text from v5 addendum-2.
- **P-073g** — Force-route on first visit per LOCAL `insights_first_visit` (Phase 1a P-074). Dismiss sets `seen_at_ts`.

## Decisions

(None yet. Phase 8a/8b split decision goes here as D-001 when made.)

## Named fallback rollout

None — UI-only, no substrate fallback.

## Cross-references

- Index: `papercusp-dogfood-execution-plan-index-2026-05-24.md`.
- Master: v5 `## Phase 8`, `### §9.0 — Insights tab`, `### §9.1-9.4`, `### §17 — Stat trust tiers`, `### §18 — User profile`, addenda 1 + 3.
- Prereq plans: `phase5b`, `phase7`, `phase1b` (especially P-075).
- D-029 (Insights pinned-top + post-install), D-030 (trust tiers), D-031 (two-channel binding), D-027 (event ledger), D-028 (numeric profile route).

## Open questions

### Q-1 — Phase 8a/8b split or single XL?

Lean split. 8a = Features/Contributors/PRs/Reviewer-settings/Claimed-unclaimed/vditor (P-047, P-048, P-049, P-050, P-069). 8b = Activity badges/User profile/Insights (P-071, P-072, P-073). 8a is M-sized; 8b is M-sized; total parallelizable. Decide before any P-task starts.

### Q-2 — Privacy filter for user profile (P-072b) — how is "viewer's harness membership" determined?

Suggested: viewer is a member of harness X if `contributors[harness_slug=X][github_user_id=viewer]` exists with `binding_status='verified'`. For viewers with no membership in shared-private harnesses the user contributes to, those harnesses are hidden from the profile (only shared-public + no-private appear).

### Q-3 — Insights "How it works here" — fully composed from config, or templated with a "customize" hook?

Suggested: templated. v1 = template-with-config-substitutions. v2 = let provisional owner / claimant edit a custom welcome paragraph.

## For the next agent (Phase 9)

Phase 9 (Cupboard + Discord + sync-with-main) consumes:
- The user profile page (P-072) as the target for Cupboard's contributor name links.
- The tier-A badge pattern (P-071, P-073) for Cupboard's listing stats per P-076.
- The Claimed/unclaimed UI (P-069) for Cupboard's listing claimant display.

Phase 9 is the last big phase before multi-engineer dogfood (Phase 11).
