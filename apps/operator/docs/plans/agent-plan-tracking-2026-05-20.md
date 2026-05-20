---
title: Agent plan tracking — a markdown-canonical plan system for SU agents
slug: agent-plan-tracking-2026-05-20
status: shipped
created: 2026-05-20
updated: 2026-05-20
owner: pandawamble@gmail.com
---

# Agent plan tracking

A markdown-canonical plan format + `plans:*` tool surface so SU agents
can browse, status-track, and cold-resume work-in-flight plans without
a human re-briefing them. Built for the **engineer-collaborator** side
of Papercusp, not the autonomous harness.

## 1. Problem

Two concrete, observed problems.

### 1.1 Plans aren't discoverable by agents

`CLAUDE.md` and agent-policies §17 tell agents: "look in
`apps/operator/docs/plans/` first" for prior design history. But the
`docs:*` MCP tools (`docs:outline`/`get`/`search`) are wired to
**fumadocs**, which loads from `apps/operator/content/internal-docs/`
— a different tree. There is no verb that reads `docs/plans/`. Agents
are told to use a directory they have no tool to read.

Verified:

- `apps/operator/lib/agent-tools/docs/` — the `docs:*` tool impl.
- `apps/operator/content/internal-docs/` — what `docs:*` actually
  scans.
- `apps/operator/docs/plans/` — where plans actually live, invisible
  to `docs:*`.

### 1.2 Agents are inventing ad-hoc progress artifacts

Because the format is unstructured, every active plan has accumulated
sidecar files with no shared shape. Real examples currently in
`docs/plans/`:

- `sse-typed-events-2026-05-12.md` + `-HANDOFF.md` + `-PR-SPLIT.md` +
  `-rebase-note-from-main.md` + `-rebase-note-from-main-round11.md`
  (5 files for one plan).
- `llm-testing-framework-2026-05-14.md` + `-DECISIONS.md` +
  `-handoff-2026-05-14.md` + `-phase1-status-2026-05-14.md` +
  `-status-2026-05-14.md` (5 files).
- `deck-panel-design-audit-2026-05-14.md` + `-followup-` +
  `-round3-` + `-round4-` + `-round5-` (5 files).
- Stand-alone: `handoff-2026-05-14-e2e-audit.md`,
  `deferred-followups-2026-05-14.md`.

The shapes agents keep reinventing — *current state*, *decisions
made*, *handoff to next shell*, *what's deferred* — are the same four
shapes every time. They belong **inside one plan file**, in
predictable sections a parser can read.

### 1.3 Plans are dispersed across the repo

Beyond `docs/plans/`, plan-shaped files live in:

- `apps/operator/docs/*-plan.md` (5 loose: agent-action-registry,
  dockview-migration ×3, ui-control).
- `apps/operator/docs/archive/agent-action-registry-plan.v{2,3,4}.md`.
- `apps/operator/content/internal-docs/design/*-plan.mdx` (4 design
  plans — already in fumadocs; arguably finished design docs, leave
  in place).
- `docs/eager-fetch-refactor-plan.md`, `docs/un-hardcode-plan.md`
  (repo-root `docs/`).
- `PLAN-operator-arc-2026-05-12.md` (repo root).
- `design-tokens/IMPLEMENTATION_PLAN.md`.
- `libs/papercusp/libs/db/UNLOCKS-PLAN.md`.

Exact counts are produced by the inventory step in §8 — not asserted
here.

## 2. Goals / non-goals

### Goals

- **Cold-resume**: an agent dropped into a session can read one file
  + decision log and know the current state, the next concrete
  action, and what's already been decided.
- **Browsable by agents**: a `plans:*` MCP surface, sibling to
  `docs:*`, with `list / get / items / search` reads.
- **Hand-editable by humans**: plans stay markdown, opened in any
  editor, reviewed in PRs. Tools are a view + assisted writes, not a
  gatekeeper.
- **No new substrate**: filesystem is canonical (see D-002), no PG
  tables, no sync layer.
- **Concurrency-safe writes**: every write verb integrates with the
  shipped `locks:*` system (see §4.4).
- **Graceful degradation**: ~46 existing plans don't need rewriting
  on day one. The parser treats them as `legacy`; tools still list
  them; lint exempts them.

### Non-goals

- A Linear/Jira clone. No estimation, story points, velocity,
  sprints, swimlanes, burndown, priority tiers, epic→story
  hierarchy.
- Sharing code with the harness `features` system (see D-001).
- A live "who's working on this right now" feed inside the plan
  file. That's `locks:queue`'s job; we link, we don't duplicate.
- A "recently completed across all plans" temporal feed (deferred,
  see §11 / §12-Q3).
- An API-only / PG-backed record. Plans are documents (see D-002).

## Now

**State:** All three phases shipped 2026-05-20. 10 plans:* tools live (5 read + 5 assisted-write), 38/38 vitest passing, 0 TS errors, `npm run lint:plans` CI gate wired into `.github/workflows/test.yml`. Tree consolidated: 18 plan files moved into `docs/plans/`, 10 archived, every plan now has frontmatter (0 legacy remaining). CLAUDE.md and agent-policies §18 updated to point at the `plans:*` surface. Spec published at `/internal/docs/spec/plan-format`.

**Next:** plan is done — all 17 active items closed. Future incremental work: flip individual converted-legacy plans from "minimal frontmatter only" to "with `## Now` block filled in" as agents pick them up; lint warns on 59 plans missing `## Now`. `plans:set-now` takes one call per plan, no rush.

## 3. Format spec

One markdown file per plan, named `<slug>-<YYYY-MM-DD>.md`, in
`apps/operator/docs/plans/`. The filename slug is the plan ID — load-
bearing, referenced from other plans.

A plan has four parser-keyed structural parts. Everything else is
free prose.

### 3.1 Frontmatter

```yaml
---
title: <Title Case sentence>
slug: <kebab-case-slug>-<YYYY-MM-DD>   # MUST match filename
status: draft | active | shipped | superseded
created: YYYY-MM-DD
updated: YYYY-MM-DD                     # bumped on every assisted write
owner: <email>                          # human owner; agents don't own plans
supersedes: [<other-slug>, ...]         # optional
superseded-by: <other-slug>             # optional, set when status=superseded
---
```

`status` is the **plan's** lifecycle — different from per-item status
(§3.3).

### 3.2 The `## Now` block — cold-resume anchor

Exactly one section near the top, fixed heading:

```markdown
## Now

**State:** one paragraph describing where the plan currently stands.

**Next:** one sentence — the single next concrete action and who
should do it ("an agent should …" / "human decision needed on …").
```

Parser keys on the heading; a tolerant matcher strips leading
`N. ` / `N.M ` numbering so both `## Now` and `## 3. Now` work.
This is the single most-read field — what an agent loads first on
cold resume.

### 3.3 Items

Items live under `## Phase N — <name>` sections. One item per line,
flat permanent ID, free text after.

Form (ASCII, the canonical form):

```markdown
- **P-007** `todo` Migrate stray plan files into docs/plans/.
- **P-008** `wip` Wire plans:list to filesystem.
- **P-009** `todo` Implement plans:lint. blocked-by: P-008
- **P-010** `needs-human` Decide archive listing default. → D-003
- **P-011** `done` Verify parser handles legacy files.
```

Rules:

- **Permanent flat IDs** — `P-NNN`, never reused, never renumbered.
  Reordering the list never invalidates a reference.
- **Status token** — one of six, lowercase, backticked. See §3.4.
- **`blocked-by:`** — keyword, parser reads it independent of any
  separator glyph. Comma-separated IDs:
  `blocked-by: P-003, P-005`. *Not* a status — see §3.4.
- **Decision refs** — `D-NNN` tokens anywhere in the line; parser
  picks them up by pattern, glyph-agnostic. The `→` arrow is
  cosmetic.
- **Separators are display-only.** Examples may use `·` or `→` for
  human readability; the parser never depends on them. If you type
  `,` / `-` / `->` instead, it still parses.

Items not under a `## Phase N` heading are still parsed but flagged
by lint as "unphased."

### 3.4 Status vocabulary — six tokens, one *computed*

| Token | Meaning |
|---|---|
| `todo` | Not started. Default for new items. |
| `wip` | In progress. The active item. Use `locks:acquire` on the plan file before flipping to `wip`. |
| `blocked` | **External** blocker only — upstream PR, vendor response, awaiting a release, etc. *Not* used for items waiting on other plan items. |
| `needs-human` | A human decision/approval/clarification is required. Surfaces in the **human's inbox** (see §4.3). |
| `done` | Completed and verified. |
| `dropped` | Decided not to do. Keep the line; record the reason in a `D-NNN` decision. |

**Computed-blocked is not a stored token.** An item with
`blocked-by: P-NNN` has *effective* status `blocked` iff any
`P-NNN` referenced isn't `done`. As soon as all blockers are
`done`, the effective status reverts to whatever the item is
stored as (typically `todo`) — automatically, no manual flip.

Why: a stored `blocked` would go stale the moment a blocker
finishes, and the only way to find the staleness is to remember.
Computing it eliminates the bug. The `blocked` token stays
useful for the case markdown genuinely can't compute — an
external blocker — where a human/agent has to explicitly
declare it.

Parser exposes both: `storedStatus` (the literal token) and
`effectiveStatus` (after blocked-by resolution). Most callers
want `effectiveStatus`.

### 3.5 The `## Decisions` log

Append-only. Stable IDs. Tolerant heading match (same as `## Now`).

```markdown
## Decisions

### D-001 — Don't share code with harness `features`
Date: 2026-05-20
Decision: SU plans are standalone. The harness feature system is a
workflow engine for the autonomous side; we share neither schema nor
code. May extract a primitive later if two consumers earn it.

### D-002 — Filesystem-canonical, no PG
Date: 2026-05-20
Decision: …
```

Rules:

- IDs are `D-NNN`, never reused.
- New decisions append; existing ones are never edited (except a
  small `Superseded by D-NNN` line if reversed).
- Items reference decisions by ID; parser surfaces both directions.
- Allocation of the next `D-NNN` happens **inside one lock** on the
  plan file (see §4.4) — read-modify-write must not race.

### 3.6 Optional sections

- `## Background`, `## Scope`, `## Verification` — free prose,
  parser-agnostic.
- `## Open questions` — numbered list of items waiting on a human;
  each Q the human ratifies becomes a `D-NNN` decision.
- `## Deferred follow-ups` — items intentionally not in scope; can
  later be promoted to real items.

### 3.7 Worked example

Filename: `example-feature-2026-05-20.md` (slug = stem).

```markdown
---
title: Example feature
slug: example-feature-2026-05-20
status: active
created: 2026-05-20
updated: 2026-05-20
owner: pandawamble@gmail.com
---

# Example feature

## Now

**State:** Phase 1 in flight. Parser shipped; tools wired.
**Next:** an agent picks up P-007 (consolidation).

## Phase 1 — Tooling

- **P-001** `done` Spec the format. → D-002
- **P-002** `done` Implement parser.
- **P-003** `wip` Implement plans:list/get/items.
- **P-004** `todo` Implement plans:lint. blocked-by: P-003

## Phase 2 — Migration

- **P-007** `todo` Consolidate stray plan files.
- **P-008** `needs-human` Triage active vs stale across legacy plans.

## Decisions

### D-001 — Standalone, not shared with harness features
Date: 2026-05-20
Decision: …

### D-002 — Filesystem-canonical
Date: 2026-05-20
Decision: …
```

## 4. Tool surface — `plans:*`

Lives at `apps/operator/lib/agent-tools/plans/`, sibling of
`docs/` and `locks/`. Same `defineTool` registry, same MCP
projection.

### 4.1 Read verbs

- **`plans:list { status?, includeArchived?, includeLegacy? }`**
  Returns one row per plan: slug, title, status, `updated`, item
  counts by `effectiveStatus`, the `## Now` `Next:` line. Cheap.
  Default: hides `archive/`; includes legacy plans with `status:
  unknown` and no item counts.
- **`plans:get { slug }`** Returns the parsed structure: frontmatter,
  Now block, phases with items (both `storedStatus` and
  `effectiveStatus`), decisions, plus the raw markdown for prose
  sections. Detail view.
- **`plans:items { slug?, status?, actionable?, needsHuman? }`** Item-
  level query across one or all plans.
  - `actionable: true` — `effectiveStatus === 'todo'` (so: stored
    `todo` with all blockers `done`). The "what can I pick up
    right now" query.
  - `needsHuman: true` — `storedStatus === 'needs-human'`. The
    **human's inbox** — first-class affordance (§4.3).
- **`plans:search { query, scope?: ['title','now','items','decisions','prose'] }`**
  BM25 across selected sections; defaults to all.

### 4.2 Assisted-write verbs

These exist so agents can flip status without hand-editing markdown
(and racing on it). They write the exact same on-disk format a human
would type — the file remains canonical.

- **`plans:new { slug, title, status?: 'draft' }`** Creates the file
  from a template, validates slug uniqueness inside one lock.
- **`plans:set-status { slug, itemId, status, note? }`** Flips one
  item's stored status. `note` appended as a same-line trailing
  comment if given.
- **`plans:set-now { slug, state, next }`** Replaces the `## Now`
  block atomically.
- **`plans:add-decision { slug, title, body, refs?: [itemId, ...] }`**
  Allocates the next `D-NNN`, appends. **Read-modify-write inside
  one lock** — see §4.4.
- **`plans:add-item { slug, phase, text, blockedBy?: [itemId, ...] }`**
  Allocates the next `P-NNN`, appends to the named phase.
- All assisted writes **auto-bump frontmatter `updated:`** to today's
  date.

### 4.3 The human's inbox

`plans:items { status: 'needs-human' }` across all plans is a first-
class affordance — agents call it to surface "what only the human can
decide" without dumping irrelevant items. The CLI / harness UI can
render it as a literal inbox view later, but the tool stands alone
first.

### 4.4 Lock integration — **required, not out of scope**

The shipped `locks:*` system (`locks:acquire/release/heartbeat/queue/
cancel_wait`, side database `papercusp_su`, Phases 0-3 complete
2026-05-14) is the concurrency substrate. `plans:*` write verbs **own
their lock integration**:

- The `PreToolUse` auto-lock hook only fires for `Edit/Write/MultiEdit`
  — **not** for MCP tool calls. So `plans:set-status` etc. cannot
  rely on the hook; each write verb must `locks:acquire` itself
  before touching the file.
- Standard lock shape for every write verb:
  ```
  locks:acquire {
    paths: ['apps/operator/docs/plans/<slug>.md'],
    intent: 'plans:set-status P-NNN → done',
    ttl_sec: 60,
    wait: { max_sec: 30 },
  }
  → read file → mutate → write file → locks:release
  ```
- **ID allocation must be inside the same lock as the write.**
  `plans:add-decision` reads max `D-NNN`, allocates N+1, appends.
  Two concurrent calls without a serialized lock collide on the
  number. Same for `plans:add-item` (max `P-NNN`) and `plans:new`
  (slug uniqueness check). All three do read-modify-write atomically
  under the lock.
- **`busy` response** — if lock acquisition fails, the verb surfaces
  the holder's `owner_label` + `intent` + `expires_ts` directly to
  the caller. No silent retry inside the verb; the agent decides
  retry vs pivot.
- **TTL discipline** — write verbs hold for the duration of one RMW
  (`ttl_sec: 60` is conservative). Read verbs never lock.

This is a **contract every write verb must implement**. Tests in
`__tests__/plans/concurrency.test.ts` will assert: concurrent
`plans:add-decision` against the same plan produce sequential
non-colliding IDs.

### 4.5 `plans:lint`

A linter, importable for CI. Read-only. Returns warnings + errors
per plan.

Checks:

- Frontmatter present + valid; `slug` matches filename stem.
- Required sections present (`## Now`, `## Decisions`).
- All item IDs unique; all decision IDs unique; references
  resolve.
- Status tokens in vocabulary.
- `blocked-by` items exist; an item with stored status `blocked`
  has at least one `blocked-by` *and* at least one unresolved
  external reason in the item text — pure "blocked" without a
  source is a smell.
- `updated:` not behind file's git mtime by more than 7 days.
- ASCII-only IDs (`P-NNN`/`D-NNN`); reserved tokens not used as
  free text.

Legacy exemption — see §5.

### 4.6 Discoverability

Tools are registered in `apps/operator/lib/agent-tools/index.ts`
alongside `docs:*` and `locks:*`. `agent_tools:list` enumerates
them automatically. No separate registration step.

The `CLAUDE.md` block in §17 "Find prior work" gets one line
appended: "use `plans:list` / `plans:get` to browse." The doc-text
itself becomes the new canonical pointer.

## 5. Legacy plan behavior

The format is a **new contract**; existing plans don't satisfy it
and we don't break them on day one. Specific behavior:

- A plan is "legacy" if its frontmatter is missing, malformed, or
  lacks the `slug:`/`status:` fields. Detection is purely a parse
  outcome, not a flag.
- `plans:list` includes legacy plans with synthesized
  `status: unknown`, `title` from filename, and **no item counts**
  (since the item format isn't normalized).
- `plans:get` returns frontmatter (if any) + the raw markdown body
  in a single `prose` field. No items, no decisions, no Now block.
- `plans:items` and `plans:search` exclude legacy plans by default
  (they have no parseable items); a `includeLegacy: true` flag
  flips that for `plans:search` only.
- **`plans:lint` exempts legacy plans entirely.** Lint over the
  tree on day one MUST pass; otherwise CI red-fails against ~33
  files we haven't converted yet. Conversion happens via §8b,
  on its own cadence, plan-by-plan.
- `status: unknown` is **parser-synthesized**, never a writable
  value — not in the frontmatter enum.

Promotion: a legacy plan becomes "real" by getting valid frontmatter
+ a `## Now` block + a `## Decisions` section. Items and phases are
optional during conversion — a plan can be `active` with prose and
no items if that's how it stands.

## 6. Archive listing semantics

One tree: `apps/operator/docs/plans/archive/`. The parser is
identical; only the listing rule differs.

- `plans:list` **hides** `archive/` entries by default.
- `plans:list { includeArchived: true }` includes them.
- `plans:get { slug }` resolves both `plans/<slug>.md` and
  `plans/archive/<slug>.md` — i.e. archive doesn't make a plan
  unreachable, it makes it not-listed-by-default.
- `plans:search` searches both by default (the dispersal problem
  was *unfindable*, not *unlisted*).
- A plan with `status: superseded` may live in either location;
  convention: move to `archive/` once nothing actively references
  it.

This deliberately keeps everything plan-shaped under one root so
tooling has one place to look. A separate `docs/archive/` would
quietly reintroduce the dispersal we're fixing.

## 7. Decisions

### D-001 — Don't share code with the harness `features` system

Date: 2026-05-20
Decision: SU plans are standalone. The harness `features` system is
a workflow engine: features decompose into chunks, route through a
fixed role pipeline (scoper → architect → worker → validator →
reviewer → documenter → curator), gate at human approval points,
and live in `harness_features` keyed to schemas per harness.

The autonomous side needs a workflow engine because no human is
watching live — the system must self-drive between gates and be
auditable after. The SU side has the opposite shape: the human is
in the loop *this turn*, steering the agent in chat. The artifact
needed is a **shared memory document**, not a pipeline.

There is one genuinely shared primitive — the *task node* (id +
status + blocked-by + history). It already appears in harness
chunks, and in the SDK-side `TaskCreate/TaskUpdate` tools. We do
not extract it now. Build standalone; revisit only if a third
consumer earns the abstraction.

### D-002 — Filesystem-canonical, no Postgres

Date: 2026-05-20
Decision: Plans are markdown files in `apps/operator/docs/plans/`,
canonical on disk. No PG table, no mirror, no sync layer.

The project has a standing norm — **"PG by default for new durable
state"** (memory `feedback_pg_by_default`, `feedback_pg_canonical_no_mirrors`)
— so this decision needs to name why plans are the documented
exception, not just dodge the norm.

Plans differ from application state in four load-bearing ways:

1. **Hand-editable in an editor.** A human's first interaction with
   a plan is opening it in VS Code. An API-only record breaks that.
2. **Reviewed in PRs.** Plan changes are diffs in code review.
   The narrative form is the review surface.
3. **Versioned in git.** Git history *is* the audit trail. PG would
   be a parallel one, drifting.
4. **Sibling to `docs:*`.** The existing docs system is filesystem-
   canonical by deliberate design (fumadocs, MDX-on-disk).
   Plans are documents in the same sense.

What we lose by skipping PG:

- No "recently completed across all plans" temporal feed (see
  §11 / §12-Q3 — deferred for v1).
- Read-modify-write status flips serialize through `locks:*`
  rather than row-level locking. This is fine; same-plan concurrent
  flips are rare and the lock system handles it.
- No SQL queryability. Replaced by `plans:items` parser-side
  filtering; 46 files parses in microseconds.

Escape hatch: if "recently completed" or another temporal query
proves load-bearing post-v1, lift **just per-item status** to a
PG index over the filesystem. Files remain canonical; PG becomes a
read-optimization. Don't pay the cost speculatively.

### D-003 — Markdown stays human-readable; tooling adapts to it

Date: 2026-05-20
Decision: Separator glyphs (`·`, `→`, `—`) are display-only. Parser
keys on **keywords** (`blocked-by:`) and **token patterns**
(`P-\d+`, `D-\d+`), never on cosmetic punctuation.

Why: humans and agents hand-typing markdown will reach for ASCII
(`-`, `,`, `->`). Making parsing depend on `·` is a drift magnet
and will fail silently on the first hand-typed update.

### D-004 — Format spec lives in `content/internal-docs/spec/`

Date: 2026-05-20
Decision: The plan-format spec is published at
`apps/operator/content/internal-docs/spec/plan-format.mdx`.

Why: `spec/` already exists with a `meta.json`; it's the canonical
location for format specifications (sibling to other endpoint-system
and protocol specs). `system/` is for *system* behavior, not on-
disk formats. `plan-format.mdx` belongs in `spec/`.

### D-005 — Computed-blocked, not stored

Date: 2026-05-20
Decision: An item with `blocked-by: P-NNN` whose blockers are not
all `done` has *effective* status `blocked` — computed at read time,
not stored.

The literal `blocked` token is reserved for **external** blockers
(upstream PR, vendor response, awaiting release) — things markdown
genuinely can't compute. This eliminates the "blocker finished but
item still says blocked" stale-state bug structurally, instead of
requiring a lint warning or a manual sweep.

## 8. Migration

Migration has two cleanly separated parts. Consolidation is
mechanical and happens first. Format conversion is judgement-based,
slower, and only for still-active plans.

### 8a. Consolidation — mechanical, do all at once

Move every plan-shaped file into one of:

- `apps/operator/docs/plans/` — active and recent.
- `apps/operator/docs/plans/archive/` — superseded / done /
  historical.

Specific moves (numbers verified by inventory step P-301):

- 5 loose files in `apps/operator/docs/` → `docs/plans/`.
- 3 versioned archives in `apps/operator/docs/archive/` → 
  `docs/plans/archive/`.
- 2 repo-root `docs/*-plan.md` → `apps/operator/docs/plans/`.
- 1 repo-root `PLAN-operator-arc-2026-05-12.md` → 
  `apps/operator/docs/plans/`.
- 1 `design-tokens/IMPLEMENTATION_PLAN.md` → 
  `apps/operator/docs/plans/design-tokens-implementation-plan-<date>.md`
  (renamed to slug convention).
- 1 `libs/papercusp/libs/db/UNLOCKS-PLAN.md` → 
  `apps/operator/docs/plans/db-unlocks-plan-<date>.md`.

Leave in place:

- 4 `content/internal-docs/design/*-plan.mdx` — these are
  finished design docs in fumadocs, not WIP plans. Different
  artifact, different home.
- Harness prompts (`planner.md`, `plan-reviewer.md`,
  `plan-gate.md`, `_archived-planner.md`) — agent personas, not
  plans.

Consolidation produces a flat, predictable tree. No format
conversion happens in this step — every moved file remains "legacy"
until §8b.

### 8b. Format conversion — judgement-based, plan by plan

The hard part is **many-fragments → one-plan consolidation**. Three
known multi-fragment families:

- **sse-typed-events**: 5 files (`-2026-05-12.md`, `-HANDOFF.md`,
  `-PR-SPLIT.md`, `-rebase-note-from-main.md`,
  `-rebase-note-from-main-round11.md`).
- **llm-testing**: 5 files (`-framework-`, `-DECISIONS.md`,
  `-handoff-`, `-phase1-status-`, `-status-`).
- **deck-panel-design-audit**: 5 files (base + `-followup-` +
  `-round3-` + `-round4-` + `-round5-`).

Each becomes one plan whose `## Now` block reflects the *latest*
status, whose `## Decisions` log absorbs any `-DECISIONS.md`
verbatim, and whose `## Phase N` items absorb the rebase / round /
handoff notes into prose under each phase. The handoff files are
the easy part — they map to the `## Now` block. The hard part is
deciding which items are still alive.

Triage rule (P-303): an agent reads each plan + its fragments,
proposes a `(slug → status)` table covering all consolidated
plans, and writes it to a triage doc. The human ratifies the
table; conversion follows. The human's labor is the ratification,
not the reading.

### 8c. CLAUDE.md / agent-policies update

The "Find prior work" workflow in `/home/marsh-office/.claude/CLAUDE.md`
says "look in `apps/operator/docs/plans/`". Update to: "use
`plans:list` first; the canonical directory is
`apps/operator/docs/plans/`." Same edit in agent-policies §17.

## 9. Plan items — dogfooded in the format

This section uses the format the document specifies.

### Phase 0 — Spec finalized

- **P-001** `done` Draft this plan doc. → D-001 D-002 D-003 D-004 D-005
- **P-002** `done` Human review and ratify §12 open questions. Ratified
  by user on 2026-05-20 ("proceed with the plan implementation").

### Phase 1 — Read tools (shippable as Phase 0+1)

- **P-101** `done` Implement parser as a pure function: file bytes →
  `{ frontmatter, now, phases[], items[], decisions[] }`. 11 unit
  tests cover ASCII + non-ASCII separators, legacy files, malformed
  frontmatter, fenced-code-block exclusion, cycles, missing refs.
- **P-102** `done` Implement computed `effectiveStatus` resolver
  using `blocked-by:` references. Unit-tested for cycles, missing
  refs, all-done blockers.
- **P-103** `done` Implement `plans:list` (filesystem read +
  per-plan summary).
- **P-104** `done` Implement `plans:get`.
- **P-105** `done` Implement `plans:items` (with `actionable`,
  `needsHuman`).
- **P-106** `done` Implement `plans:search` (token-scored BM25-ish
  over selected scopes).
- **P-107** `done` Register all 5 read tools in
  `agent-tools/index.ts`; capability tiers `plans:read` (low) and
  `plans:write` (medium) added to `packages/agent-mcp/src/capability-tiers.ts`.
- **P-108** `done` Implement `plans:lint` with legacy exemption.
- **P-109** `done` Add `plans:lint` to CI (read-only check). MUST
  pass against the legacy tree on day one. blocked-by: P-108, P-301
- **P-110** `done` **Verify**: Phase 0+1 is a shippable unit.
  Live-tool smoke against dev :3055 confirms: 43 plans listed (2
  non-legacy / 41 legacy auto-exempted), 22 actionable items, 2-item
  human inbox, lint green (0 errors, 0 warnings) across the whole
  tree.

### Phase 2 — Assisted writes

- **P-201** `done` Implement `plans:new` (slug uniqueness inside
  one `locks:acquire`). blocked-by: P-110
- **P-202** `done` Implement `plans:set-status` (single-item flip
  with auto-bumped `updated:`). blocked-by: P-110
- **P-203** `done` Implement `plans:set-now` (atomic Now-block
  replacement). blocked-by: P-110
- **P-204** `done` Implement `plans:add-decision` (D-NNN allocation
  inside the lock — concurrency test required).
  blocked-by: P-110
- **P-205** `done` Implement `plans:add-item` (P-NNN allocation
  inside the lock). blocked-by: P-110
- **P-206** `done` Concurrency test suite — two parallel
  `plans:add-decision` calls against the same plan produce
  sequential non-colliding IDs. blocked-by: P-204
- **P-207** `done` Lint warning: `updated:` lags git mtime > 7d. (shipped inline with P-108: see lint.ts updated_lags_mtime check)
  blocked-by: P-108
- **P-208** `done` **Verify**: an agent can drive a real plan
  through todo → wip → done entirely via assisted-write verbs,
  matching the bytes a human would type. blocked-by: P-201, P-202,
  P-203, P-204, P-205, P-206

### Phase 3 — Migration

- **P-301** `done` Inventory step: ran `find` over the repo for
  plan-shaped files; produced exact counts + a categorized list at
  `apps/operator/docs/plans/inventory-2026-05-20.md` (37 in canonical,
  13 dispersed, 4 multi-fragment families).
- **P-302** `done` Consolidation (§8a) — mechanical file moves +
  slug renames. One PR. blocked-by: P-301
- **P-303** `done` Agent drafts active/shipped/stale triage
  table covering all consolidated plans; human ratifies.
  blocked-by: P-302
- **P-304** `done` Format conversion (§8b) — convert ratified-
  active plans to the new format, plan by plan. Multi-fragment
  families (`sse-typed-events`, `llm-testing`,
  `deck-panel-design-audit`) collapse to one file each.
  blocked-by: P-303
- **P-305** `done` Update `/home/marsh-office/.claude/CLAUDE.md`
  and `agent-policies.mdx` §17 to point at `plans:list`.
  blocked-by: P-110
- **P-306** `done` Publish `plan-format.mdx` to
  `content/internal-docs/spec/plan-format.mdx` (per D-004); add
  to `spec/meta.json`. blocked-by: P-110
- **P-307** `done` **Verify**: every consolidated active plan
  passes `plans:lint`; legacy plans still parse and list with
  `status: unknown`. blocked-by: P-304

## 10. Verification

Verification items (P-110, P-208, P-307) are real plan items, not
end-of-phase hand-waves. Each must be done before the next phase
starts.

Beyond per-phase: the plan ships when an agent (or fresh shell of
this one) can be given only the slug `agent-plan-tracking-2026-05-20`
and reconstruct full state from the file alone — no chat history,
no human re-briefing. That's the cold-resume acceptance test.

## 11. Open questions (rolled into items)

All four §12 questions from the prior draft are answered as
decisions (D-001 through D-005) or items (P-303). One remains as
a deferred-follow-up, not an item:

- **Recently-completed feed** — `plans:items { completedSince: ... }`
  with a date filter. Deferred for v1 (D-002). If post-v1 use
  shows it's load-bearing, lift per-item status into a PG index
  over the filesystem. Files remain canonical.

## 12. §12 question answers (from the prior draft)

For posterity — the four open questions from the previous draft,
with the answers that drove the rewrite:

1. **Spec section** — `content/internal-docs/spec/`. Confirmed
   exists; canonical location for format specs. → D-004
2. **Archive location** — single tree
   `apps/operator/docs/plans/archive/`. → §6
3. **Recently-completed feed** — out for v1. → §11, D-002
4. **Triage owner** — agent drafts, human ratifies. → P-303
