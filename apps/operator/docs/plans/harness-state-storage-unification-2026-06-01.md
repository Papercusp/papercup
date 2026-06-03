---
title: Harness-state storage unification — one runtime store-of-record, explicit sync authority
slug: harness-state-storage-unification-2026-06-01
status: ready
created: 2026-06-02
updated: 2026-06-03
owner: avi@storewolf.com
---

# Harness-state storage unification — one runtime store-of-record, explicit sync authority

## Now

**State:** P-001/002/003/008 DONE. **D-007 (consolidate) execution STARTED — P-004a (agent_chats) DONE+live-verified+committed** (submodule 6b314a0 mig 116 + superproject 0894726fa). agent_chats per-harness→slug-keyed view-swap: backfill 156=156 (no data loss; per-harness was source of truth — consolidated was never write-cut-over), 19 views, timestamptz→bigint-ms, writers now()→Date.now(), rowToChat ms→ISO, scaffold→view, WITH CHECK OPTION enforced, 17/17 unit + live API verified. TWO incidents handled: (1) migration-number collision (115 taken by adv-session) → renumbered to 116; (2) a peer's drizzle generated.ts regen had dropped the `primaryKey` import (used 191×) → operator crash-looped fleet-wide on restart; I added the import + recovered the transient papercup-dev-api unit (I'd stopped it to diagnose). REAL per-table cost is higher than the 'view-swap' pitch: each type needs verified backfill + writer/reader fixes + drift handling. Remaining: P-004b (messages/supervisor_notes/directive_summaries/executed_actions/harness_proposals — 3 lack a harness_slug discriminator), P-004c (feature_audit + retire 002/scaffold), P-005 (config_token→workspace-owned), P-006 (registry cutover + delete buckets), P-007 (verify).

**Next:** CHECK IN with owner (per 'prove then check in'): report P-004a done + real per-table cost + the 2 incidents; get go-ahead to continue P-004b→P-007 (each table: verified backfill + writer/reader fixes, committed per-phase).

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

- **P-003** `done` Generalize ONE projection engine: PG↔git-export (document tables) + PG↔peer-log (Model-B), driven by the per-table declaration — replaces the three hand-rolled HYPERBEE/GIT/LOCAL bucket paths. (P-003a DONE projection-engine seam + peer-log drift guard + boot coverage; 19 tests. P-003b git-export DESIGNED D-004: reuse substrate_outbox + separate filtered drainer + file serialize/rebuild; additive. P-003c router pending. git-export integration = focused-session build on Model-B-owned substrate.) (a peer-log seam + b git-export, live-verified, amplification fixed + c one router all done + tested; auto-commit policy resolved flag-gated committer; papercup_shared org-demo removed from GIT_DOCS)
- **P-004** `todo` Consolidate all remaining per-harness tables → slug-keyed PG (the 032 auto-updatable-view pattern); retire 002-per-harness-template.sql + scaffold-harness-schema. (D-006: conflicts with active baseline plan which KEEPs the per-harness template P-004 wants to retire. Owner must reconcile per-harness vs slug-keyed direction before execution) (D-006 resolved → consolidate D-007; unblocked)
- **P-005** `todo` Route config tables (config_token, prompt/3-tier overrides, …) to the workspace-owned store keyed by (workspace, harness, role) — the harnesses-across-workspaces Phase-1b path; never slug-shared. (D-006: rides on P-004's data-model decision; config_token/prompt-overrides → workspace-owned) (unblocked by D-007; config_token+overrides → workspace-owned)
- **P-008** `done` git-export outbox GC for ephemeral / non-registry harnesses (P-003b follow-up). The capture trigger fires for ALL sync:'git' writes, but the drain loop runs only for registry harnesses. Ephemeral test harnesses (gymsmoke*, contract-test-*) write git-table rows that are captured but never drained → git_export_outbox accumulates stuck-unexported orphans (found 600+ during the P-003 live-verify; cleaned manually). Fix: GC outbox rows whose (workspace_id,harness_slug) isn't a live registry harness (timer/boot), or skip capture for ephemeral harnesses. Low priority — slow leak, ephemeral only, nothing breaks; not blocked by the P-004 cutover. importance: low (gcOrphanOutboxRows wired into boot; live-verified outbox 0 + stable, harness_lanes self-heals; integration test covers orphan-delete + live-keep + empty-list guard)





## Phase 3 — Cutover & verify

- **P-006** `todo` Cut each table's sync over to its declared authority; delete the bespoke HYPERBEE/GIT/LOCAL bucket code. (D-006: rides on P-004; delete bespoke HYPERBEE/GIT/LOCAL bucket code after the cutover) (unblocked by D-007; delete bespoke buckets after cutover)
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

### D-003 — P-003 scope: peer-log = refactor (engine exists, default-on); git-export = greenfield; sequence a→b→c
Date: 2026-06-02
Mapped the three paths read-only (2026-06-01).

**peer-log (Model-B) — MATURE + DEFAULT-ON; refactor only.** A generic projection registry already exists: `lib/sync/hyperbee/projection.ts` (`TableProjection<Row>` + `registerProjection()` + `applyOp` + `lwwPick` + `ProjectionLookup`). 8 projections hand-wired in `projections/register-all.ts`; engine = `outbox-drain.ts` + `wire-outbox.ts` + `peer-log.ts` + `read-merge.ts`/`read-admission.ts`; boots via `boot-all.ts` (`host-bootstrap.ts:217` — the `PAPERCUSP_DOGFOOD_SUBSTRATE_ENABLE` gate was REMOVED Stage-4d, so Model-B per-peer-log is the live default). P-003's peer-log half is a REFACTOR: drive registration from `table-registry` (`sync:'peer-log'` tables) instead of 8 hand-wired calls.

**git-export — NOT BUILT (greenfield).** §7.2's file-per-row `.harness/state/<table>/<id>` + write-hooks + boot-rebuild is design-only — no `.harness/state` writer/rebuilder exists in `lib/`. Document (`sync:'git'`) tables are PG-only today (effectively unsynced). This is the bulk of new P-003 work.

**none — no-op** (no projection).

**Build split + sequence:**
- **P-003a (small, low-risk):** registry-driven peer-log registration + wire `classifyInventory()` at boot to FAIL-LOUD on any unclassified live table. Connects the P-002 registry to the existing engine.
- **P-003b (greenfield, the bulk):** GIT-export adapter — per `sync:'git'` table: serializer (row→file), write-hook (PG→file→debounce-commit), boot-rebuild (scan→upsert PG). New dir `lib/harness-state/git-export/`; model on the `TableProjection` shape.
- **P-003c:** one engine entry routing on `resolveTableSpec(t).sync` → peer-log registry | git adapter | no-op.

**Coordination:** `lib/sync/hyperbee/**` is HOT (Model-B actively developed; coord shows substrate-outbox work). P-003a touches `register-all.ts`/`projection.ts` → declare-intent + `locks:acquire` those during the edit. P-003b is NEW code in a new dir → low contention. Recommend P-003a first (proves registry-drives-engine, minimal blast radius), then P-003b, then P-003c.

**Open owner question:** build git-export now (P-003b), or defer it (documents stay PG-only / peer-log-eligible) and ship P-003a+c first? Deferring git-export is viable since it isn't built today anyway — nothing regresses.

### D-004 — P-003b git-export design: reuse substrate_outbox + separate filtered drainer + file serialize/rebuild (additive)
Date: 2026-06-02
Mapped the write-capture (2026-06-01). `harness_shared.substrate_outbox` is a GENERIC trigger-captured outbox — columns `(workspace_id, harness_slug, table_name, op put|del, key, row jsonb, ts, drained_at)`. A PG trigger `capture_substrate_outbox()` (wired by `wireDogfoodTriggers()` in `lib/ensure-schema-dogfood.ts`) appends a row on every local-origin write; the peer-log drainer (`lib/sync/hyperbee/outbox-drain.ts`) reads undrained rows → appends to the peer Hyperbee log. So git-export is ADDITIVE, not greenfield.

**Design (additive — do NOT rewrite the peer-log drainer):**
- **Capture:** attach `capture_substrate_outbox` to the `sync:'git'` tables too (additive; confirm current coverage in `wireDogfoodTriggers`).
- **Disjoint consumers:** `sync:'git'` and `sync:'peer-log'` are mutually exclusive in the registry, so each outbox row belongs to exactly ONE consumer via `table_name → resolveTableSpec().sync`. Give git-export its OWN cursor (a `git_exported_at` column or a `substrate_git_cursor` row) rather than sharing the peer-log `drained_at`; add a table-filter so neither drainer marks the other's rows.
- **Export drainer** (new `lib/harness-state/git-export/`): undrained git rows → serialize → `.harness/state/<table>/<key>.{md|json}` (md+frontmatter for prose tables: decisions/escalations/summaries/notes/supervisor_notes/design; json for structured) → debounce git-commit → advance the git cursor.
- **Boot hydrate** (reverse): scan `.harness/state/<git tables>/` → upsert PG (git is the sync authority; PG converges to it). Runs at boot before the gate, like `wireDogfoodTriggers`.

**Build order + verification/coordination:** (1) build the file serialize/parse + path mapping as PURE, unit-tested functions (net-new `lib/harness-state/git-export/`, no contention) — verifiable here; (2) the drainer/trigger/boot integration touches the shared `substrate_outbox` + `wireDogfoodTriggers` (Model-B-owned) and needs a live boot + integration test → focused session, `coord:declare-intent` + `locks:acquire` on `ensure-schema-dogfood.ts` + the new module, and do NOT modify `outbox-drain.ts` beyond adding a table-filter.

### D-005 — P-003b git-export LIVE-VERIFIED; fs-watcher mirrors are never sync:'git' (amplification fix)
Date: 2026-06-02
The first live host boot of the P-003b git-export drain loop (2026-06-02, dev host: 15 harnesses / 16 git tables / 15 drain loops) exposed a perpetual export loop: the same 3 files (staging/testing/production) re-exported every ~20s for every active harness — CPU burn, working-tree churn (incl. the papercup repo), and likely the 2 host crashes preceding it.

Root cause: `harness_branch_actions` was classified `sync:'git'`, but it's a LOCAL fs-watcher projection (Mirror 7k — the repo's `git log` enrichment, harness-fs-watcher.ts:660+) whose `last_check_ms` heartbeat is re-upserted on every poll regardless of content (the change-diff only gates the SSE notify, not the upsert). The capture trigger faithfully captured each genuinely-changed row → endless PG→file churn. A WHEN OLD IS DISTINCT FROM NEW guard does NOT help (the rows ARE distinct via last_check_ms); the table simply doesn't belong in git-export — its source is already git-tracked and PG is a derived recompute.

DECISION → fs-watcher *mirror* tables (projections of already-git-tracked files) must never be `sync:'git'`; only producer-authored document tables are the git set. Fix (commit 618504e28):
- Removed harness_branch_actions from GIT_DOCS + GIT_KEY_COLS → DEFAULT (slug-shared, sync:none); documented the rule in table-registry.ts.
- Boot reconciliation `detachStaleGitCaptureTriggers()` — drops capture_git_export_outbox_trg from harness_shared tables no longer in GIT_TABLES, making the registry authoritative + self-healing (auto-dropped the live trigger on restart: boot logs `detached 1 stale: harness_branch_actions`).
- Defense-in-depth no-op guard in capture fn (skip UPDATE where to_jsonb(OLD) IS NOT DISTINCT FROM NEW) — kills the re-upsert-amplification class (the federation lesson).

Live-verified: restart → detach fired, trigger gone, outbox stable then cleared (288→0), churn stopped. 42 harness-state tests green (29 unit + 13 integration; +registry-regression, +detach-stale, +no-op-guard). The other live mirrors still in GIT_DOCS (harness_phases, harness_summaries, harness_proposals_shared) were checked and do NOT churn (mtime-gated / change-event-driven), so they were left in place pending P-002 reconfirmation.
Related: P-003

### D-006 — P-004..P-006 BLOCKED on cross-plan conflict with self-contained-migration-baseline + live contention (needs owner reconciliation)
Date: 2026-06-03
Investigated P-004..P-007 (2026-06-02 ~22:30, autonomous run). FINDING: they cannot be safely executed solo right now — a direct cross-plan conflict + heavy live contention.

THE CONFLICT. P-004 = "consolidate all remaining per-harness tables → slug-keyed PG; RETIRE 002-per-harness-template.sql + scaffold-harness-schema." But the ACTIVE plan `self-contained-migration-baseline-2026-06-02` (status: active, being executed tonight) has P-005 = "Add 000-baseline.sql; … **KEEP 002-per-harness-template.sql**." The two plans take OPPOSITE positions on whether the per-harness `harness_<slug>.*` model should exist: harness-state wants to eliminate it (slug-keyed consolidation); the baseline plan preserves it. This is an architectural fork — and it's exactly the per-harness-vs-shared-state question the owner debated under harnesses-across-workspaces (a single harness in 2 workspaces = different settings, shared state). It needs an OWNER decision, not a unilateral overnight rip-out.

THE CONTENTION. The exact files are in-flight tonight: `002-per-harness-template.sql` flickers in/out of `libs/papercusp/libs/db/sql/` between two `ls` calls (concurrent edits); `scaffold-harness-schema.ts` is mid-transition; the :3070 host is being SIGKILL/restarted by other su-agents (DBOS verify); locks on libs-papercusp-submodule churn. Racing a system-wide migration here = guaranteed collision + a broken shared tree for 5+ active agents.

THE SCALE. Live state: 19 per-harness schemas × ~12 table types = 218 tables. 6 are already consolidated (agent_chats/agent_runs/feature_audit/harness_features/harness_issues/harness_snapshots `_consolidated` exist); the per-harness copies are legacy duplicates with live readers. P-004 = migrate every reader/writer of 12 table types off `harness_<slug>.*` + drop 218 tables + retire scaffold-harness-schema. P-005 (config_token/prompt-overrides → workspace-owned) and P-006 (delete bespoke HYPERBEE/GIT/LOCAL bucket code) ride on P-004's data model. Not solo-overnight-safe even without the conflict.

RECOMMENDATION (owner, when awake + repo quiet):
1. Reconcile direction: do per-harness schemas STAY (baseline) or get consolidated to slug-keyed (P-004)? This is the gating decision.
2. If consolidating: ONE plan owns it (merge P-004..P-006 into, or sequence after, the baseline plan) so two agents don't race it. Sequence: let baseline land (squash/archive/ensure-schema-removal stable) → then per-harness→consolidated reader migration → drop per-harness tables → retire scaffold + 002-template → cut sync over (P-006) → verify (P-007).
3. Until then P-004..P-006 = blocked; P-007's git-export half is already verifiable (P-003b tests) but the full end-state verify waits on the cutover.

DONE this run instead (safe, isolated, tested): P-003 fully (a/b/c) incl. the live-boot amplification fix, the flag-gated git committer (auto-commit policy resolved), the papercup_shared org-demo removal, and the one projection router. 40 unit + 13 integration harness-state tests green.
Related: P-004, P-005, P-006, P-007

### D-007 — D-006 RESOLVED → CONSOLIDATE to slug-keyed (owner, 2026-06-03); scope much smaller than feared (032 view-pattern)
Date: 2026-06-03
Owner (Avi) decided 2026-06-03: **CONSOLIDATE per-harness `harness_<slug>.*` schemas → slug-keyed shared tables.** Retire `002-per-harness-template.sql` + `scaffold-harness-schema.ts`. This unblocks P-004→P-005→P-006→P-007. **This SUPERSEDES `self-contained-migration-baseline-2026-06-02` P-005's "keep 002-per-harness-template.sql"** — the squash must NOT preserve the template; the per-harness model is being retired.

REFINED SCOPE (from live code map, 2026-06-03) — much smaller than D-006's "218 tables / rewrite every reader-writer" estimate. The **032 auto-updatable-VIEW pattern is the proven recipe**: a consolidated base table in `harness_shared` keyed by `(harness_slug, …)`; each per-harness physical table is dropped and replaced by `CREATE VIEW harness_<slug>.<t> AS SELECT * FROM harness_shared.<t>_consolidated WHERE harness_slug='<slug>' WITH CHECK OPTION`. Because the view keeps the SAME name as the old table, **readers/writers need NO change** — they keep doing `INSERT INTO harness_<slug>.<t>` and PG routes through the view. (Ref: archive/029-031 create consolidated + trigger-mirror; archive/032 drops physical + creates views.)

PER-TYPE STATUS (11 template types):
- DONE (consolidated + view, migration 032): harness_features, harness_issues, agent_runs, harness_snapshots.
- HALF-DONE (consolidated base in 000-baseline, but per-harness still PHYSICAL + dual-written): agent_chats, feature_audit. → apply the 032 view-swap.
- NOT STARTED (per-harness physical only): config_token, messages, supervisor_notes, directive_summaries, executed_actions (+ harness_proposals from scaffold). → create consolidated base + view-swap.
- SPECIAL: config_token (+ prompt/3-tier overrides) → P-005 routes these to the **workspace-owned** store keyed by (workspace, harness, role), NOT slug-shared.

SEQUENCING: D-006's "wait for repo quiet / let baseline land first" was about contention — now 0 active agents, so it's safe to proceed. New migrations land at 107+ (per the baseline plan's convention) so they don't collide with the baseline squash archiving 001-106. The baseline squash, whenever it runs, then folds these in and no longer special-cases 002. ONE plan (this one) owns the consolidation; baseline P-005 to be reconciled.

NEXT: present the concrete execution plan to the owner for sign-off before destructive drops (drop physical tables, retire template + scaffold).
Related: P-004, P-005, P-006, P-007
