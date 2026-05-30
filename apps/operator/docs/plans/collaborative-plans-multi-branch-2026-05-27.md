---
title: Collaborative plans — per-user branches, contribute model, build dropdown
slug: collaborative-plans-multi-branch-2026-05-27
status: superseded
created: 2026-05-27
updated: 2026-05-30
owner: avi@storewolf.com
---

# Collaborative plans — per-user branches, contribute model, build dropdown

## Now

**State:** Plan written. Ready for Phase 1 implementation.

**Next:** Begin Phase 1 — branch model + worktree provisioning (P-001 through P-006).

## Background

The dogfood-v5 arc designed collaboration around per-user worktrees: each contributor gets
their own `user/<github_user_id>` branch and worktree. This plan replaces that model with
one that puts plans — not users — as the organizing unit of isolation.

The shift is motivated by the move to plans as the central harness UX: if plans are what
users think in, plans should also be what git branches represent. Per-user branches are
too coarse (all your work lumped together) and too fine (you might want multiple branches
for different risky initiatives). The right primitive is: one branch per "strand of work,"
where a strand maps cleanly to one or several related plans.

**Companion design docs this supersedes or extends:**
- `plans-harness-scoped-2026-05-24` — Hyperbee storage, author-only enforcement, drag-to-fork.
  Those decisions still stand; this plan adds the branch model and contribute flow on top.
- `papercusp-dogfood-v5-2026-05-23` — per-user branch model superseded by D-001 here.
- `papercusp-dogfood-phase7-pr-lifecycle-2026-05-24` — two-level PR model updated per D-007 here.

## Goals

1. `${userName}_main` as each user's default branch. Plans created without an explicit
   branch assignment land here. The orchestrator writes feature code to the worktree for
   whatever branch the plan is on.
2. One branch → many plans; one worktree per branch. Plans inherit their branch;
   creating a new plan in an existing branch does not create a new worktree.
3. UI primitive: "New Plan" button. Creates the plan and optionally a new branch and
   worktree. The user never sees a "create branch" action — branches are derived from plans.
4. Plans can move between branches. Moving a plan cherry-picks all `completion_ref` SHAs
   from its shipped features onto the target branch. Blocked while any feature is in-flight.
5. Two-panel plans UI. Left panel: others' plans (read-only, shared harness only).
   Right panel: my plans. Others' panel collapsed in private harnesses.
6. Drag-to-fork already designed in `plans-harness-scoped-2026-05-24` — carried forward unchanged.
7. Drag-to-incorporate: drop another user's plan onto one of your own plans → agent
   console opens with a merge prompt. Tracked as `incorporated_from` in frontmatter.
8. Branch indicator + switcher always visible in top bar. Shows `⎇ avi_main ▼`.
   My branches (checkout) + others' branches (read-only lens).
9. "Contributing to X's plan" banner whenever running a feature from someone else's plan.
10. Build dropdown ("Builds") next to harness selector. Configurable per-harness in Settings.
    Each entry runs a shell command in an inline terminal.
11. Contribute to others' plans. Anyone can start running anyone else's plan. Code writes
    to `contrib/<your-username>/<plan-id>/<feature-id>` branch, PR targets their plan branch.
    Distributed claim prevents double-working.
12. Features sync via Hyperbee; code is git-only. Feature state is live-synced.
    Code is auto-committed and pushed only at feature completion.

## Non-goals

- No user-branch concept at all — `user/<id>` branches from dogfood-v5 are fully replaced.
- No real-time code sync between peers (Hyperdrive peer-mirror is Phase 10 opt-in, unchanged).
- No user-typed branch names — all branch names are system-derived to prevent collisions.

## Phase 1 — Branch model + worktree provisioning

- [todo] P-001: Add `branch` field to plan frontmatter spec. Default: `${author}_main`.
- [todo] P-002: Add `incorporated_from: string[]` field to plan frontmatter spec (parallel to `forked_from`).
- [todo] P-003: Provision `${userName}_main` branch + worktree on harness join if it doesn't exist.
- [todo] P-004: `plans:new` inherits current branch from context; accepts optional `branch` override to place plan on an existing branch.
- [todo] P-005: Orchestrator reads plan's `branch` field to determine which worktree to write feature code to.
- [todo] P-006: `plans:start` provisions the plan's branch worktree if missing before setting `status = started`.

## Phase 2 — Plan-to-branch move

- [todo] P-007: `plans:move-branch` verb: accepts `targetBranch`; collects `completion_ref` SHAs from all shipped features in the plan.
- [todo] P-008: `plans:move-branch`: returns `{ blocked: true, features: [...] }` if any feature is `in_progress` or `pending_done`; does not proceed.
- [todo] P-009: `plans:move-branch`: creates target branch from `main` if it doesn't exist, then cherry-picks SHAs in chronological order.
- [todo] P-010: `plans:move-branch`: updates plan frontmatter `branch` on success.
- [todo] P-011: UI: "Move to branch…" option in plan card context menu; shows branch picker + blocker warning when in-flight features exist.

## Phase 3 — Two-panel plans UI + branch switcher

- [todo] P-012: Two-panel layout in the Plans tab: "Others' plans" (left, collapsible) + "My plans" (right).
- [todo] P-013: Others' panel hidden by default in private harnesses; default-open in shared harnesses.
- [todo] P-014: Branch indicator `⎇ ${branch} ▼` always visible in the top bar, right of the harness selector.
- [todo] P-015: Branch switcher dropdown: "My branches" section (switches worktree context) + "Others' branches" section (read-only lens).
- [todo] P-016: Selecting another user's branch = read-only view; plans pane, build dropdown, and timeline all reflect that branch.
- [todo] P-017: "Contributing to <username>'s plan" sticky banner shown whenever running a feature from another user's branch view.
- [todo] P-018: "New Plan" button creates plan + optionally new branch + worktree; branch name system-derived (`${author}_<kebab-slug>`), never user-typed.

## Phase 4 — Drag-to-incorporate

- [todo] P-019: Drag-to-incorporate target: drop a peer's plan card onto one of your own plan cards in the My Plans panel.
- [todo] P-020: On drop, open a plan-agent-launch console with prompt: "Incorporate [source plan title] into [target plan title]. Read both plans and propose additions/edits to the target."
- [todo] P-021: After agent session completes, record `incorporated_from` in target plan frontmatter (array; append if already set).
- [todo] P-022: Track incorporation in Hyperbee `incorporations` table: `source_plan_id`, `target_plan_id`, `incorporated_at`, `incorporating_user_pubkey`.
- [todo] P-023: Drag-to-fork (from `plans-harness-scoped-2026-05-24`) carried forward unchanged — drop onto blank area of My Plans panel.

## Phase 5 — Contribute-to-others flow

- [todo] P-024: When running a feature from another user's plan, code commits go to `contrib/<your-username>/<plan-id>/<feature-id>` branch.
- [todo] P-025: PR from contribute branch targets plan owner's plan branch (from plan frontmatter `branch` field), not main.
- [todo] P-026: Plan owner receives PR notification via Hyperbee notify; can approve/merge or request changes from the harness UI.
- [todo] P-027: Plan owner's PR merge settings (auto-approve threshold, required test gates) apply to contributor PRs targeting their plan branch.
- [todo] P-028: Feature stays `pending_done` until the contributor PR is merged; flips to `shipped` on merge via `completion_ref` stamp.
- [todo] P-029: Distributed claim (dogfood Phase 6) prevents two contributors from working the same feature simultaneously.

## Phase 6 — Builds dropdown

- [todo] P-030: "Builds" dropdown button in the top bar, right of the branch indicator.
- [todo] P-031: Default entries: "testing" and "prod"; each runs a harness-configured shell command.
- [todo] P-032: Each entry runs its command in an inline terminal panel that opens in the UI.
- [todo] P-033: Terminal panel persists the last 5 runs per entry; re-openable from the Builds dropdown.
- [todo] P-034: Settings tab → Harness → Builds section: add/remove/rename entries + configure command per entry; all per-harness.
- [todo] P-035: Build entry config stored in harness config (PG for private harnesses; Hyperbee for shared).

## Phase 7 — PR hierarchy + dogfood plan updates

- [todo] P-036: Update PR lifecycle docs: contributor code branch → plan branch (plan owner reviews); plan branch → main (repo owner / harness PR settings).
- [todo] P-037: "Open PR to main" action is branch-level only; no feature-level or plan-level "PR to main" action in the UI.
- [todo] P-038: Update `papercusp-dogfood-phase7-pr-lifecycle-2026-05-24` plan with the revised two-level hierarchy; add cross-reference to D-007 here.
- [todo] P-039: Update `papercusp-dogfood-v5-2026-05-23` with a decision superseding the per-user worktree model (cross-reference D-001 here).

## Decisions

### D-001 — Per-user worktrees superseded by per-branch worktrees

**Decided 2026-05-27.** The `user/<github_user_id>` branch model from dogfood-v5 is dropped.
Each user gets `${userName}_main` as their default branch; additional branches are created on
demand via the "New Plan" flow. A branch has one worktree. Plans inherit their branch.

**Why:** plans are now the primary collaboration unit. Per-user branches were too coarse —
all work lumped onto one branch regardless of isolation needs. Per-plan branches were
considered and rejected (one branch per plan creates worktree explosion and incoherent code
history). Per-branch-with-multiple-plans is the right granularity.

**Alternatives rejected:**
- Keep per-user branches from v5. Doesn't give isolation within a user's own work.
- One branch per plan. 50 plans = 50 worktrees; code history becomes incoherent.

### D-002 — Plan move: cherry-pick completion_refs, blocked on in-flight features

**Decided 2026-05-27.** Moving a plan to a different branch cherry-picks all `completion_ref`
SHAs (the merge commit SHA from each shipped feature's PR) in chronological order onto the
target branch. If any feature is `in_progress` or `pending_done`, the move is blocked — the
UI shows the blocking features. User must complete or pause them before proceeding.

**Why:** `completion_ref` is the precise, already-recorded handle for each feature's code
contribution. Cherry-picking is clean and reversible. Blocking on in-flight features is
simpler and more honest than partial moves.

**Alternatives rejected:**
- Allow move with in-flight features, cherry-pick only completed ones. Leaves plan in
  split-brain state where future features land on new branch but prior work hasn't moved yet.
- No plan-move at all. Too restrictive; engineers genuinely start plans on main then realize
  they want isolation.

### D-003 — "New Plan" is the branch creation primitive, never "New Branch"

**Decided 2026-05-27.** Users never see a "create branch" UI action. They create plans. The
plan creation flow asks whether to use an existing branch or create a new one; the branch
name is system-derived (`${author}_<kebab-slug>`) and never user-typed.

**Why:** branches are an implementation detail of isolation. Surfacing them as a first-class
object invites confusion about what they mean and when to create them.

### D-004 — Drag-to-incorporate is tracked and agent-mediated; drag-to-fork is the pure copy

**Decided 2026-05-27.** Two distinct drag operations with distinct drop targets:
- **Drag-to-fork** (drop onto blank area of My Plans panel): copy-paste, `forked_from` in
  frontmatter. Already designed in `plans-harness-scoped-2026-05-24`; carried forward unchanged.
- **Drag-to-incorporate** (drop onto an existing plan card in My Plans): opens agent console
  to propose edits; `incorporated_from` array in frontmatter recorded on success.

**Why:** the user described two meaningfully different operations ("copy" vs. "merge their ideas
into mine"). Visual and semantic distinction allows reasoning about plan provenance. Tracking
`incorporated_from` enables "what influenced this plan" queries.

### D-005 — Contribute-to-others: contrib branch, PR targets plan branch, pending_done until merge

**Decided 2026-05-27.** When user A runs a feature from user B's plan:
- Code commits go to `contrib/<A>/<plan-id>/<feature-id>`.
- PR opens targeting B's plan branch (the `branch` field in the plan frontmatter), not main.
- Feature stays `pending_done` until B merges the PR.
- Distributed claim prevents another user from working the same feature simultaneously.

**Why:** gives B full control over what lands on their plan branch while letting A contribute
immediately. B's auto-approve settings apply consistently to all contributions (their own
agent runs and third-party contributions use the same PR gate).

### D-006 — "Builds" dropdown: per-harness command registry, inline terminal

**Decided 2026-05-27.** Dropdown label is "Builds" (not "Environments" — they are commands,
not infrastructure definitions). Default entries: "testing" and "prod". Each entry runs a
shell command in an inline terminal panel that opens in the UI. Configurable per-harness in
the Settings tab. Configuration stored in harness config (PG for private harnesses; Hyperbee
for shared harnesses).

### D-007 — PR hierarchy: contributor → plan branch → main; no feature-level or plan-level main PRs

**Decided 2026-05-27.** Supersedes the user-branch PR model from dogfood-v5. Exactly two PR
levels:
1. **Contributor PR**: code branch → plan branch. Reviewed by plan owner using their PR
   merge settings (auto-approve threshold, required tests).
2. **Integration PR**: plan branch → main. Reviewed by repo owner / harness PR settings.

No feature-level PR to main. No plan-level "publish" action that bypasses the plan branch
step. The branch is the coherence unit for main integration.

**Why:** two clear gates catch different classes of problems. The contributor PR is where
"does this code do what the feature requires?" is answered. The integration PR is where
"is this branch ready to ship?" is answered. Collapsing them would skip one of those reviews.
