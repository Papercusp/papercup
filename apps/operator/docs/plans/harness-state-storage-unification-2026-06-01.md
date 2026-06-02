---
title: Harness-state storage unification — one runtime store-of-record, explicit sync authority
slug: harness-state-storage-unification-2026-06-01
status: ready
created: 2026-06-02
updated: 2026-06-02
owner: avi@storewolf.com
---

# Harness-state storage unification — one runtime store-of-record, explicit sync authority

## Now

**State:** DECIDED → B. **P-001 + P-002 DONE.** The spec is the standard (storage-policy.mdx + CLAUDE.md), and the per-table registry is complete: `apps/operator/lib/harness-state/table-registry.ts` — `resolveTableSpec()` + `classifyInventory()`, validated against the live schema (186/186 classified, 0 unreviewed: 80 workspace-owned, 46 default, 25 git, 9 peer-log, 19 security, 7 legacy), 13/13 tests. The model + its source-of-truth registry exist; what remains is the build.

**Next:** P-003 (the heavy build) — generalize ONE projection engine reading the registry: PG↔git-export for `sync:'git'` document tables + PG↔peer-log (Model-B) for `sync:'peer-log'` live tables, replacing the three hand-rolled HYPERBEE/GIT/LOCAL bucket paths. Wire `classifyInventory()` at boot to fail loud on any unclassified table. Then P-004 (consolidate per-harness tables → slug-keyed PG) + P-005 (config → workspace-owned store).

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


## Phase 1 — Spec & model

- **P-001** `done` Land the two-axis spec (runtime store-of-record vs sync authority) as the standard: add it to system/storage-policy.mdx + a CLAUDE.md pointer; ban bare "canonical"; annotate dogfood §7 / un-hardcode / harnesses-across-workspaces with the reframe. importance: high (spec in storage-policy.mdx + served mirror rebuilt + CLAUDE.md pointer + bare-canonical ban + dogfood §7 D-033; un-hardcode/across-workspaces covered by propagated D-001/D-002 cross-refs)
- **P-002** `done` Declare key (slug-shared | workspace-owned) + sync authority (none|git|peer-log) for EVERY harness table in one table-of-tables registry — the single source of truth for the model. importance: high (registry module + rule-based resolveTableSpec + exception lists git/peer-log/workspace-owned/security + 9/9 tests landed apps/operator/lib/harness-state/table-registry.ts. Remaining: resolve ~30 NEEDS_REVIEW judgment calls + validate completeness vs live schema) (registry + resolveTableSpec + classifyInventory + 13/13 tests; NEEDS_REVIEW resolved; live-schema validated 186/186 80 ws-owned, 46 default, 25 git, 9 peer-log, 19 security, 7 legacy, 0 unreviewed)



## Phase 2 — Projection & migration

- **P-003** `todo` Generalize ONE projection engine: PG↔git-export (document tables) + PG↔peer-log (Model-B), driven by the per-table declaration — replaces the three hand-rolled HYPERBEE/GIT/LOCAL bucket paths.
- **P-004** `todo` Consolidate all remaining per-harness tables → slug-keyed PG (the 032 auto-updatable-view pattern); retire 002-per-harness-template.sql + scaffold-harness-schema.
- **P-005** `todo` Route config tables (config_token, prompt/3-tier overrides, …) to the workspace-owned store keyed by (workspace, harness, role) — the harnesses-across-workspaces Phase-1b path; never slug-shared.




## Phase 3 — Cutover & verify

- **P-006** `todo` Cut each table's sync over to its declared authority; delete the bespoke HYPERBEE/GIT/LOCAL bucket code.
- **P-007** `todo` Verify: clone-and-go (git tables hydrate into PG), two-peer live sync (peer-log tables), two-workspace shared-by-slug results + per-workspace config.


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

### D-002 — DECIDED → B (owner, 2026-06-01)
Date: 2026-06-02
Owner chose **B**: PG is the uniform **runtime store-of-record** for every harness table; cross-machine sharing is a projection layer (git-export for document tables, peer-log/Model-B for live machine-row tables). Items P-001–P-007 allocated; plan started.

Reaffirming D-001 to prevent mis-reads: this is a **store-axis** change only. **git remains the *sync authority* for document-shaped shared state** (dogfood D-001/D-020 intact); only "what the operator reads/writes locally" changed (files → PG). Supersedes un-hardcode's consolidate-vs-hybrid question + the HYPERBEE/GIT/LOCAL bucket taxonomy.
