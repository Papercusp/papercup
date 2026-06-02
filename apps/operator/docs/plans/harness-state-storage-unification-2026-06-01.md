---
title: Harness-state storage unification — one runtime store-of-record, explicit sync authority
slug: harness-state-storage-unification-2026-06-01
status: draft
created: 2026-06-02
updated: 2026-06-02
owner: avi@storewolf.com
---

# Harness-state storage unification — one runtime store-of-record, explicit sync authority

## Now

**State:** Design proposal to end the harness-state storage hybrid by adopting ONE explicit model across the three in-flight efforts (`un-hardcode-plan`, `harnesses-across-workspaces-2026-05-31`, `papercusp-dogfood-v5` §7). Its first job is a **vocabulary fix**: the word "canonical" is overloaded — dogfood meant **git-vs-Hyperbee** (a *sync* choice), un-hardcode meant **PG-vs-files** (a *store* choice) — and that overload is the root of the storage confusion. This plan retires the bare word and names two orthogonal axes: **runtime store-of-record** vs **sync authority**. One real fork remains for the owner: the **store axis** — A (files are the runtime store for document tables; PG is a rebuilt cache — status quo) vs **B (PG is the uniform runtime store for every table; sync is a projection layer on top — recommended)**. B does **not** reverse dogfood D-001/D-020 (git stays the *sync authority* for documents); it only fixes the *store* framing.

**Next:** Owner — make the store-axis call (A vs B; recommend B). On B, the migration (consolidate-all-to-PG + per-table sync-authority declaration + one uniform projection layer) is the mechanical tail and supersedes the open "consolidate-vs-hybrid" question in `un-hardcode-plan`. Items are gated on this call, so they're intentionally not pre-allocated.

## ⚠️ Vocabulary — read first. The bare word "canonical" is BANNED in this plan.

"Canonical" has meant **two different things on two orthogonal axes**, and conflating them is the root cause of the storage confusion:

- In **dogfood** (`papercusp-dogfood-*` §7, D-001/D-020), **"git-canonical" = git vs Hyperbee** — which *cross-machine sync transport* propagates a shared table (committed `.harness/state/` files via GitHub vs Hyperbee/Model-B peer-logs). It was **never** a statement about git vs Postgres.
- In **un-hardcode / harnesses-across-workspaces**, **"canonical" = PG vs the `.harness/state/` files** — which *local store* the operator reads/writes at runtime.

These are different axes. This plan retires bare "canonical" and uses two precise terms everywhere:

| Axis | Term | Question it answers | Values |
|---|---|---|---|
| **Local store** | **runtime store-of-record** | What does the operator *on this machine* read/write at runtime? | always **PG** (under B) |
| **Cross-machine sync** | **sync authority** (+ transport) | What resolves merges & propagates a *shared* table between machines? | `none` (local-only) · `git` (committed files, GitHub-merged) · `peer-log` (Hyperbee/Model-B, LWW) |

**Rule for all agents:** never write "X is canonical." Write "X is the **runtime store-of-record**" (store axis) or "X is the **sync authority**" (sync axis). When you meet bare "canonical" in an older doc, first resolve which axis it meant before acting.

## The one open decision — the store axis

- **A — files are the runtime store-of-record for document tables** (status quo, dogfood §7.2: the operator rebuilds PG from `.harness/state/` on boot; PG is a disposable cache).
- **B — PG is the runtime store-of-record for ALL harness tables (recommended)**; cross-machine sharing is a projection layer on top (git-export for documents, peer-log for live state).

**B does NOT reverse dogfood D-001/D-020.** Those chose **git over Hyperbee as the *sync authority*** for document-shaped shared state — B keeps that exactly. B changes only the *store* axis: PG becomes the uniform runtime store-of-record instead of "a disposable cache rebuilt from files." For git-synced tables, PG is *hydrated from* and *exported to* the git layer, and **git remains the cross-machine merge authority**. dogfood §7.2 already implements both directions (boot rebuild file→PG + write-hooks PG→file); B keeps that mechanism and only fixes the framing.

### Why B
- The operator + embedded-PG is **always** the runtime on this desktop product — the source of truth is always present, so a uniform PG runtime store-of-record is the natural fit. (git-as-store exists to put state where the operator isn't; that's not this product.)
- It makes **consolidation / un-hardcode fall out for free** (every table slug-keyed in PG, no per-harness schema), kills the HYPERBEE/GIT/LOCAL "bucket" taxonomy, and gives one uniform query surface (no "is this table PG or files?" per call site).
- The valuable parts of state-in-git — diffable, reviewable, offline, GitHub-merged collaboration — are **preserved as the git *sync authority***, unchanged from dogfood.

### Honest caveat (so B isn't over-read as "PG arbitrates everything")
For **cross-machine-shared** tables there must be exactly one *merge* authority. PG-on-each-machine cannot be that without a conflict protocol — so for shared tables the **sync authority** (git or peer-log) stays the merge point and PG *converges* to it. "Runtime store-of-record = PG" means uniform local **access**, NOT that PG arbitrates cross-machine merges. LOCAL (unsynced) tables are pure PG with no merge concern.

## The two-axis assignment (by table *nature*, not today's buckets)

| Nature | key (identity) | runtime store | sync authority |
|---|---|---|---|
| **Config / settings** (prompts, `config_token`, 3-tier overrides) | `(workspace, harness, role/key)` — **workspace-owned** (across-workspaces D-1) | PG | `none` — per-workspace, never shared |
| **Shared results — machine rows** (`harness_features`, `harness_issues`, `agent_runs`, `agent_chats`, `messages`, `feature_audit`, `directive_summaries`, `executed_actions`) | `(harness_slug, …)` — **shared by slug** (D-1) | PG (consolidated) | `peer-log` (Model-B) when cross-machine; else `none` |
| **Shared results — human documents** (`harness_decisions`, `harness_escalations`, design artifacts, specs, `supervisor_notes`) | `(harness_slug, …)` | PG (consolidated) | **`git`** — committed `.harness/state/` files (dogfood's git-over-Hyperbee choice, **PRESERVED**) |

Net: every table → PG runtime store-of-record, slug- or workspace-keyed; the per-harness schema is retired entirely; the sync authority is **declared per table** (`none`/`git`/`peer-log`). Consolidation is the mechanical tail of this, not a standalone migration.

## Preserves / reframes / supersedes (so no agent mis-reads B as a reversal)

- **PRESERVES** — dogfood D-001/D-020: **git, not Hyperbee, is the sync authority** for document-shaped shared state. across-workspaces D-1: results shared by slug; config workspace-owned.
- **REFRAMES (not reverses)** — dogfood §7.2 wording "GIT is the canonical store / PG is a cache" → "**PG is the uniform runtime store-of-record; git is the *sync authority* for document tables; PG↔git stays bidirectional** (hydrate on pull, export on write)." Same mechanism, de-overloaded framing.
- **SUPERSEDES** — `un-hardcode-plan`'s open "consolidate-vs-hybrid" question (resolved: consolidate ALL under the PG runtime store-of-record); the ad-hoc HYPERBEE / GIT / LOCAL **bucket** taxonomy (replaced by explicit **key × sync-authority** per table).

## Migration sequence (do wholesale; pre-alpha breakage is acceptable per CLAUDE.md)

Items are allocated once the store-axis call is made — they're gated on it, so they aren't pre-created here.

1. Land the vocabulary + two-axis model as the shared spec; update `CLAUDE.md` + the storage-policy / dogfood docs; ban bare "canonical."
2. Declare `key` + `sync authority` for **every** harness table (a table-of-tables registry — the single source for the model).
3. Generalize the projection layer: one engine doing **PG↔git-export** (document tables) + **PG↔peer-log** (Model-B), driven by the per-table declaration — replacing the three hand-rolled bucket paths.
4. Consolidate all remaining per-harness tables → slug-keyed PG; retire `002-per-harness-template.sql` + `scaffold-harness-schema`.
5. Route config tables (`config_token`, …) to the workspace-owned store (the across-workspaces Phase-1b path).
6. Cut each table's sync over to its declared authority; delete the bespoke bucket code.
7. Verify: clone-and-go (git tables hydrate into PG), two-peer live sync (peer-log tables), two-workspace shared-by-slug results + per-workspace config.

## Decisions

(Use plans:add-decision to append.)

### D-001 — Store axis → B (PG is the uniform runtime store-of-record) — RECOMMENDED, owner sign-off needed
Date: 2026-06-02
**Status: proposed — needs the owner's go/no-go. This is the one decision that gates the whole plan.**

Recommendation: **B** — PG is the runtime store-of-record for every harness table; cross-machine sharing is a projection layer on top (git-export for human-document tables, peer-log/Model-B for live machine-row tables). Per-harness schemas retired; consolidation falls out for free.

Why B over A (files-as-runtime-store, status quo): the operator + embedded-PG is always the runtime on this desktop product, so a uniform PG runtime store-of-record is the natural fit; it gives one uniform query surface and kills the bucket taxonomy; and the valuable parts of state-in-git are preserved as the **git sync authority**, unchanged.

Explicitly NOT a reversal of dogfood D-001/D-020: those decided git-vs-Hyperbee on the **sync axis** (git stays the sync authority for documents). B only changes the **store axis** (PG vs files). See the Vocabulary + Preserves/Reframes/Supersedes sections.

Caveat carried in the body: for cross-machine-shared tables the sync authority (git or peer-log) remains the single merge authority; PG converges to it. "Runtime store = PG" means uniform local access, not that PG arbitrates merges.

On approval: allocate the Phase items (currently gated/unallocated), and this supersedes `un-hardcode-plan`'s open consolidate-vs-hybrid question + the HYPERBEE/GIT/LOCAL bucket taxonomy.
