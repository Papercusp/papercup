---
title: Plans system — end-to-end brief for the coordination agent
slug: plans-system-brief-2026-05-20
status: shipped
created: 2026-05-20
updated: 2026-05-20
owner: pandawamble@gmail.com
companion-to: [agent-plan-tracking-2026-05-20, agent-coordination-architecture-v2-2026-05-20]
---

# Plans system — end-to-end brief

How the `plans:*` feature works, written for the agent building the
multi-agent coordination system. If multiple OMP agents are going to
work plans in parallel, you need to know exactly how plan state is
stored, how writes serialize, and what invariants you can rely on.

The design rationale lives in
[`agent-plan-tracking-2026-05-20.md`](agent-plan-tracking-2026-05-20.md);
the format spec lives at `/internal/docs/spec/plan-format`. This
document is the **operational reality** — what the code actually does.

## Now

**State:** The `plans:*` surface (10 tools) is shipped and registered.
This brief documents it end-to-end for the coordination agent. One
caveat on current tree state: the `plans:lint` CI gate is momentarily
red against 5 newer plans authored by other agents (4 lack a `## Now`
block, 1 uses block-style YAML the minimal frontmatter parser doesn't
yet accept) — a known follow-up, not a defect in the surface itself.

**Next:** the coordination-system agent reads this brief, then designs
its parallel-agent layer on top of the lock + filesystem model in §4.

## 1. Mental model — what the plans system is

A **plan** is one markdown file at
`apps/operator/docs/plans/<slug>-<YYYY-MM-DD>.md`. The filename stem
is the plan's permanent ID.

The **filesystem is canonical.** There is no Postgres table, no mirror,
no sync layer. A plan file *is* the plan. The `plans:*` tools are a
**typed view + assisted writes** over those files — nothing more. Git
history is the audit trail.

This is the single most important fact for a coordination system:
**plan state lives in files, and the only thing serializing concurrent
access to a file is the `locks:*` system** (see §4). Do not build a
second store of plan state in your coordination layer — read the files
(or call `plans:*`), and you and the plan tools see the same bytes.

Three things a plan carries that a coordination agent cares about:

1. **Per-item status** — every work item has one of six status tokens,
   plus a *computed* effective status derived from its dependency
   graph (§5). This is how you answer "what can an agent pick up right
   now."
2. **The `## Now` block** — a pinned "current state + next action"
   pair. The cold-resume anchor: an agent dropped in with no history
   reads this first.
3. **The `## Decisions` log** — append-only decision records, so a
   fresh agent doesn't relitigate a settled call.

Everything else in the file is free prose the parser ignores.

## 2. The plan format

Four parser-keyed structural parts; everything else is free prose.

**Frontmatter** — YAML between `---` fences at the top:

```
title:   <Title Case sentence>
slug:    <kebab-slug>-<YYYY-MM-DD>   # MUST equal the filename stem
status:  draft | active | shipped | superseded
created: YYYY-MM-DD
updated: YYYY-MM-DD                  # auto-bumped on every assisted write
owner:   <email>
```

A file with missing/malformed frontmatter, or no `slug`/`status`, is
**legacy** — still listed, but parsed as opaque prose (see §6).

**The `## Now` block** — exactly one, fixed shape:

```
## Now

**State:** one paragraph — where the plan stands.
**Next:** one sentence — the single next action and who does it.
```

**Items** — under `## Phase N — <name>` headings, one per physical
line:

```
- **P-001** `done` Implement the parser.
- **P-002** `wip`  Wire the read tools. blocked-by: P-001
- **P-010** `needs-human` Decide archive default. -> D-003
```

`P-NNN` ids are permanent and flat — never reused, never renumbered.
`blocked-by:` is a keyword the parser reads independent of separator
glyphs. `D-NNN` tokens anywhere on the line are picked up as decision
references.

**The `## Decisions` log** — append-only, `### D-NNN — title` entries
with a `Date:` line and a body.

Heading match is **tolerant**: a leading `N. ` / `N.M ` numbering is
stripped before matching, so `## 7. Decisions` matches `Decisions`.
Fenced code blocks (like the examples above) are skipped entirely —
a `## Now` or `- **P-001**` inside ``` fences is never mistaken for
real structure.

## 3. The tool surface — 10 tools

Registered in `apps/operator/lib/agent-tools/index.ts`, MCP-projected
via `defineTool`, source at `apps/operator/lib/agent-tools/plans/`.
Capability tiers: `plans:read` (low), `plans:write` (medium).

**Read verbs** (no lock, pure filesystem read + parse):

- `plans:list { status?, includeArchived?, includeLegacy? }` — one row
  per plan: slug, title, status, item counts by effective status, the
  `Next:` line. The cheap directory view.
- `plans:get { slug }` — full parsed structure for one plan.
- `plans:items { slug?, status?, actionable?, needsHuman? }` —
  item-level query across one or all plans. `actionable: true` returns
  items whose effective status is `todo` (all blockers cleared) — the
  "what can I pick up" query. `needsHuman: true` is the human's inbox.
- `plans:search { query, scope? }` — keyword search over
  title/now/items/decisions/prose.
- `plans:lint { slug?, includeArchived? }` — validation; errors fail
  CI, warnings inform. Legacy plans are exempt.

**Write verbs** (each acquires a lock — see §4):

- `plans:new { slug, title, status? }` — create from template. The
  `-YYYY-MM-DD` suffix is appended automatically if absent.
- `plans:set-status { slug, itemId, status, note? }` — flip one item's
  stored status token.
- `plans:set-now { slug, state, next }` — replace the `## Now` block.
- `plans:add-decision { slug, title, body, refs? }` — append a
  decision; allocates the next `D-NNN`.
- `plans:add-item { slug, phase, text, blockedBy? }` — append an item;
  allocates the next `P-NNN`; creates the phase if missing.

Every write verb auto-bumps frontmatter `updated:` to today.

## 4. Concurrency & lock integration — read this twice

This is the part that matters for parallel agents.

### 4.1 Every write verb wraps itself in a lock

All five write verbs route through one helper, `withPlanLock`
(`apps/operator/lib/agent-tools/plans/with-plan-lock.ts`). Its shape:

```
acquire lock on the plan file
  -> read the file off disk (or null if creating)
  -> run the mutator: parse, allocate ids, produce new bytes
  -> write the new bytes back
release lock   (in a finally — released even on throw)
```

The lock is the **shipped SU `locks:*` system** — the same
`su-lock-store` / `inWorkspaceTxn` machinery your coordination layer
uses. `plans:*` is just another client of it. There is no separate,
plans-specific locking.

### 4.2 The lock key

The key is the **workspace-canonical relative path** of the plan
file: `apps/operator/docs/plans/<slug>.md` (POSIX-joined, never
absolute — the lock store rejects absolute paths). Consequence: the
same plan always hashes to the same lock regardless of which agent's
`repoRoot` it is, so two agents on two checkouts still contend
correctly. Default TTL is 60s — a write verb's read-modify-write is
fast, and a crashed verb's lock self-expires.

### 4.3 The invariant that makes ID allocation safe

`plans:add-decision` and `plans:add-item` allocate the next `D-NNN` /
`P-NNN` by reading the current max. That read-modify-write **happens
inside the lock's mutator callback** — never outside. So two
concurrent `add-decision` calls on the same plan serialize: the first
acquires, appends `D-005`, releases; the second then acquires, sees
`D-005`, appends `D-006`. They cannot both observe the same max and
collide. There is a PG-backed concurrency test asserting exactly this.

If you ever add a write path that allocates an id, the allocation MUST
be inside the lock. Allocating before acquiring re-introduces the race.

### 4.4 `busy` is surfaced, never silently retried

If `locks:acquire` fails because another agent holds the file, the
write verb returns an error payload, not a retry:

```
{ "error": "busy",
  "busy": [ { "path": "...", "owner_label": "...",
              "intent": "...", "expires_ts": "..." } ] }
```

The verb does **not** spin. The calling agent decides: wait and
retry, or pivot to other work. Your coordination system should treat
a `busy` result as a first-class signal — it tells you *which* agent
(`owner_label`) holds the file and *why* (`intent`) and *until when*
(`expires_ts`). That is exactly the data a scheduler wants.

### 4.5 What the lock does and does NOT protect

- **Does**: serialize `plans:*` write verbs against each other, and
  against any `edit`/`write` an OMP agent makes — the OMP `tool_call`
  hook auto-acquires the same lock before the edit runs.
- **Does NOT**: protect a raw `fs.writeFile` that bypasses `locks:*`.
  Every writer must be lock-aware. Don't write plan files directly
  from the coordination layer; call `plans:*` or take the lock first.
- **Per-call, not per-sequence.** Each verb is atomic on its own. A
  *sequence* — say `set-status` then `set-now` — is **not** atomic;
  another agent can interleave between the two calls. If a
  coordination workflow needs several plan mutations applied as a
  unit, it must hold its own `locks:acquire` on the plan path around
  the whole sequence. Note the `plans:*` verbs will then contend with
  that outer lock unless the lock store grants re-entrancy to the same
  owner — verify that before relying on it.

### 4.6 Reads are lock-free

The five read verbs never lock. A reader sees either the complete
pre-write or complete post-write file — writes land as a single
`writeFile`. Reads are cheap (parsing the whole tree is microseconds),
so a coordination agent can poll `plans:list` / `plans:items` freely.

## 5. Status: stored vs. effective

Six **stored** tokens, written literally in the file:

| Token | Meaning |
|---|---|
| `todo` | Not started. |
| `wip` | In progress — the active item. |
| `blocked` | **External** blocker only (upstream PR, vendor, release). |
| `needs-human` | A human decision is required. |
| `done` | Completed and verified. |
| `dropped` | Decided not to do. |

On top of that the parser computes an **effective status** per item
(`effective-status.ts`, `resolveEffectiveStatus`). The rule:

- An item with `blocked-by: P-NNN` has effective status `blocked`
  while any referenced blocker is **unresolved**.
- A blocker is **resolved** when its stored status is `done`
  (completed) *or* `dropped` (abandoned — it will never complete, so
  the dependent un-gates; `plans:lint` emits a `blocker_dropped`
  warning so the dependency still gets re-evaluated).
- A stored `blocked` token is always effective `blocked`.
- Items in a `blocked-by` cycle, or referencing a missing item id,
  resolve to effective `blocked` (and are reported separately).
- Otherwise effective status equals the stored token.

**Why this matters for coordination:** "is this item pickable" is
*derived*, never stored. You never have to flip a `blocked` token when
a dependency finishes — recompute and it un-gates itself. The
`plans:items { actionable: true }` query is precisely "effective
status is `todo`" — i.e. stored `todo` with every blocker resolved.
That is your ready-queue. `needsHuman: true` is the human's inbox.

If your coordination layer parses files directly instead of calling
the tools, call `resolveEffectiveStatus` — do not read `storedStatus`
and try to re-derive blocking yourself.

## 6. Legacy plans, lint, and the CI gate

**Legacy plans.** A plan with missing/malformed frontmatter (or no
`slug`/`status`) is `legacy`. It still appears in `plans:list` with a
synthesized `status: unknown` and no item counts; `plans:get` returns
its raw prose. `plans:items` / `plans:search` skip it by default.
This is deliberate graceful degradation — the ~40 pre-existing plans
were not rewritten on day one.

**Lint.** `plans:lint` returns `errors` and `warnings`. Legacy plans
are **exempt entirely** (no frontmatter to validate against). For
non-legacy plans:

- *Errors* (fail CI): `slug_mismatch`, `missing_now_section`,
  `parse_warning` (duplicate/malformed ids), `unknown_blocked_by`,
  `missing_blocker`, `cycle`, `malformed_item_id`.
- *Warnings* (informational): `missing_decisions_section`,
  `unknown_decision_ref`, `stored_blocked_with_blocked_by`,
  `blocker_dropped`, `unphased_item`, `updated_lags_mtime`.

**CI gate.** `npm run lint:plans` runs
`apps/operator/scripts/lint-plans.ts` over the whole tree and exits
non-zero on any error; it is wired into `.github/workflows/test.yml`.
So a malformed plan breaks CI — meaning a coordination agent that
creates plans programmatically must create *valid* ones. `plans:new`
guarantees validity; a hand-rolled file does not.

## 7. What a coordination agent must internalize

1. **One store, the filesystem.** Plan state is the file. Don't cache
   or mirror per-item status in your coordination layer — it will
   drift. Read `plans:*` (or the files) on demand; reads are cheap.
2. **All writes are lock-aware.** `plans:*` write verbs lock; the OMP
   `tool_call` hook auto-acquires the same lock for an agent's
   `edit`/`write` calls (per the 2026-05-20 OMP-only decision — OMP is
   the sole engineer-collaborator harness; the hook is specified in
   `file-locking-improvements-2026-05-20.md` §2). A raw `fs.writeFile`
   does not lock. Never write a plan file outside that discipline.
3. **`busy` is your scheduling signal.** It names the holding agent
   (`owner_label`), its `intent`, and `expires_ts`. Surface it; don't
   swallow it. That is the data a parallel-work scheduler runs on.
4. **Atomicity is per-call.** A single verb is atomic. A *sequence*
   of verbs is not — interleaving is possible between calls. For a
   multi-mutation transaction, hold your own `locks:acquire` on
   `apps/operator/docs/plans/<slug>.md` around the whole sequence.
5. **The ready-queue is computed, not stored.** Use
   `plans:items { actionable: true }` for "what an agent can pick up"
   and `{ needsHuman: true }` for "what the human must decide." Never
   re-derive blocking from raw `storedStatus`.
6. **Identity flows into the lock.** Write verbs read the caller's
   identity (workspace + owner) from the MCP context; that owner is
   what a contending agent sees in a `busy` response. Your agents'
   identities therefore need to be distinct and stable for the
   `owner_label` to be meaningful.
7. **Cold-resume contract.** An agent assigned a plan reads
   `plans:get { slug }` and the `## Now` block *first* — State tells
   it where things stand, Next tells it the one action to take. Keep
   `## Now` current via `plans:set-now` as work advances; it is the
   handoff surface between agents and between sessions.
8. **Decisions stop relitigation.** Before re-opening a settled
   question, an agent should check the `## Decisions` log. Record new
   settled calls with `plans:add-decision` so the next agent inherits
   them.

## 8. Recent hardening — why you can trust the write path

A post-ship code-vs-spec audit found and fixed two latent write-path
bugs; the write verbs as they stand now are safe to drive in parallel:

- **Fence-aware mutators.** All four mutating verbs locate their
  target heading/item by scanning a *fence-masked* copy of the file
  (`maskFences` in `parser.ts`) and splicing the real bytes by index.
  A `## Now` or `- **P-001**` line inside a ``` worked-example fence
  is never mistaken for real structure. So a plan can safely contain
  format examples in fenced blocks.
- **No replacement-string mangling.** `plans:set-status` previously
  fed item text through a string replacement that interpreted
  dollar-sign substitution sequences in the text as patterns; it now
  splices by index, so arbitrary item text survives verbatim.
- **`plans:new` enforces the dated slug.** The `-YYYY-MM-DD` filename
  suffix is appended automatically, so programmatically created plans
  always satisfy the filename convention.

## 9. Where the code lives

- `apps/operator/lib/agent-tools/plans/` — the whole surface.
  - `parser.ts` — pure `parsePlan` + `maskFences`.
  - `effective-status.ts` — `resolveEffectiveStatus`.
  - `with-plan-lock.ts` — the acquire/read/mutate/write/release helper
    every write verb uses. **Read this file** if you want the exact
    lock contract.
  - `list.ts` `get.ts` `items.ts` `search.ts` `lint.ts` — read verbs.
  - `new.ts` `set-status.ts` `set-now.ts` `add-decision.ts`
    `add-item.ts` — write verbs.
  - `source.ts` — filesystem resolution (`listPlanFiles`,
    `readPlanBySlug`).
- `apps/operator/lib/agent-tools/locks/` — the SU lock system the
  write verbs depend on (`su-lock-store`, `in-workspace-txn`,
  `identity`).
- `apps/operator/scripts/lint-plans.ts` — the CI gate.
- Design rationale: `agent-plan-tracking-2026-05-20.md`.
  Format spec: `/internal/docs/spec/plan-format`.
