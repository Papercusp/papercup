---
title: Papercusp dogfood — Phase 8 (sidebar tabs + Insights + contributor stats + user profile)
slug: papercusp-dogfood-phase8-sidebar-insights-profile-2026-05-24
created: 2026-05-24
updated: 2026-06-01
status: active
---

# Papercusp dogfood — Phase 8 (sidebar tabs + Insights + contributor stats + user profile)

## Now

**State:** Sidebar tabs + Insights tab + contributor stats + user profile + claimed/unclaimed harness UI. Core UI shipped (sidebar, Insights, the 1028-line DetailPanel). Remaining: **P-003** (ActivityFeedCard tier-A merged-PR events) **`done` ✅ SHIPPED 2026-06-01 (`0c08dfb06`)** — GitHub merged PRs now interleave with the PG-ledger activity events as tier-A `✓` rows, deduped by PR number, via `loadGithubMergedPrEvents` (mirrors the P-001/P-002 github-facts pattern); the "(and recent commits)" sub-option was deferred (surfaced, not dropped — merged PRs are the deduplicable unit; see the P-003 item below); **P-038** (working_users projection) **`done` ✅ RECONCILED 2026-06-01** (see below); **P-072b–f** (user-profile per-harness blocks, activity feed, footer, username redirect, Marketplace link) **`done` ✅ SHIPPED 2026-06-01** — the whole profile is now PG-real: `loadUserProfile` computes per-harness tier-A PRs (auto_review_audit), tier-B features-shipped, tier-C activity (contributor_usage_events) (b); reuses the cross-harness ~30-event feed via `loadUserRecentActivity` (c); the verified-claimant (`claim_status='claimed'` only — `stale` = lost permission, excluded) footer (d); the username→numeric redirect routes/endpoints (`/users/:login` → `by-login` → `/users/github/:id`) (e); and the Marketplace `publishedBy` link now targets the Papercusp profile (`/users/<login>`) in both the lib `MarketplaceDetail` + the operator-vite `$slug` route, GitHub link kept in the profile header (f). The §18 privacy filter runs through a new pure SEAM `lib/user-profile/visible-harnesses.ts` (`visibleHarnessesForViewer`).

**Next:** Phase 8b profile blocks done. **VIEWER-IDENTITY INFRA SHIPPED 2026-06-01 — the shared gap is CLOSED:** added `GET /api/viewer` (`routes/users/viewer.ts` → `resolveLocalGithubIdentity`, no token; anonymous→nulls@200) + the `useViewer()` hook (`app/adv/harnesses/useViewer.ts`, module-cached + `isMe()`). Wired the two ready consumers: (1) **P-072 privacy filter** now resolves the DESKTOP viewer — `by-github-id.ts` falls back from `getSessionUserOrDefault` to `resolveLocalGithubIdentity` (single-user loopback desktop → the local identity IS the viewer), so the filter is no longer anonymous-only; (2) **P-038 write path** — the FeaturesPanel now has a per-row **Start/Stop working** toggle (`setWorkingActive`/`clearWorkingActive` in harness-actions.ts) gated on `viewerId`, optimistic-patching `workingUsers[]`. **P-048/P-049/P-069 viewer-specific surfaces are now UNBLOCKED** (the infra exists; their full UIs are separate builds). Tests: viewer 3/3, useViewer 6/6, by-github-id 8/8, working-set-actions 4/4. (Optional recent-commit events remain a small deferred follow-up; the cross-harness activity feed's per-viewer privacy filter can now use the same `viewerId` resolution.)

### P-038 — working_users projection (Model-B reconciliation) `done` ✅ RECONCILED 2026-06-01

**Scope finding.** "working_users" has two representations in v5: the canonical `harness_features_consolidated.working_users BIGINT[]` array (§0.5 / §7.1 / D-016: `current_worker = working_users[0]`, DERIVED) and the Model-B Hyperbee per-(user,feature) `harness_shared.feature_working_set` pointer table. The **substrate** is fully live + tested under Model B (Phase-6 P-038: `feature-working-set.ts` projection registered in `register-all.ts`, `setActiveFeature`/`clearActiveFeature`, `loadWorkingSet`, the `GET/POST /api/harness/:slug/working-set/*` endpoints, and the P-038b orchestrator eligibility check in `claim-feature.ts`).

**The gap (two parts):**
1. The Model-B projection wrote **only** the pointer table and **never maintained** the canonical `working_users[]` array — so the column the v5 design names as the "projection" target stayed at its `'{}'` default. (Nothing wrote it; the `decideShouldAttemptClaim` reader has no production caller.)
2. The `working_users` column (+ the other three P-015 columns) was added to the DB by migration 080 but was **missing from the introspected Drizzle schema** (drift) — so `featuresConsolidated.bySlug` (`db.select()`) never carried it. And Phase-6 P-038's working-set UI (`useWorkingSet` + `SetActiveButton`) was **orphan-deleted** in `1c2731697` (the HarnessDashboard removal); the live `/adv` `FeaturesPanel` had no working surface.

**Reconciled (read path, faithful to Model B + D-016):**
- `feature-working-set.ts`: every put/del now recomputes the canonical `working_users[]` array from the live (non-cleared) pointer rows (`buildRecomputeWorkingUsersQuery`, ordered `started_at ASC` so `[0]` = current_worker, COALESCE to `'{}'`). Mirrors the sibling projection pattern; verified end-to-end against live PG.
- Added `workingUsers` to the Drizzle schema (`schema.ts` + `generated.ts`) so the existing consolidated SSE query carries it — no new SSE plumbing.
- `useHarnessData.ts`: `HarnessFeature.workingUsers` + `parseWorkingUsers` normalizer (number[]/string[]/JSON/PG-literal). `FeaturesPanel.tsx`: a read-only green "working" pill (count + current-worker tooltip).

**Deferred (write path — surfaced, NOT silently dropped):** the live `/adv` shell has **no viewer-identity resolution** and **no feature-queue membership surface** (both were part of the deleted FeatureList). Re-wiring a "Start working / Stop working" write button needs that viewer-identity infra, which is a separate UI-infra concern (also blocks the P-048/P-072 viewer-specific surfaces). The HTTP write endpoints already exist; only the live-shell button + identity hook are missing.

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
- **P-072a** `done` ✅ — Numeric route renders header (avatar, name, login, verified-binding badge, GitHub link).
- **P-072b** `done` ✅ SHIPPED 2026-06-01 — Per-harness collapsible blocks (one per visible harness — privacy-filtered per §18 invariants): tier-A PRs (auto_review_audit, author_github_id + auto/manual merge), tier-B features-shipped (harness_features_consolidated), tier-C activity (contributor_usage_events). Tier-D omitted. `loadUserProfile` computes all three per-harness counts; the §18 filter is the pure `visibleHarnessesForViewer` seam (anonymous-viewer default — see the viewer-identity gap below).
- **P-072c** `done` ✅ SHIPPED 2026-06-01 — Cross-harness recent activity feed (~30-cap) via `loadUserRecentActivity`, scoped to the visible harnesses.
- **P-072d** `done` ✅ SHIPPED 2026-06-01 — Footer: VERIFIED-claimant harnesses only (`claim_status='claimed'` + this user in `claimed_by_github_user_ids`). `stale` (lost-permission) bindings are excluded per §5.1. (Fixed a latent bug: the claimant array is BIGINT[], so the `= ANY(...)` now binds a numeric id, not a string.)
- **P-072e** `done` ✅ — Username route redirects to numeric (`/users/:login` → `GET /api/users/by-login/:login` → `/users/github/:id`; Next page + operator-vite route both wired).
- **P-072f** `done` ✅ SHIPPED 2026-06-01 — Marketplace `publishedBy` link now targets the Papercusp profile (`/users/<login>`, the redirecting username route) via the pure `publisherProfileHref` helper, switched in BOTH the lib `MarketplaceDetail` (registry site) and the operator-vite `$slug` route (in-app, via `RouteLink`). GitHub link kept in the profile header.

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


## GitHub enrichment (2026-05-30)

- **P-001** `done` ✅ SHIPPED (`b862dd5e`+`476d0d7a`): Insights ProjectCard rendered from real GitHub repo facts. New `lib/harness-insights/github-facts.ts` resolves the harness repo via its git `origin` remote + authenticated Octokit and fills description / owner / license / top-3 languages (linguist colors) + a tier-A stats row (★ stars, forks, open issues, last-push). 1h cache; degrades to slug fallback (no token/remote/match). Extends P-073a. (Bookkeeping: item text already records ✅ SHIPPED b862dd5e+476d0d7a; stored status was stale `todo`.)


## GitHub enrichment (2026-05-30)

- **P-002** `done` ✅ SHIPPED (`7cbf34d2`): Insights PeopleCard tier-A GitHub commit counts. `loadGithubContributorCommits` fetches GET /contributors and merges per-login commit counts onto People rows (pure merge in loadHarnessInsights; endpoint does the fetch). Card renders a `✓ N` tier-A marker per contributor. Extends P-073c / P-071a. (Bookkeeping: item text already records ✅ SHIPPED 7cbf34d2; stored status was stale `todo`.)


## GitHub enrichment (2026-05-30)

- **P-003** `done` ✅ SHIPPED (`0c08dfb06`): ActivityFeedCard tier-A merged-PR events. `loadGithubMergedPrEvents` (github-facts.ts, mirrors the P-002 contributor-commits loader: resolve repo via git origin remote + authenticated Octokit `GET /repos/:o/:r/pulls?state=closed`, filter `merged_at != null`, 1h cache, degrade to PG-only feed on no-token/remote/match) maps each merged PR to a tier-A `pr_merged` event (`✓`/A pill via the existing P-071a `TIER_BY_KIND`) carrying author login, title, short merge-commit SHA, merged-at timestamp, and the PR URL. Pure logic split out for TDD: `mapMergedPrsToActivityEvents` (PR list → tier-A events; drops closed-but-unmerged; sorts + clamps) and `mergeActivityEvents` (interleave PG ledger + GitHub by `tsEpoch` desc, dedupe by `dedupKey = pr:<number>` with the tier-A GitHub event winning a PG/GitHub collision, cap to the ~20 limit). To support a real cross-source sort I added optional `tsEpoch` + `dedupKey` to `ActivityFeedEvent` and replaced the old lossy `whenLabel`-weight reverse-engineering sort in `harness-activity/load.ts` with the stamped-`tsEpoch` merge (every PG event now stamps `tsEpoch`; `pr_merged` also stamps the shared `dedupKey`). Completion-ref tie preserved: the merge-commit SHA (tier-B anchor) is surfaced in the event text, not consumed/overwritten. `load-all.ts` threads `githubActivityEvents`; the insights endpoint fetches the merged PRs and passes them in. Tests: 49 across github-facts (map/loader/degrade/cache) + harness-activity (interleave/dedupe/merge) + load-all (integration). Extends P-073b / P-071a.

  **Commit-event note (deferred, surfaced not dropped):** the item also mentioned "(and recent commits)" as an *optional* tier-A source. Shipped merged-PR events only — merged PRs are the meaningful, deduplicable activity-feed unit (a PR carries the tier-B completion anchor; raw per-commit rows would flood the ~20-cap feed and have no clean dedup against the PG ledger). Recent-commit events are not done; pick them up as a small follow-up if the feed wants finer granularity. **Also flagged:** the feed has no viewer-identity / privacy filter — it shows the harness's public GitHub PR history to any viewer, which is fine for a public repo but is the same shared viewer-identity gap noted under P-038's deferred write-path and P-048/P-072.


## GitHub enrichment (2026-05-30)

- **P-004** `done` TODO: HowItWorksHereCard renders the repo README (GET /repos/:owner/:repo/readme) for new-joiner orientation. Closes P-073e (currently slug-derived placeholder). Needs a read-only markdown renderer in the card. (SHIPPED a8a005078: HowItWorksHereCard renders the repo README via loadRepoReadme GET /repos/:owner/:repo/readme, base64-decoded, 1h-cached, degrades + react-markdown/remark-gfm read-only render.)


## GitHub enrichment (2026-05-30)

- **P-005** `done` TODO: ProjectCard extras — repo topics (pills) + latest release tag/date (GET /repos/:owner/:repo/releases/latest). Small follow-up to the shipped P-073a GitHub facts; reuses github-facts.ts. (SHIPPED 4828a9806: ProjectCard topics pills + latest release tag + relative date via github-facts.ts getLatestRelease; 18→ unit tests.)

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
