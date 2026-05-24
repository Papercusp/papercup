---
title: Plans become harness-scoped, author-owned, fork-on-drag
slug: plans-harness-scoped-2026-05-24
status: draft
created: 2026-05-24
updated: 2026-05-24
owner: avi@storewolf.com
---

# Plans become harness-scoped, author-owned, fork-on-drag

## Now

**State:** **draft.** Carved out of the `papercusp-dogfood-v5` arc (addendum 2)
during the design-review pass so the architecture rework of plans
can be reviewed independently before it lands in v3. The collab
substrate from v3 (HYPERBEE sync, author pubkeys, shared.json,
git-as-sync for code) is the prerequisite; this doc only adds the
plan-specific behavior on top.

**Next action:** user sign-off on this doc, then split into per-phase
execution work and slot the phase tasks into the v3 timeline (Phase
5a or 5b — after the Hyperbee substrate, alongside or just before
the Plans pane UI work).

## Background

Today, plans live at `apps/operator/docs/plans/*.md`, owned by the
workspace. One canonical directory; every plan is implicitly
"everyone's plan." This fits the single-engineer model but breaks as
soon as a harness becomes shared:

- Two engineers planning different approaches to the same feature
  have nowhere to put their separate plans.
- The "decisions of record" function of a plan (D-NNN entries) is in
  permanent tension with multiple engineers wanting to amend.
- There is no way to take inspiration from someone else's plan
  without overwriting theirs.

The user's framing: **per-user worktree, per-user plan-set; no
canonical decision-of-record across forks; truth is what lands on
`main`.** Disagreement between contributors is fine. This doc lays
out the architecture for that shift.

## Goals

1. **Plans become harness-scoped.** Each harness owns its own plan
   set, replacing the workspace-scoped directory for shared harnesses.
2. **Plans are author-owned.** Only the author of a plan can edit it.
   Everyone in the harness can read.
3. **A Plans pane in the harness sidebar.** Same shape as Features:
   lists all plans by all contributors, filterable.
4. **Drag-to-fork.** Dragging another contributor's plan into your
   own plan list creates a new plan in your worktree, body
   copy-pasted from the original, `forked_from` recorded in
   frontmatter. From there it diverges; the original is unchanged
   and the fork is editable like any plan you authored.
5. **Existing tooling stays intact for private harnesses.** The
   filesystem-backed `plans:*` tools keep working for single-engineer
   harnesses. Only shared harnesses route to the new Hyperbee path.

## Non-goals

- **No canonical "decisions of record" surface across forks.** Each
  fork keeps its own decisions; the harness has no merged decision
  history. (`harness_decisions` from v5 §7.2 stays as it is: a
  separate per-harness shared store for harness-level decisions
  independent of any one plan.)
- **No merge tooling.** If Alice updates her plan after Bob forked
  it, Bob does not "pull" updates. If Bob wants Alice's later
  changes, he asks an LLM to merge by hand. Forks are independent
  documents.
- **No fork-the-world cascade.** Forking Alice's plan does NOT fork
  the documents it references. References stay string-identical
  (`[[harness_decisions/auth-spec]]`) and resolve against current
  harness state at read time.
- **No plan-queue ordering primitive in v1.** The Plans pane lists
  plans by some sensible default (author + recency). Custom user
  ordering can be added later as LOCAL preference; not needed now.
- **No multi-author plans.** A plan has one author pubkey for its
  lifetime. Co-authoring happens via fork-and-merge-by-LLM, not
  shared write.

## Done

This work ships when:

- A shared harness has a working Plans pane in its sidebar showing
  every contributor's plans.
- Author-only edit enforcement is live: peer attempts to edit
  another author's plan are detected and badged as tampered.
- Drag-to-fork works end-to-end: dropping a peer's plan into your
  column produces a new plan in your worktree with `forked_from` set
  and qualified D-IDs.
- The workspace's existing Papercusp plans have been migrated into
  the `papercusp` harness's HYPERBEE plan store.
- Private harnesses still use the existing filesystem-backed
  `plans:*` tools, unchanged.

## Design

### §1 — Storage: one HYPERBEE table

For shared harnesses, plans live in a single HYPERBEE table:

```ts
plans {
  plan_id:        string,        // <slug>-<date>[-<fork-id>], stable forever
  harness_slug:   string,        // implicit; the table is per-harness
  author_pubkey:  string,        // edits enforced server-side against this
  body_markdown:  string,        // the full plan doc, including ## Revisions
  forked_from:    string | null, // <source_plan_id> when this is a fork
  created_ts:     number,        // epoch ms
  updated_ts:     number,        // epoch ms; bumped on every author edit
}
```

No separate `plan_revisions` table. Plan revision history continues
to live where it lives today: inside the markdown, in the plan's
`## Revisions` section. Every edit appends a revision block in the
body itself. `plans:history` reads the markdown; nothing new to
build for history surfacing.

No per-user `plan_queue` table. The Plans pane queries `plans`
filtered by harness, ordered by author + recency (or by
`forked_from` chain when showing a derivation tree). If custom
ordering becomes a real need it can live in a LOCAL preferences
table later; HYPERBEE-syncing per-user UI ordering is over-design
for the v1 use case.

### §2 — Two paths, selected per call

The `plans:*` tools (existing — `plans:get`, `plans:list`,
`plans:set-content`, `plans:add-decision`, `plans:history`, etc.)
keep their public shape: same names, same arguments, same return
types, same markdown body format. Internally they dispatch on the
harness's `state` field (`private` / `shared-private` /
`shared-public`):

- **Private harness:** existing filesystem-backed implementation,
  unchanged. Reads/writes `apps/operator/docs/plans/*.md` in the
  harness's worktree.
- **Shared harness:** new Hyperbee-backed implementation. Reads/writes
  the `plans` HYPERBEE table. Same markdown body, same lint rules,
  same revision-section convention. Author-only enforcement applied
  on writes.

Selection is per-invocation, not a global flag. No environment
variable; no migration of single-engineer harnesses to the new path.

### §3 — Author-only edit enforcement

Author-only is enforced operator-side, with peer-side tamper
detection:

- **Write path:** every `plans:set-content` /
  `plans:add-decision` / etc. call against a shared harness checks
  `caller_pubkey === plans[plan_id].author_pubkey`. Mismatch →
  reject with a clear error. The caller's operator never writes to
  HYPERBEE in this case.
- **Read path / peer side:** a peer receives a HYPERBEE row update
  for plan X. It verifies the writer's pubkey matches
  `plans[X].author_pubkey` from the prior state. If mismatched —
  meaning a peer's operator bypassed the local check and wrote
  anyway — the update is **dropped** locally and the plan is
  rendered with a `tampered` badge so the user sees something
  happened. Original `author_pubkey` value is the authority; first
  writer wins.

This gives a soft trust model: a malicious local operator can write
to its own Hyperbee log, but every other peer drops the row on
arrival. The plan body other peers see stays correct.

### §4 — LWW for same-author multi-device

Author-only edit gating means cross-author conflicts are impossible.
The only conflict path is the same author editing the same plan from
two devices while offline. This is rare and self-inflicted: the
author knows they did it.

Resolution: LWW on `updated_ts`. UI surfaces with a soft toast —
"this plan was edited from another of your devices; the most recent
edit was kept." No clobber-detection infrastructure, no merge UI; the
author can see both bodies in their device-local revision history
and re-edit if needed.

### §5 — Fork mechanics

Drag-to-fork is mechanically a copy-paste:

1. User drags peer's plan into their own plan list in the sidebar.
2. Operator generates a new `plan_id` — convention: append
   `-fork-<short-hash>` to the source slug, e.g. `auth-2026-05-24`
   forked by Bob becomes `auth-2026-05-24-fork-7f3a`.
3. New plan row is inserted into the HYPERBEE `plans` table with:
   - `plan_id`: new id from step 2.
   - `author_pubkey`: forking user's pubkey.
   - `body_markdown`: copy of source plan's body, with the
     transformations described below.
   - `forked_from`: source `plan_id`.
   - `created_ts` / `updated_ts`: now.
4. Body transformations applied during the copy:
   - All `D-NNN` decision IDs in the body are rewritten to
     `D-NNN@<fork-id>` (where `<fork-id>` is the suffix from step 2,
     e.g. `7f3a`). This keeps original decision text intact, makes
     fork-scoped identity unambiguous, and prevents ID collision
     with the original plan's continuing decision history.
   - All `P-NNN` item statuses are reset to `todo`. In-flight items
     in the source plan reflect work the original author is doing;
     they should not appear as in-flight for the fork's new author.
   - A `Forked from [[<source_plan_id>]] at <ts>` line is prepended
     to the body (or inserted in a standard location — the plan
     format spec should pick the convention).
5. References to other documents in the body (e.g.
   `[[harness_decisions/auth-spec]]`) are left string-identical.
   They resolve against the harness's current state at read time —
   not against any snapshot. If the referenced doc later changes or
   is deleted, the fork sees the current state (or a broken-link
   marker if deleted).

From this point on, the fork is a normal plan owned by its new
author. Edits are author-only-gated as usual. The original plan is
unchanged and unaware of the fork (other than appearing in any "who
has forked this?" query, which is just a `WHERE forked_from = X`
scan on the `plans` table).

### §6 — Sidebar Plans pane

New left-sidebar pane in the harness UI, parallel to the existing
Features pane. Same layout patterns. Filters: by author, by
`forked_from` chain (show derivation tree), by status from
frontmatter (`draft` / `active` / `shipped` / `superseded`),
free-text search of body.

Drag-and-drop interaction: drop target is the pane itself for
forking-into-your-list. The drag source can be any plan card in the
pane; only the act of dropping it into your column triggers the fork
creation (clicking into a peer's plan to read it does not fork).

### §7 — Migration of existing workspace plans

One-time migration as part of creating the `papercusp` harness in
Entry 3 (existing local repo):

- Every existing `apps/operator/docs/plans/*.md` is read.
- Each plan's frontmatter `owners` field is inspected. If owners
  resolves to a known contributor pubkey for the new `papercusp`
  harness, the plan's `author_pubkey` is set to that.
- Plans with no resolvable owner are attributed to a sentinel
  pubkey (`migration_pubkey`), labeled in the UI as "imported,
  legacy" and read-only.
- The plans are written to the new HYPERBEE `plans` table under the
  `papercusp` harness.
- The filesystem `apps/operator/docs/plans/` directory is left in
  place for one transition period (1-2 releases) as a read-only
  reference; subsequent writes go only to HYPERBEE. After the
  transition window, the directory is removed.

## Decisions

### D-001 — Plans for shared harnesses are HYPERBEE-stored markdown; private harnesses unchanged

**Decided.** Shared harnesses route `plans:*` tools to a Hyperbee
backend; private harnesses keep the existing filesystem backend.
Same tool surface, dispatched on harness `state` per call.

**Why:** sub-second sync for live planning UX; preserves the
existing toolchain for single-engineer use; isolates new complexity
to the shared path.

**Alternatives rejected:**
- GIT-bucket plans (file-per-row, propagated by git-as-sync). Loses
  the live-pane UX the Plans sidebar wants.
- Workspace-scoped plans with author column. Doesn't solve the "two
  engineers, separate approaches" problem; same canonical-truth
  tension.

### D-002 — Plan history lives in the markdown body, not a separate table

**Decided.** No `plan_revisions` HYPERBEE table. Every plan edit
appends a revision block to the plan's existing `## Revisions`
section in the markdown. `plans:history` reads the body.

**Why:** the plan-format spec already accommodates this; revision
history stays human-readable inside the doc; one less table to
build, sync, and reason about.

### D-003 — Author-only edit gate with peer-side tamper detection

**Decided.** Writes through `plans:*` tools check
`caller_pubkey === author_pubkey`; mismatched writes reject. Peers
verify on receive and drop mismatched HYPERBEE updates with a
`tampered` badge in the UI.

**Why:** soft trust model that matches the rest of v3. A malicious
local operator can't poison other peers; first-author-wins is the
default invariant.

### D-004 — Same-author multi-device conflicts resolved LWW with a soft toast

**Decided.** No clobber-detection or merge UI. Last-writer-wins on
`updated_ts`; toast informs the author.

**Why:** author-only edits make this the only possible conflict
class; same-author conflicts are rare and self-inflicted; the author
has the device-local history to recover if needed.

### D-005 — Drag-to-fork is a copy-paste; original is immutable from the fork

**Decided.** Dragging peer's plan creates a new plan in the
forking user's worktree, body copy-pasted, `forked_from` set,
D-IDs qualified, P-NNN statuses reset to `todo`. No subsequent
sync between original and fork.

**Why:** matches the user's mental model ("just a copy-paste fork");
no merge mechanics to design; original author is not surprised by
fork activity; fork author has full editorial freedom.

### D-006 — Decision IDs in forks are qualified as `D-NNN@<fork-id>`

**Decided.** Fork's body keeps original decision text but rewrites
every `D-NNN` to `D-NNN@<fork-id>` where `<fork-id>` is the fork's
suffix.

**Why:** prevents the ambiguity of "two plans in the same harness
both have `D-001 — auth uses Argon2`" once the original evolves
independently. Preserves original text + author intent; makes
fork-scoped identity unambiguous; costs almost nothing at write
time.

**Alternatives rejected:**
- Forks reference original D-IDs immutably (Bob's fork can't edit
  Alice's D-001, only add new). Too limiting; defeats the
  copy-paste fork mental model.
- Accept the ambiguity (no qualification). Confusing for any third
  reader.

### D-007 — Workspace's existing plans migrate into the `papercusp` harness

**Decided.** As part of creating the `papercusp` harness in v3
Entry 3, all existing `apps/operator/docs/plans/*.md` are imported
into the harness's HYPERBEE `plans` table. Authorship attributed
via frontmatter `owners` field; unattributable plans assigned to
a `migration_pubkey` sentinel and marked legacy/read-only.

**Why:** all existing plans are Papercusp work; the new `papercusp`
harness is where they belong post-shift. No reason to leave them in
the workspace-scoped legacy directory.

## Open questions

### Q-1 — Should forks of forks be allowed?

If Bob forks Alice and Carol then forks Bob, Carol's plan body has
D-IDs qualified as `D-NNN@bob-7f3a` (from Bob's fork). When Carol
forks it, do those become `D-NNN@bob-7f3a@carol-2c9d`? Or do they
re-base to `D-NNN@carol-2c9d`? The first preserves chain
provenance; the second is simpler to read.

Implementing agent should pick. My lean: re-base (second option) —
the `forked_from` chain already captures derivation; nested D-IDs
become unreadable fast.

### Q-2 — What does the Plans pane show by default?

Options: every plan in the harness (potentially noisy in a 10-person
harness with 50 plans); just my plans; my plans + plans I've forked
from; "trending" plans by some recency/activity heuristic. The
default shapes user behavior — pick deliberately.

### Q-3 — Should there be a "show derivation tree" view?

If a popular plan has 5 forks, surfacing the fork tree (`Alice's plan →
[Bob's fork, Carol's fork, Dan's fork]`) helps a new reader find
the variants. Probably worth building, but not v1. Flag for later.

## Phases — rough, not committed

Sized assuming the dogfood-v5 substrate is in place (HYPERBEE +
shared.json + author pubkeys + the `state` field on harnesses).

### Phase 1 — HYPERBEE plans backend + dispatch [M]

- Define `plans` HYPERBEE table schema.
- Implement Hyperbee-backed implementation of `plans:get`,
  `plans:list`, `plans:set-content`, `plans:add-decision`,
  `plans:history`, `plans:lint`, etc.
- Wire the per-call dispatch in the `plans:*` tools based on
  harness `state`.
- Unit tests covering both paths against identical input.

### Phase 2 — Author-only enforcement [S]

- Server-side write gate in the Hyperbee path.
- Peer-side tamper detection on receive.
- `tampered` badge in the UI.

### Phase 3 — Plans sidebar pane [M]

- Sidebar pane component, parallel to Features.
- Filters (author, status, free-text).
- Drag-and-drop handler.

### Phase 4 — Drag-to-fork [M]

- Fork creation flow (new plan_id, body copy + transformations,
  HYPERBEE insert).
- D-ID qualification.
- P-NNN status reset.
- "Forked from" header insertion.
- `forked_from` chain query for showing derivation.

### Phase 5 — Migration of existing workspace plans [S]

- One-time migration script run as part of `papercusp` harness
  creation.
- Authorship attribution + sentinel pubkey for unattributable plans.
- Legacy-read-only flag in the UI for migrated plans without clear
  authorship.

### Phase 6 — Toolchain validation + cleanup [S]

- Verify all existing `plans:*` tool consumers (plan-agent-launch
  flow, plans UI in operator, MCP surface) work identically against
  both backends.
- Decommission the filesystem `apps/operator/docs/plans/` directory
  after the transition window.

## Cross-references

- `papercusp-dogfood-v5-2026-05-23.md` — the parent arc. v5's
  addendum 2 already carries the one-paragraph deferral note pointing
  here; until this plan lands, plans remain workspace-scoped exactly
  as today.
- `proxy-witness-pattern-2026-05-24.md` — sibling stub from the
  same review pass. Unrelated subject (spend / tier-B stats
  substrate), but lives in the same "carved out of v3" cohort.
- `agent-coordination-architecture-v2-2026-05-20.md` — agent
  identity / `ownerId` resolution, which the author-only gate
  builds on.
