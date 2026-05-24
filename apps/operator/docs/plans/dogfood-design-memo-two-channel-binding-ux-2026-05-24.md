---
title: Papercusp dogfood — design memo — two-channel binding verifier UX
slug: dogfood-design-memo-two-channel-binding-ux-2026-05-24
status: accepted
accepted_at: 2026-05-24
accepted_by: avi@storewolf.com
created: 2026-05-24
updated: 2026-05-24
owner: avi@storewolf.com
---

# Design memo — two-channel binding verifier UX

> Second of three Phase 1b design memos. Sibling memos: `dogfood-design-memo-device-attestation-ux-2026-05-24.md`, `dogfood-design-memo-binding-service-api-2026-05-24.md`.

## Now

**State:** draft for review. Covers the user-facing surfaces for §0.2.7 two-channel binding (D-031 in v5) — how the `verified ✓` / `pending ⏳` / `unverified ⚠` state surfaces across the operator UI.

**Next action:** user reviews; on accept, gets promoted to D-decisions in Phase 1b plan.

## Background

§0.2.7 introduces two-channel verification (server-side OAuth re-check + GitHub-verified commit on the user branch). Every contributor row carries a `binding_status` ∈ `pending | verified | unverified`. This memo covers how that status appears across the four UI surfaces that consume it: Contributors tab (§9.2), Insights People card (§9.0), feature/PR card avatars, and user profile page (§18). Plus: what daily re-check failures look like for the user.

## Design

### Visual vocabulary — three states, two zoom levels

Two zoom levels matter:
- **Dense** (in lists / avatar stacks / feature cards): small badge next to avatar.
- **Detailed** (Contributors tab row, user profile, claim flows): badge + tooltip + sometimes a sub-line of explanatory copy.

Three states, consistent across all surfaces:

| State | Dense | Detailed |
|---|---|---|
| `verified` | small `✓` overlay on avatar (bottom-right, 25% size, green) | `Verified ✓` badge + tooltip "Two-channel binding verified `<date>`" |
| `pending` | small `⏳` overlay on avatar (bottom-right, 25% size, amber) | `Pending ⏳` badge + tooltip "Binding in progress — channel 1 verified, waiting on channel 2 (typically <5 min)" |
| `unverified` | small `⚠` overlay on avatar (bottom-right, 25% size, red) + slight grey-out of avatar | `Unverified ⚠` badge + tooltip "Two-channel binding not complete. Stats from this contributor are not counted." |

**Why overlays not separate icons:** keeps the binding state attached to the contributor's identity visually, not a separate column. A reviewer scanning a PRs list sees `@alice ✓` as a single visual unit.

**Why slight grey-out for unverified:** the user needs to read the badge as "this contributor's activity doesn't aggregate," and a small visual de-prioritization reinforces that. Not full grey — they're still a participant who can be read; just visually downweighted.

### Per-surface treatment

**Contributors tab (§9.2)**
- Each row's avatar carries the dense overlay.
- Detailed badge appears as the row's first metadata pill, before joined-date and activity badges.
- Unverified rows: greyed appearance per the visual vocabulary; stats columns show `—` not `0` (per addendum-3 P-048d "zeroed out" rule — `—` is clearer than `0` for "doesn't count").
- Filter chip: `Unverified` chip (off by default) lets a reviewer find anyone whose binding is broken — diagnostic surface for the harness admin.

**Insights People card (§9.0)**
- Avatar stack uses dense overlays.
- Unverified avatars are NOT in the People card stack (they're filtered out — the People card is the social-proof surface and showing unverified-but-greyed avatars there mixes signals).
- A small footer line if any unverified exist: "N contributor(s) have unverified bindings. View in Contributors tab." → click navigates to Contributors with the Unverified filter applied.

**Feature / PR card avatars (queue, working, PR-author)**
- Dense overlay on every avatar.
- Click avatar → user profile (per Phase 8 P-072) — the profile is where the user can read the full binding state.
- Unverified avatars in the feature's `created_by_github_user_id` slot show the avatar but the feature's contributor count toward tier-C activity stats (P-070 rollup) excludes it. This is consistent with addendum-3's "unverified contributors contribute to no tier."

**User profile (§18)**
- The most-detailed treatment. Profile header shows `Verified ✓` / `Pending ⏳` / `Unverified ⚠` badge prominently next to the GitHub username.
- For `unverified`: full-width banner under the header: "This GitHub identity has not completed Papercusp's two-channel binding. Their stats are not counted in any aggregate. Last verification attempt: `<timestamp>` failed because `<reason>`. They can re-bind by joining a shared harness on a device where their GitHub OAuth is active." (Direct copy from v5 §18.)
- For `pending`: amber banner: "This contributor's binding is in progress. We'll re-check automatically; stats will start counting once channel 2 lands."

### Daily re-check failures

P-075 spec includes a daily background re-check daemon. When a previously-verified binding fails re-check (e.g. user rotated OAuth tokens, gist was deleted, branch protection changed and the channel-2 file was scrubbed):

- **Immediate**: `binding_status` flips to `unverified` IF re-check failure is conclusive (gist 404, branch missing). Stats stop aggregating.
- **Transient failures** (GitHub API rate-limit, network timeout): NOT flagged immediately. Re-try with backoff (per P-075g grace period). Surface as `pending` (not `unverified`) if backoff exceeds 24h.
- **Notification**: toast to the affected contributor: "Your Papercusp binding needs re-verification. Open `Settings → Identity` to re-bind." Toast fires once per failure window, not per re-check attempt (don't spam).
- **Notification to harness admins**: silent. The Contributors tab `Unverified` filter is the diagnostic surface; admins check it on demand, not via notification.

### Pending-state details

Pending occurs in two scenarios:
1. **Just-joined** (most common): channel 1 (OAuth re-check) passed; channel 2 (branch push) is still propagating. Should clear within 5 min as the branch becomes visible via `git fetch`.
2. **Channel 2 re-verification timeout**: daily re-check hit a network failure for channel 2; channel 1 still passes. Should clear when the network does.

Both render the same `Pending ⏳` badge. The tooltip differs:
- Just-joined: "Binding in progress — typically <5 min."
- Re-verification timeout: "Channel 2 re-verification temporarily failed. Auto-retry."

The UI doesn't need to distinguish the two unless the user clicks for diagnostic detail (Settings → Identity → device list shows the verification log).

### Claim flow interaction

Per addendum-1, only verified-binding contributors can claim a harness. The Claim CTA (Phase 8 P-069e) gates on:
1. Binding verified ✓.
2. GitHub permission `maintain` or `admin` on the bound repo.

If the user is `pending` or `unverified`, the Claim CTA shows but is disabled with a tooltip: "Your Papercusp binding needs to complete before you can claim. [Why?]" — the `[Why?]` opens an explainer modal that reiterates §0.2.7 in user-friendly language.

## Decisions (proposed)

### D-A — Avatar overlay vocabulary (✓ / ⏳ / ⚠ with color)

Dense state lives on the avatar, not as a separate column. Color-coded so even at-a-glance the state is readable.

### D-B — Unverified contributors are EXCLUDED from Insights People card

Show in Contributors tab (with greyed appearance + filter), but not in the social-proof People card. The People card is for trustable identities.

### D-C — Re-check failures trigger toast to affected user only, NOT to harness admins

Admins use the Contributors `Unverified` filter as the diagnostic surface. Avoiding "your contributor broke" admin notifications keeps the noise floor low.

### D-D — Pending state has two reasons but one badge

Tooltip differs; badge is the same. Diagnostic-detail lives in Settings → Identity for users who want to dig in.

### D-E — Claim CTA disabled (not hidden) for non-verified users with explainer link

A disabled-with-explanation button is more discoverable than a hidden one. User learns what's required by encountering the gate.

## Open questions

### Q-1 — What does "zeroed stats" look like for the very-first-week unverified contributor?

If Alice joins, binding fails (channel 2 never lands due to branch protection misconfig), and she works on a feature anyway, her contribution shows up in queue + working_users but her PR-merged count stays at `—`. Is this confusing? Probably. Suggest: a small inline warning on her contributor row: "Working on F-042 — stats not counting until binding completes."

### Q-2 — Should the pending-state grace window be configurable per harness?

Default 24h before pending → unverified flip. Some harnesses with strict branch protection might legitimately need longer (e.g. requires PR-approval to merge to `user/<id>`). Suggested: configurable per harness, 24h default, 1-week max. Surface as a harness-level setting (probably in the claim-owner-only settings list from §5.1).

### Q-3 — Do we surface daily-re-check failures as a separate "Identity health" surface in Settings, or fold into the device list?

Lean fold-into-device-list (Settings → Identity → per-device row carries last-verification timestamp + status). Separate surface is overkill for v1.

## Cross-references

- `papercusp-dogfood-phase1b-oauth-clone-attestation-2026-05-24.md` — implements via P-075.
- `papercusp-dogfood-phase8-sidebar-insights-profile-2026-05-24.md` — surfaces (Contributors tab P-048, Insights People P-073, user profile P-072).
- v5 §0.2.7, §17 (trust tiers), §18 (user profile), D-031.

## For the implementing agent

When P-048 / P-072 / P-073 implementation begins:
- This memo's visual vocabulary becomes a shared component: `apps/operator/app/_components/BindingStatusBadge.tsx` (dense + detailed variants).
- Avatar overlay component: `apps/operator/app/_components/AvatarWithBindingBadge.tsx` — wraps the existing avatar component.
- Convert this memo to `apps/operator/content/internal-docs/design/dogfood-two-channel-binding.mdx` and promote the five D-A through D-E decisions to the Phase 1b plan.
