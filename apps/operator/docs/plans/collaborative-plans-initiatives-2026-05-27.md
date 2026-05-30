---
title: Collaborative plans — initiatives as the grouping primitive
slug: collaborative-plans-initiatives-2026-05-27
status: draft
created: 2026-05-27
updated: 2026-05-27
owner: avi@storewolf.com
---

# Collaborative plans — initiatives as the grouping primitive

## Now

**State:** Draft. Supersedes the branch-organization model in
`collaborative-plans-multi-branch-2026-05-27`. Design settled in a 2026-05-27
review session; this doc captures the conclusions and the code-audit findings
from that session. Several phases are hard-blocked on the (still-draft)
Hyperbee-plans substrate — see **Prerequisites & risks**.

**Next:** human sign-off on the model (D-001…D-004 especially), then resolve the
blocked-by on `plans-harness-scoped-2026-05-24` before scheduling Phase 1.

## Background

The predecessor plan (`collaborative-plans-multi-branch-2026-05-27`) made the
**git branch the grouping *authority*** — a plan was in a group because its
commits lived on that branch — and surfaced branches to the user directly: the
user managed branches, assigned plans to them, and moved plans between them by
cherry-picking each shipped feature's `completion_ref` merge SHA. The design
session surfaced three problems with that:

1. **It surfaced branches as a switchable object while also calling them an
   implementation detail** — internally contradictory (old D-003 vs old P-014).
2. **The cherry-pick "move" was the most fragile mechanic in the plan**
   (replaying merge commits across diverged branches) and served the
   least-justified requirement (manual re-grouping).
3. **Git can't represent a grouping that has no code yet** — fatal for a
   plan-first product, where plans are grouped at planning time, before any
   agent writes code.

The resolution: introduce a named **Initiative** as the grouping primitive, with
two constraints that keep it cheap — **each plan belongs to exactly one
initiative**, and the hierarchy is **flat (Initiative → Plans), never a graph**.
This is the predecessor's "one branch → many plans" instinct, but with the group
named (so it exists pre-code) and single-membership (so grouping is one field on
the plan, not a many-to-many record that could drift from git).

**The code structure is unchanged** — still one branch + one worktree per group,
many plans on it. What changes is the **grouping *authority***: a named record,
not the branch, now owns what's grouped, and the branch becomes a 1:1 *derived*
rendering of the initiative. That single flip is what lets a group exist before
any code and makes a membership change a metadata edit instead of git surgery.
So we returned to the branch *structure* of the predecessor — but deliberately
**not** to the branch as the grouping *authority*, which is the part that failed
pre-code and forced the cherry-pick move.

Dependency lives **only inside an initiative**: if two pieces of work depend on
each other they are plans in the *same* initiative (sequential, ordered); if they
don't, they are separate initiatives (parallel, independent). That rule is what
keeps the structure a two-level hierarchy and never a DAG.

**Companion docs:**
- `plans-harness-scoped-2026-05-24` (status: draft) — Hyperbee plan storage,
  author-only edits, drag-to-fork. **Hard prerequisite** for the shared-harness
  and multi-user pieces here. Drag-to-fork is carried forward as a *design*, not
  shipped code.
- `papercusp-dogfood-v5-2026-05-23` (status: draft) — the `user/<github_user_id>`
  worktree model. D-001 here supersedes it as the *grouping* model, but reuses its
  shipped worktree-provisioning code (`ensure-user-branch.ts`).
- `papercusp-dogfood-phase7-pr-lifecycle-2026-05-24` (status: shipped, partial) —
  the two-level PR model, updated by D-008 here (PR targets the initiative branch).

## Goals

1. **Initiative = the grouping primitive.** A named container that exists the
   moment it is created (before any code). Each user gets a default initiative
   (their home) so one-off plans need no ceremony.
2. **Each plan belongs to exactly one initiative**, stored as a single field on
   the plan. Flat two-level hierarchy. No plan↔plan edges, no graph.
3. **One branch + one worktree per initiative.** Plans are the ordered, dependent
   units of work that land on that branch sequentially.
4. **Two create actions, clearly distinct:** "New Initiative" (rare — creates the
   container + branch + worktree) and "New Plan" (common — adds a plan into the
   current initiative).
5. **Two-panel plans UI on the ownership axis** (My Plans / Others' plans),
   independent of the structure axis. My Plans renders as an Initiative → Plans
   outline.
6. **Initiative switcher / build-target picker** that selects an initiative's
   composed state (its branch tip = its worktree), not a raw branch ref.
7. **Drag operations disambiguated by source pane:** fork (theirs → blank),
   incorporate (theirs → my plan), reorder (mine → within initiative),
   move-between-initiatives (mine → another initiative; rare, warn-and-confirm).
8. **Contribute to others' initiatives.** Code lands on a contrib branch; PR
   targets the initiative branch; feature stays `pending_done` until merge;
   distributed claim prevents double-working.
9. **Two-level PR hierarchy:** contributor branch → initiative branch (owner
   review) → main (repo / harness PR settings).

## Non-goals

- **No user-managed branches.** Users never name, create, switch, or assign
  branches. Branches are derived from initiatives 1:1.
- **No plan-move via completion_ref cherry-pick.** Replaced by re-parent = rebase
  (D-006); within an initiative there are no moves, only reordering.
- **No initiative→initiative dependencies.** Cross-initiative work is independent
  by construction (D-011). Keeps the hierarchy two levels.
- **No Builds dropdown in this plan.** Orthogonal; split to its own plan (D-010).
- **No real-time peer code sync.** Code is git-only, pushed at feature completion
  (unchanged from the dogfood arc).

## Phase 1 — Initiative data model

- [todo] P-001: Add `Initiative` record (id, name, owner github_user_id, harness, created_at). Private harness → PG; shared harness → Hyperbee (blocked by `plans-harness-scoped`).
- [todo] P-002: Add `initiative` field to plan frontmatter spec + parser (`parser.ts`). Every plan has exactly one; required.
- [todo] P-003: Provision each user's default initiative (`home`) on harness join, reusing/refactoring `ensure-user-branch.ts`. Branch name system-derived from numeric `github_user_id` (D-005); display name is presentation only.
- [todo] P-004: `plans:new` places the plan in the caller's current initiative; accepts optional `initiative` to target an existing one. No branch argument is ever exposed.
- [todo] P-005: `initiatives:new` verb — creates the container, allocates its branch name, but does NOT provision the worktree yet (lazy, see P-008).
- [todo] P-006: Plan ordering within an initiative (sequence field or explicit order list); used to render the dependent chain and to sequence agent work.

## Phase 2 — Worktree provisioning + orchestrator routing

- [todo] P-007: One branch + one worktree per initiative. Branch forks from `main` at initiative creation.
- [todo] P-008: Lazy worktree materialization — provision on first `plans:start` within the initiative; do not create a worktree for an initiative whose plans are all draft.
- [todo] P-009: Orchestrator routes feature code to the worktree of the plan's initiative. (NEW capability — no branch/worktree routing exists in `lib/orchestrator/` today; this is the largest item, not a field read.)
- [todo] P-010: Single-worktree safety: enforce that at most one plan per initiative is actively worked at a time (the dependent/sequential invariant). Reject/queue a second concurrent start within the same initiative.
- [todo] P-011: Worktree teardown when an initiative is done and fully pushed; never tear down with uncommitted work present.
- [todo] P-012: `plans:start` failure story — if worktree provisioning fails, the plan does NOT flip to started (atomic: PG status + worktree provision succeed together or neither).

## Phase 3 — Plans UI: panes + initiative outline + switcher

- [todo] P-013: Two-panel layout (My Plans / Others' plans) on the ownership axis. Others' panel hidden by default in private harnesses, default-open in shared.
- [todo] P-014: My Plans renders as a two-level outline: initiatives at top level, ordered plans nested beneath. Plan cards keep full detail (status, features).
- [todo] P-015: "New Initiative" action (rare) + "New Plan" action that drops into the currently-selected initiative (common). Branch names never surfaced.
- [todo] P-016: Initiative / build-target picker in the top bar — lists initiatives by name (and `main`), selecting one opens that initiative's worktree/composed state. No `⎇ branch` ref shown.
- [todo] P-017: "Contributing to <user>'s initiative" sticky banner whenever running a feature from another user's initiative.
- [todo] P-018: Others' panel shows peers' initiatives read-only (view + fork/incorporate source only; no structural edits).

## Phase 4 — Drag interactions

- [todo] P-019: Drag semantics dispatched by source pane + drop target:
  theirs→blank = fork; theirs→my-plan-card = incorporate; mine→within-my-initiative = reorder; mine→another-of-my-initiatives = move (warn).
- [todo] P-020: Drag-to-fork (theirs → blank area of My Plans) — copy, `forked_from` in frontmatter, lands as a new (or current) initiative. Carries `plans-harness-scoped` design forward; net-new code.
- [todo] P-021: Drag-to-incorporate (theirs → one of my plan cards) — opens a plan-agent-launch console: "Incorporate [source] into [target]." On completion, append `incorporated_from` to target frontmatter.
- [todo] P-022: Reorder a plan within its initiative (drag within the nested list) — updates the ordering only; no git op.
- [todo] P-023: Move a plan between initiatives (mine → another initiative) — rare, warn-and-confirm. Re-parents the plan's commits via `git rebase --onto` (D-006), never completion_ref cherry-pick. Blocked while the plan has an in-flight feature.

## Phase 5 — Contribute-to-others + PR hierarchy

- [todo] P-024: Running a feature from another user's initiative writes code to `contrib/<github_user_id>/<initiative-id>/<feature-id>` (numeric id per D-005).
- [todo] P-025: Contributor PR targets the owner's **initiative branch** (not main, not a per-plan branch).
- [todo] P-026: Owner receives the PR via the existing coordination notify path (`lib/agent-tools/coordination/subscriptions.ts`), NOT a bespoke "Hyperbee notify."
- [todo] P-027: Owner's PR merge settings (auto-approve threshold, required test gates) apply uniformly to their own agent runs and to third-party contributor PRs on their initiative branch.
- [todo] P-028: Feature stays `pending_done` until the contributor PR merges; flips to `shipped` via `completion_ref` stamp on merge (existing verifier daemon).
- [todo] P-029: Distributed claim (dogfood Phase 6, `lib/orchestrator/distributed-claim.ts`) prevents two contributors working the same feature simultaneously.
- [todo] P-030: Integration PR: initiative branch → main, reviewed by repo owner / harness PR settings. The branch is the coherence unit for main integration.

## Phase 6 — Doc updates + supersessions

- [todo] P-031: Mark `collaborative-plans-multi-branch-2026-05-27` superseded; cross-reference D-001…D-011 here.
- [todo] P-032: Update `papercusp-dogfood-phase7-pr-lifecycle-2026-05-24` for the initiative-branch PR target (D-008).
- [todo] P-033: Add a decision to `papercusp-dogfood-v5-2026-05-23` recording the initiative grouping model superseding the per-user worktree *grouping* (D-001), while noting its worktree-provisioning code is reused.
- [todo] P-034: Spin out a separate plan for the Builds dropdown (D-010) — unblocked, independent of this arc.

## Prerequisites & risks

**Hard prerequisite (blocking Phases 1 shared-harness, 3, 4, 5):**
`plans-harness-scoped-2026-05-24` (Hyperbee plan storage) is **status: draft and
unimplemented**. Plans today are file-based (`apps/operator/docs/plans/*.md` +
PG `harness_shared.harness_plan_status`); per dogfood-v5 §101, "until that lands,
plans remain workspace-scoped exactly as today." The two-panel multi-user model
cannot ship until Hyperbee plan storage lands and the Phase 5b flag is flipped.
Private-harness, single-user pieces (P-002…P-012) can proceed on the file/PG path.

**Verified-present foundations (audit, 2026-05-27):**
- `completion_ref` + verifier daemon — real (`lib/harness/completion-ref-verifier.ts`).
- Distributed claim — real (`lib/orchestrator/distributed-claim.ts`).
- Per-user worktree provisioning — **shipped**, numeric-id keyed
  (`lib/harness/ensure-user-branch.ts`, `user-tree-types.ts`); P-003 refactors it.
- pty/terminal infra — present (`pty-bridge.ts`, `pty-ws.ts`) — relevant to the
  split-out Builds plan, not this one.

**Open risks:**
- **Orchestrator worktree routing (P-009) is greenfield.** No branch/worktree
  selection exists in `lib/orchestrator/` today; this is the largest single item.
- **Sizing.** Comparable dogfood phases were sized at 7–10 weeks each. The flat
  item lists hide variance; P-009 and the Phase 3 UI are each substantial.
- **Move-between-initiatives (P-023)** still touches git history (rebase --onto).
  It is rarer and safer than the old cherry-pick, but not free; gate it behind
  in-flight checks and confirmation.

## Decisions

### D-001 — Initiative is the grouping primitive

**Decided 2026-05-27.** A named **Initiative** groups plans. It supersedes both
the `user/<github_user_id>` grouping from dogfood-v5 and the user-managed-branch
grouping from `collaborative-plans-multi-branch-2026-05-27`. An initiative exists
as a record the moment it is created — before any code — which is the property a
bare git branch cannot provide and the reason a named object is used.

**Why:** plans are the collaboration unit, and grouping happens at planning time
(pre-code). A git branch has no representation until commits exist, so
branch-as-grouping is backwards for a plan-first product. A named record fixes
that without (given D-002) reintroducing dual-write.

**Alternatives rejected:**
- *Branch as the grouping (predecessor plan).* Single source of truth, but cannot
  exist before code; membership edits become git surgery.
- *Pure plan→plan dependency forest (no named group).* Works, but offers no
  pre-code, nameable, switchable handle for "this body of related work."

### D-002 — Each plan in exactly one initiative; flat two-level hierarchy

**Decided 2026-05-27.** A plan belongs to exactly one initiative, stored as a
single `initiative` field on the plan. The hierarchy is strictly two levels
(Initiative → Plans). There are no plan↔plan edges and no graph.

**Why:** single-membership makes grouping *one field* (not a many-to-many record),
so there is nothing to keep in sync with git — the field is the truth for
grouping, the branch is the truth for code, and they map deterministically. Flat
two-level rendering is a solved UI problem (outline), avoiding any graph canvas.
These two constraints are exactly what make the named-object approach cheap.

### D-003 — One branch + one worktree per initiative; plans are sequential

**Decided 2026-05-27.** Each initiative has one branch (forked from `main`) and
one worktree. Plans are the ordered, dependent units of work that land on it
sequentially. Worktrees are materialized lazily (on first `plans:start`) and only
for initiatives with active work.

**Why:** "all plans in an initiative depend on each other" implies they are worked
**sequentially** — only one plan active at a time — which is exactly what makes a
single shared worktree safe (two agents in one worktree would stomp each other's
files). Parallel *initiatives* are separate worktrees, hence isolated. The model's
safety falls out of its own dependency rule. Disk cost is bounded by the number of
*active* initiatives, not total plans.

### D-004 — Two distinct create actions; default initiative is the user's home

**Decided 2026-05-27.** "New Initiative" (rare) creates the container + branch +
worktree. "New Plan" (common) adds a plan into the current initiative. Every user
has a default initiative (their home) so a one-off plan needs no ceremony — it
just lands there. Users never see a "New Branch" action.

**Why:** conflating the two (as an earlier draft of this doc did) is the source of
confusion. Separating them keeps the common path one click and the rare path
explicit. The default initiative is the honest, named successor to the
predecessor's `${userName}_main` default branch.

### D-005 — Identity key is numeric github_user_id; display name is presentation

**Decided 2026-05-27.** All branch and contrib-path identity uses the numeric
`github_user_id`, consistent with shipped code (`user-tree-types.ts`,
`ensure-user-branch.ts`) and dogfood-v5 §108's anti-Sybil/anti-rename rationale.
Human-readable display names (e.g. an initiative titled "avi / Auth rework") are
presentation only and never part of a git ref.

**Why:** the predecessor plan used login/username in `${userName}_main` and
`contrib/<username>/…`, which breaks on GitHub login rename — the exact failure
the numeric convention was built to avoid. This resolves audit gap A.

### D-006 — Move = rebase, not completion_ref cherry-pick

**Decided 2026-05-27.** Moving a plan between initiatives re-parents its commits
with `git rebase --onto`, gated on the plan having no in-flight feature and a
warn-and-confirm. Within an initiative there are no moves — only reordering, which
is a metadata change with no git op. The predecessor's "cherry-pick each shipped
feature's `completion_ref` merge SHA in chronological order" is dropped.

**Why:** cherry-picking *merge commits* across diverged branches requires mainline
parent selection and conflicts routinely; it was the most fragile mechanic in the
predecessor and served a rare operation. Rebase is the clean primitive for
re-parenting a line of work, and single-membership makes cross-initiative moves
rare by construction.

### D-007 — Drag semantics disambiguated by source pane

**Decided 2026-05-27.** A drop's meaning is determined by where the dragged card
came from and where it lands: theirs→blank = fork; theirs→my-plan-card =
incorporate; mine→within-my-initiative = reorder; mine→another-of-my-initiatives =
move. The existing ownership-pane split provides the disambiguation for free.

### D-008 — Two-level PR hierarchy: contributor → initiative branch → main

**Decided 2026-05-27.** Exactly two PR levels: (1) contributor branch →
**initiative branch**, reviewed by the initiative owner with their merge settings;
(2) initiative branch → main, reviewed by repo owner / harness PR settings. No
feature-level or plan-level PR to main. Carries the predecessor's D-007 forward,
retargeted from "plan branch" to "initiative branch" (since the branch is now
per-initiative). Notifications use the existing coordination subscriptions path,
not a bespoke channel.

**Why:** two gates answer two different questions — "does this code meet the
feature?" (contributor PR) and "is this initiative ready to ship?" (integration
PR). The initiative branch is the coherence unit for main integration.

### D-009 — Contribute flow

**Decided 2026-05-27.** Running a feature from user B's initiative: code goes to
`contrib/<A-github_user_id>/<initiative-id>/<feature-id>`; PR targets B's
initiative branch; the feature stays `pending_done` until B merges; distributed
claim prevents concurrent double-working. Carries the predecessor's D-005 forward,
retargeted to the initiative branch and numeric identity (D-005).

### D-010 — Builds dropdown is out of scope (separate plan)

**Decided 2026-05-27.** The "Builds" dropdown (run a configured shell command in
an inline terminal) is orthogonal to the collaboration model — it only shared the
top bar. It is small, unblocked, and depends on none of this arc's substrate. It
is removed here and spun out as its own plan (P-034). Note for that plan: in
shared harnesses, build commands are configured by one user and executed by
others, so it needs a configure-vs-run authz decision.

### D-011 — No initiative→initiative dependencies

**Decided 2026-05-27.** Initiatives are independent and all fork from `main`.
Dependency exists only *within* an initiative (between its plans). If one
initiative appears to need another's code, either they are really one initiative
(merge them) or it is a transient "build both together" preview — never a durable
cross-initiative edge.

**Why:** allowing initiatives to depend on initiatives rebuilds the very graph the
two-level constraint (D-002) was chosen to avoid.
