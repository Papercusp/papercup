---
title: Abstract Papercusp's reusable systems into standalone libraries — per-subsystem seams and the extraction backlog
slug: papercusp-systems-abstraction-2026-05-29
status: ready
created: 2026-05-29
updated: 2026-05-30
owner: avi@storewolf.com
created-by-revision: R-001
companion-to: [papercusp-tooldef-extraction-2026-05-29]
---

# Abstract Papercusp's reusable systems into standalone libraries

How the general-purpose systems we built for Papercusp get carved out of
`apps/operator/lib/*` into standalone, project-agnostic libraries — what's
already done, what's trapped, the **real seam each one has** (there is no single
shared seam — that was a first-draft error, refuted by code; see D-003/D-010),
and the order to do it in.

## Now

**State:** Draft, **code-verified**. After the first draft, every Population-B
component was re-audited against the actual source (one adversarial reader per
component, hunting for the same mistake that bit the coord section). The audit
**refuted this plan's original keystone** (old D-003: "they all reach PG via
`withWorkspace()`/`inWorkspaceTxn()`, so one `WorkspaceStore` seam unlocks the
cluster"). That is false. The code uses **five different DB-access mechanisms**
across these subsystems (D-010), and two of them (locks, memory) cannot accept a
shared transaction handle at all. What *did* survive: the subsystems are **not
domain-coupled** — harness/feature/role nouns barely appear in their core logic,
so they are still extractable; just each behind its **own** injection seam, not
one shared one. Out of scope (other teams): endpoint/`defineTool`
([[papercusp-tooldef-extraction-2026-05-29]]) and the chat system
(`@restart/agent-chat` + `libs/papercup-shared/src/agent/chat-stream.ts`).

**Next:** Phase 1 is **shipped** (P-002/P-003/P-022 — see Addendum) and P-001
(the per-subsystem seam map) is **written** (final section). Phase 2 *code* work
is now fully spec'd but gated on two things outside this plan: (1) the canonical
checkout returning to `main` (it drifted onto `feat/psu-wrappers` during Phase 1),
and (2) paperclip pausing, since the heavy moves (locks ~2.4K LOC, coordination
~4.5K LOC) need a quiet checkout. Lowest-risk-first order once unblocked:
`rate-limit` → `backup` → `ipc-framing`/`desktop-ipc` → `locks`/`coordination`/
`search`/`memory`. P-000 (bundling) still needs a human but doesn't block.

## Background

### The question

"I really like a lot of the systems we built but they're tied to Papercusp. How
can we abstract them into a generalized library anyone can use?" Other agents
already own `defineTool` and chat; this plan covers **everything else** general
enough to share.

### What reading the code changed vs. the first-pass guess

Papercusp has *already* pushed a large reusable layer into `libs/` + `packages/`.
So the work isn't "find reusable code" — it's "free the reusable code still
trapped inside the app." Two populations:

**Population A — already factored out (just need publishing / promotion):**
`@restart/sse` (`libs/sse`), `@papercusp/token-kit` (`libs/token-kit`),
`@papercusp/host-platform` (`libs/host-platform`), `@papercusp/docs-engine`
(`packages/docs-engine`), `@papercusp/file-claim`
(`libs/papercusp/packages/file-claim`), plus the React libs `@restart/agent-chat`,
`@restart/git-graph`, `@restart/papergrid`, `@restart/ui-primitives`, and
`@papercusp/flags` (`libs/flags`). **Verified clean** (audit, 2026-05-29): all
nine carry zero `harness_shared.*` / `@restart/db-org` / domain-type imports.

**Population B — trapped in `apps/operator/lib/` (this plan's real work):**
`locks` (`agent-tools/locks/`, 2,364 LOC, own `papercusp_su` DB), `coordination`
(`agent-tools/coordination/`, ~4.5K LOC), `search` (`agent-tools/search/`,
`rrf.ts` is pure), `memory` (`lib/memory/` + `agent-tools/memory/`), `plans`
(`agent-tools/plans/`, parser tier is pure), `backup` (`lib/backup/` +
`agent-tools/backup/`). Plus small ones: `embedded-pg-discovery.ts` (58 LOC),
the Tauri IPC polyfill (`lib/transport-adapters/desktop-bootstrap.ts` +
`lib/endpoint-ipc/`), `prompt-assembly.ts`, `auth-rate-limit.ts`.

### There is NO single seam — there are five (refutes the first draft)

The first draft claimed every trapped subsystem reaches PG via
`withWorkspace()`/`inWorkspaceTxn()` and that one `WorkspaceStore` seam would
unlock them all. **Code-reading every component refuted this.** The actual
DB-access mechanisms (D-010):

| Mechanism | Who uses it | Can a shared `WorkspaceStore` tx-handle replace it? |
|---|---|---|
| (a) `withWorkspace(DEFAULT_WORKSPACE_ID, tx => …)` from `@restart/papercusp-db` | **plans lifecycle only** | yes — but plans lifecycle isn't being extracted |
| (b) locks-local `inWorkspaceTxn()` + **own pool** + **own `papercusp_su` DB** + `pg_advisory_xact_lock` (not RLS) | **locks** | **NO** — different DB, pool, and serialization model |
| (c) `getOrgPg()` raw admin client, no transaction | **backup, auth-rate-limit, memory side-effects** | partially — they want a `PgHandle{sql}`, not a tx unit-of-work |
| (d) mem0-owned `pg.Client`, allocated at construction | **memory core** | **NO** — mem0 owns the connection before any seam can inject one |
| (e) dispatcher `ctx.tx` from context-assembly (role-gated, optional — set only when a bearer resolves) | **search** | no — it's the dispatch pipeline, not a db-org call; reads are `try/catch`-guarded so an absent `ctx.tx` degrades to empty results, not a crash (P-013 makes it an explicit `PgHandle`) |

So the load-bearing correction: **abstract each subsystem behind its own
injection interface.** The only genuinely shared *discipline* (not a shared
type) is the `@papercusp/file-claim` pattern — a pure interface + conformance
suite + an injected dependency. The closest thing to a common primitive is a
minimal `PgHandle { sql }` that the three mechanism-(c) consumers can accept; it
is **not** a transaction-scoping `WorkspaceStore`, and it does **not** apply to
locks or memory.

## Audit results — the master table (code-verified 2026-05-29)

| System | Location | DB mechanism (D-010) | Coupling | Real seam | Verdict |
|---|---|---|---|---|---|
| **locks** | `agent-tools/locks/` (2,364 LOC, own `papercusp_su` DB) | (b) own pool + advisory lock | LOW | none — already `implements FileClaimCoordinator`, extract AS-IS | Extract as-is; keep internal txn + `papercusp_su` (P-010) |
| **coordination** | `agent-tools/coordination/` (~4.5K LOC) | files + (PG presence via `getOrgPg`) | LOW→MED | core + `CoordEventLog` + `PresenceStore` | Extract as 3 pieces, NOT 1 iface (P-011/P-012; D-009) |
| **rrf** | `agent-tools/search/rrf.ts` (45 LOC) | none | NONE | none — pure, lift wholesale | Extract now (P-002) |
| **search** | `agent-tools/search/` (fulltext+semantic) | (e) `ctx.tx`, unchecked | LOW-MED | source-registry adapter + embedder DI + pg-handle; fix `ctx.tx` bug | Extract w/ adapters (P-013, P-020) |
| **embedded-pg-discovery** | `lib/embedded-pg-discovery.ts` (58 LOC) | n/a (it RESOLVES the DSN) | NONE (but hardcoded) | inject discovery-path / env-names / db-name | Extract now + parameterize (P-003) |
| **memory / mem0** | `lib/memory/` + `agent-tools/memory/` | (d) mem0 owns conn; (c) side-effects | **LOW** (was MED) | PgDiscovery + Embedder + VectorStore (+ optional judge) | Extract w/ 3 seams, NOT WorkspaceStore (P-021) |
| **plans (parser tier)** | `parser.ts`+`effective-status.ts`+`content-hash.ts` (609 LOC) | none | NONE | none — pure | Extract pure tier (P-022) |
| **plans (lint + lifecycle)** | rest of `agent-tools/plans/` (~7.7K LOC) | (a) `withWorkspace` | MED-HIGH | lint couples to `source.ts` file I/O | Keep in-app (D-005) |
| **backup** | `lib/backup/` + `agent-tools/backup/` | (c) `getOrgPg`, no txn | LOW (+ hook coupling) | workspace-root + workspaceId + settings-table; NOT a tx | Extract w/ root+id+settings inj (P-023, P-024) |
| **Tauri IPC** | `lib/transport-adapters/` + `lib/endpoint-ipc/` | n/a | NONE (transport) / LOW (server.ts) | framing pure; server.ts injects dispatch+lookup+workspace+allowlist | Extract framing + transport + server (P-030) |
| **auth-rate-limit** | `lib/auth-rate-limit.ts` | (c) `getOrgPg`, no txn | NONE | inject `PgHandle` + options | Extract — ready (P-031) |
| **prompt-assembly** | `lib/prompt-assembly.ts` (~302 LOC) | n/a | HIGH (role enum + agent-mcp catalog) | blocked on tooldef catalog | Document; defer (D-008) |
| **orchestrator** | `libs/papercusp/packages/orchestrator/` (~2MB) | (a)+ | HIGH | — | Keep in-tree — it IS the harness (D-008) |

**Population A (already factored — publish/promote only):** `@restart/sse`,
`@papercusp/token-kit`, `@papercusp/host-platform`, `@papercusp/docs-engine`,
`@papercusp/file-claim`, `@restart/agent-chat`, `@restart/git-graph`,
`@restart/papergrid`, `@restart/ui-primitives`, `@papercusp/flags`.

**Explicitly out of scope (other teams):** endpoint/`defineTool`
([[papercusp-tooldef-extraction-2026-05-29]]); chat system.

**Keep in-tree (do not over-abstract):** orchestrator, roles/experts,
autoloop/goals, `zero-harness`, `papercup-shared` (shop domain), the nuqs
UI-control surface (document only — already in `CLAUDE.md`). All confirmed
domain-bound by audit.

## The coordination-storage question — resolved (see D-004, D-009)

The audit surfaced an apparent conflict: one read found JSONL file-backed coord
logs, another found `harness_shared.coord_*` PG tables. **Reading the code, both
are correct, and the split is deliberate, documented, shipped architecture** —
not drift. Authoritative source:
`apps/operator/docs/plans/agent-coordination-architecture-v2-2026-05-20.md`
(status: shipped), §2 "the layered model" and §4 "L1 — identity & presence".

What the code actually does, file by file:

| Concern | Backend | File | Why |
|---|---|---|---|
| messages + acks (outboxes) | **JSONL** `coord/messages/<ownerId>.jsonl` | `messages.ts` | per-sender outbox = one writer per file = zero contention, no lock; an OMP agent with no operator can still read/write directly |
| handoffs | **JSONL** `coord/handoffs/<msg_id>.json` | `handoffs.ts` | same portability rule; one file per event |
| escalations | **JSONL** `coord/escalations/<msg_id>.json` | `escalations.ts` | same |
| watermarks (read cursors) | **JSONL** `coord/watermarks/<ownerId>.json` | `watermarks.ts` | per-agent, single writer |
| subscriptions / watches | **JSONL** `coord/subscriptions/<ownerId>.jsonl` | `subscriptions.ts` | per-agent |
| plan-events feed | **JSONL** `coord/plan-events-<YYYY-MM>.jsonl` | `plan-events.ts` | single writer (operator), best-effort observability, not state |
| **live presence / heartbeat** | **PG** `harness_shared.coord_presence` (via raw `getOrgPg()`) | `presence.ts` | needs frequent concurrent heartbeat upserts + a LEFT JOIN to the durable `power_user_sessions` roster — file store can't do that cleanly |
| durable agent roster | **PG** `harness_shared.power_user_sessions` | (owned by OMP-bundle) | already shipped; coord *reads* it, never duplicates it |

The design rule (v2 §1, "Preserve portability" + §4.2): **L3 async channels and
the read-cursors are filesystem JSONL** precisely so an OMP agent running outside
Papercusp (no operator, no PG) still participates by direct fs reads/writes. The
operator adds tool-mediated UX on top, it is not a prerequisite. **L1 live
presence is PG** because it is many-writer heartbeat state that must JOIN the
durable roster — exactly what PG is for and files are not. (Note this is a
*different* `coord/` from the rust-port `coord/*.jsonl`, which keys on `action`
not `kind`; v2 §3.2 documents the two-schema reality. This plan's coordination
extraction governs the operator's typed-envelope files only.)

### Why these are NOT one logic over two storage engines

A first pass proposed extracting coordination as a single `CoordStore` interface
with two backends. **A line-by-line read of all eight modules shows that is
wrong** — the two sides have fundamentally different *data models*, not the same
operations over a swapped engine:

| Dimension | File surfaces (messages, handoffs, escalations, watermarks, subscriptions) | Presence (`presence.ts`, PG) |
|---|---|---|
| Data model | **append-only event log**; state is derived by scanning + folding at read time | **mutable single-row-per-owner** current-state |
| Read | union-scan files, filter/sort/graph-traverse in memory (`readInbox`, `readThread`, `listWatches`) | SQL `SELECT … LEFT JOIN power_user_sessions` (`listPresence`) |
| Write | append a line / write a sibling file (one writer per file) | `INSERT … ON CONFLICT DO UPDATE` upsert, `UPDATE`, `DELETE` |
| History | yes — the log *is* the state (acceptance/unsubscribe = new lines) | none — each heartbeat overwrites; reaped by staleness |
| Concurrency | single-writer-per-file invariant → **no locks** | **many** concurrent writers → needs `ON CONFLICT` |
| Portability | works fully detached, no server | requires operator + PG |
| Relational | none | joins the durable roster table |

An interface spanning both would need `append`+`scanAll` **and**
`upsertRow`+`joinRoster` — two unrelated contracts bolted together, an
abstraction in name only. They cannot honestly share one storage interface.

**One internal inconsistency found:** the file surfaces are not even uniformly
append-only. `handoffs.acceptHandoff` models acceptance as an append (a sibling
`handoff_accepted` file), but `escalations.resolveEscalation` does a
**read-modify-write in place** — despite `CoordKind` already defining an unused
`escalation_resolved` value (`envelope.ts:28`). Escalation is the lone mutating
file surface. See P-012.

**Recommendation (corrected):** extract coordination as **a shared pure core plus
two SEPARATE storage components**, not one dual-backend interface:

- **`coord-core` (pure, storage-agnostic):** `identity` + `envelope` + protocol
  logic (handoff state machine, escalation severities + resolve, watermark merge,
  glob `patternToRegex`, thread graph traversal, inbox filter predicates). Zero I/O.
- **`CoordEventLog` (the genuinely swappable seam):** the append-only channel
  surfaces. `append(line)` + `readAll(surface)` — a filesystem **or** an
  append-only PG table satisfy these identically. FS impl is the portable default.
- **`PresenceStore` (PG-shaped, do NOT pretend it's swappable):** upsert +
  roster-join. Shares `identity` + `envelope` types, not a storage interface.

## End state

- **No single shared seam.** Each extracted package defines its own injection
  interface (D-010). The only common artifacts are (i) the `file-claim` *pattern*
  — pure interface + conformance suite + injected dependency — and (ii) an
  optional minimal `PgHandle { sql }` accepted by the `getOrgPg`-based ones
  (backup, auth-rate-limit, memory side-effects, coord presence).
- ~4 published bundles (per D-002, gated on P-000):
  `@papercusp/agent-coord` (file-claim + locks + coord-core + CoordEventLog +
  PresenceStore — heterogeneous internally), `@papercusp/agent-retrieval`
  (rrf + search + memory + docs-engine), `@papercusp/plan-kit` (pure parser tier),
  `@papercusp/desktop-runtime` (embedded-pg-discovery + ipc-framing + desktop-ipc
  + ipc-endpoint-server; host-platform already exists).
- Each extracted package ships an in-memory/test impl + a conformance suite, and
  has zero `@papercusp`-domain imports in its core.
- Coordination ships as `coord-core` + `CoordEventLog` (fs default, optional PG)
  + `PresenceStore` (PG) — three pieces (D-009).
- Locks ship as-is, keeping their own `papercusp_su` DB and advisory-lock txn.
- Orchestrator, roles, autoloop, prompt-assembly stay in-app (documented why).

## Phase 0 — Scope lock

- **P-000** `done` Confirm the bundling decision (D-002): ship as ~4 (DEFERRED 2026-05-30 user: bundling rationale was publishing, but P-040 settled all libs stay private:true no npm publish — so bundling is moot until/unless a publish decision is made. Revisit then; do not re-litigate.) (Human decision 2026-05-30: KEEP PER-PACKAGE, no bundling — D-002 resolved/rejected. No npm publish all 12 private:true obviates the "publish unit" premise; coupling is sparse 4 dep edges among 12, 8 independent; bundling would force-couple independents + add export-routing for zero gain. Packages stay individually-testable file: deps.)
  bundles vs. one package per system. This sets every package boundary
  downstream. → D-001 D-002
- **P-001** `done` Write the per-subsystem seam map (NOT one shared seam — that
  was refuted, D-003/D-010): for each Population-B target, the exact injection
  interface it needs. Define the one genuinely-shared optional primitive — a
  minimal `PgHandle { sql }` — for the `getOrgPg`-based consumers (backup,
  auth-rate-limit, coord presence, memory side-effects). **Done** — see the
  "P-001 — Per-subsystem seam map" section at the end of this plan; specs every
  remaining seam (locks/coord/search/memory/backup/desktop-IPC/rate-limit) +
  the `PgHandle` primitive, grounded in the real `FileClaimCoordinator` interface
  (5 methods: acquire/release/extend/heartbeat/reap). → D-003 D-010

## Phase 1 — Pure extractions (no seam needed; can start now, in parallel)

- **P-002** `done` Extract `@papercusp/rrf` from `agent-tools/search/rrf.ts`
  (45 LOC, **zero imports**, verified pure — reciprocal rank fusion). Shipped at
  `f7f39bf5`: `packages/rrf` holds the verbatim `rrfCombine`/`RRF_K_DEFAULT`/
  `RankedItem<T>`/`FusedItem<T>` API (zero behavior change) + its 7-test suite
  (`src/index.test.ts`, passing). Both consumers rewired —
  `search/semantic.ts:23` AND `endpoint-route/routes/user/search.ts:137` (the
  audit's "sole consumer" was wrong; there were two) — and the `@papercusp/rrf`
  workspace dep declared. Lesson logged: a stray `git add -A` from paperclip
  swept the in-progress files into an unrelated commit (591eaf28) mid-extraction,
  leaving main briefly build-broken; recovered by committing the correct API +
  rewires. Note: root `npm install` is blocked by a PRE-EXISTING
  `@blocknote/mantine` ERESOLVE — symlink `node_modules/@papercusp/rrf` directly
  or use `--legacy-peer-deps`. → D-001
- **P-003** `done` Extract `@papercusp/embedded-pg-discovery` from
  `lib/embedded-pg-discovery.ts` (58 LOC, NONE coupling). **Audit correction:** it
  is NOT currently parameterizable — discovery path (`~/.papercusp/embedded-pg.json`),
  env-var names, and the native-fallback DB name (`papercusp`) are all hardcoded.
  Add a config/DI surface for those three; keep `getHarnessAdminUrl()` (used by
  11 call-sites) as the Papercusp-configured wrapper. → D-001
- **P-022** `done` Extract `@papercusp/plan-parser` — the **pure tier only**:
  `parser.ts` + `effective-status.ts` + `content-hash.ts` (609 LOC, verified zero
  domain imports). **Audit correction:** `lint.ts` is NOT pure — it imports
  `source.ts` (harness file discovery), so lint stays in-app. The full lifecycle
  (revisions, promote, launch, runs, CAS chunked writes, git history) stays in the
  operator (uses `withWorkspace`, mechanism (a)). → D-005

## Phase 2 — Locks + coordination (each its own seam)

- **P-010** `done` Extract `@papercusp/locks` from `agent-tools/locks/`, (@papercusp/locks shipped 0779d8f2 — core coordinator/su-lock-store/in-workspace-txn/workspace-listener/path-normalize/sql extracted; operator keeps 5 wrappers+identity+configure shim; seam=configureLocks{getAdminBaseUrl}; identity+subscriptions stay operator-side package imports neither. Verify: pkg tsc 0 + 15/15; op tsc 0 new; live-PG 73/73; live dispatch healthy.)
  **AS-IS**. **Audit correction:** do NOT inject a `WorkspaceStore`. `SuLocksCoordinator`
  already fully `implements FileClaimCoordinator` (conformance-tested) and has its
  own connection pool, its own `papercusp_su` database, and `pg_advisory_xact_lock`
  serialization (mechanism (b)) — none of which fit a shared tx handle. Move
  `su-lock-store.ts` / `coordinator.ts` / `in-workspace-txn.ts` (locks-local) /
  `workspace-listener.ts` / `path-normalize.ts` / `sql/`, keep the internal txn +
  side-DB, expose `SuLocksCoordinator`. The caller supplies an opaque
  `coordinationDomain` string (today: workspace UUID). → D-010
- **P-011** `done` Extract `@papercusp/coordination` as **three pieces, not one (@papercusp/coordination shipped — coord-core pure + CoordEventLog fs/in-mem seam + PresenceStore PG/in-mem; operator host-adapter barrels, 0 consumer rewires; commits 2c1529ca + 3ef62102)
  dual-backend interface** (D-009): (a) `coord-core` — pure `identity` +
  `envelope` + protocol logic; (b) `CoordEventLog` — `append`/`readAll` over the
  append-only channel surfaces, `FsCoordLog` default + optional PG log;
  (c) `PresenceStore` — PG upsert+roster-join (mechanism (c), `getOrgPg`), NOT
  behind the event-log interface. → D-004 D-009
- **P-012** `done` Normalize the lone mutating file surface: migrate (escalation log append-only — resolveEscalation appends escalation_resolved sibling, folds at read; commit f25af167)
  `escalations.resolveEscalation` from read-modify-write-in-place to emitting an
  `escalation_resolved` envelope (the `CoordKind` already exists, `envelope.ts:28`),
  matching `handoffs`. Makes `CoordEventLog` cleanly append-only (and PG-swappable).
  Pre-alpha, no users → safe to change the on-disk shape now. → D-009

## Phase 3 — Retrieval cluster (search + memory; each its own seam)

- **P-013** `done` **Hardening (pre-req for P-020) — re-verified 2026-05-30, NOT (explicit PgHandle contract — search sources take injected sql, not ambient ctx.tx 163d60b3)
  a crash bug:** `fulltext.ts` (4×) and `semantic.ts` (8×) read `ctx.tx`, which is
  optional — `http-projection.ts:331` sets it only when a bearer token resolves
  (`requirePrincipal: false`, so no-bearer calls leave it undefined). **Correction
  to the earlier audit:** it does NOT "throw on `undefined.sql`" — every one of the
  12 uses is inside a `try/catch` that `ctx.log?.(…skipped…)` and continues, so an
  absent `ctx.tx` degrades to **empty results per source**, not a crash. (Also:
  `routes/user/search.ts` does NOT use `ctx.tx` at all — it opens its own
  `pg.Client`; the earlier "search.ts:137 reads ctx.tx" was wrong, that line is the
  rrf import.) The real gap is a *silent* empty result when unauthenticated, and an
  *implicit* DB-access contract. Fix during P-020: inject an explicit `PgHandle`
  (the seam) so the extracted package's DB dependency is declared, not smuggled via
  an optional dispatcher field. Low urgency — pre-existing, graceful, and reworked
  by P-020 anyway. → D-010
- **P-020** `done` Extract `@papercusp/search` (BM25 + pgvector hybrid). Three (@papercusp/search wired; fulltext/semantic thin wrappers over SearchSource registry + embedder seam 0332afba + 163d60b3)
  seams (mechanism (e) today): (i) **source registry** — the 4 surfaces
  (escalations/brainstorm/turns/decisions) are hardcoded literal branches, not a
  registry; turn them into a `SearchSource` adapter callers register; (ii) **embedder**
  — already a cascade (`buildQueryEmbedder`) but hard-imports `readCredentials` +
  `loadVoicePrefs`; lift to injected DI; (iii) **pg-handle** — pass a `PgHandle`
  instead of relying on `ctx.tx`. Depends on `rrf` (P-002) + the `ctx.tx` fix
  (P-013). blocked-by: P-002, P-013 → D-010
- **P-021** `done` Extract `@papercusp/memory`. **Audit correction:** mem0 is an (@papercusp/memory extracted 28014805 — 6 store-core files moved mem0-client/connection/canonical-store/local-embedder-worker/reembed behind configureMemory seams; embedder lifted to operator as a pre-built fn mem0 always provider:custom; 26 consumers unchanged via shims; pgClientFields path preserved. pkg tsc0/vitest5, op tsc 779&lt;=781, op vitest 80/80)
  **external npm dep** (`mem0ai ^3.0.3`) that **owns its own `pg.Client`**
  (mechanism (d)) — so a `WorkspaceStore` cannot be injected. Real seams: (i)
  **PgDiscovery** (`async () => connFields`, replaces `getHarnessAdminUrl`);
  (ii) **EmbedderProvider** (OpenAI/local/disabled, replaces voice-prefs+env);
  (iii) **VectorStoreProvider** (canonical pgvector vs mem0 in-process). Scoping
  (`user:`/`harness:`) is **caller-supplied, not a seam**. The dedup judge
  (Claude) is **optional/feature-flagged** (`PAPERCUSP_MEMORY_DEDUP`, default off),
  not core. Coupling is **LOW** (revised from MEDIUM — core touches only
  `memory_*` tables, no harness/feature nouns). Leave `detect-harness-slug.ts` +
  pre-turn injection (`buildMemoryContextBlock` is generic but stays wired in
  operator). → D-010

## Phase 4 — Backup + desktop IPC + rate-limit

- **P-023** `done` Extract `@papercusp/backup` (kopia wrapper, ~95% CLI (@papercusp/backup extracted behind configureBackup host seam 73fa053d)
  passthrough). **Audit correction:** the real seam is NOT a PG tx handle. Backup
  uses raw `getOrgPg()` with no transactions (mechanism (c)); its dominant
  coupling is the **workspace-root filesystem path** (the kopia repo lives at
  `<workspaceRoot>/backups/kopia-repo`). Inject: workspace-root path + workspaceId
  + a settings-table accessor (table is `harness_shared.workspace_backup_settings`,
  **not** `workspace_backup_config` as the first draft said). Keep the load-bearing
  self-exclusion guard (`policy.ts` `IGNORE_PATTERNS` must contain `backups`;
  enforced on every `snapshot()` by `assertSelfExclusionPolicy`). → D-010
- **P-024** `done` Resolve backup's harness-lifecycle coupling: the (SnapshotTriggerReason opened to 'manual'|'interval'|string&{}; event reasons no longer baked into package 73fa053d)
  `SnapshotTriggerReason` enum (`pre_destructive`/`post_run`/`plugin_install`/
  `secret_change`/…) is hardcoded and `triggerSnapshotEvent` is called from
  git/restore/plugin call-sites. Externalize as a caller-registered trigger
  registry (or accept a loose string list) so the extracted package isn't bound to
  harness events. blocked-by: P-023 → D-010
- **P-030** `done` Extract the Tauri IPC stack as **three pieces** — 2 of 3 DONE: (pt3 @papercusp/ipc-endpoint-server shipped c74cbe70 — host seam; all 3 IPC pieces done)
  (i) **`@papercusp/ipc-framing` — DONE** (`775fb24e`): `framing.ts` (145 LOC, zero
  imports) → `packages/ipc-framing`, 16 tests, `endpoint-ipc/framing.ts` is a
  re-export shim (6 consumers unchanged). (ii) **`@papercusp/desktop-ipc` — DONE**
  (`e8f2a1c7`): extracted the **whole** `lib/transport-adapters/` dir (13 files:
  ipc-stream/ipc-fetch/ipc-event-source/desktop-bootstrap + http-stream +
  sse-parser + types + index picker), **74 tests** passing incl. jsdom-env ones.
  Corrected the earlier "extract only the 4 IPC files" note — that's NOT a clean
  cut (the IPC files share `types.ts`+`sse-parser.ts` with the HTTP path and the
  picker wires both), so the honest seam was the whole dir. Coupling external-only
  (`@tauri-apps/api`, `@restart/sse`, `@papercusp/tooldef`). Two shims
  (`transport-adapters/index.ts` + `desktop-bootstrap.ts` via a `./desktop-bootstrap`
  subpath export) keep all 4 consumers resolving unchanged — zero rewire.
  (iii) **`@papercusp/ipc-endpoint-server` — REMAINING (three attempts, all
  reverted clean; design DONE + package code correct, blocked ONLY on a
  vitest sibling-resolution config — see "attempt 3 root cause" below):**
  `endpoint-ipc/server.ts` (399 LOC) + `sys-http.ts` (225 LOC,
  self-contained). **Corrected design from the code read:** the runtime coupling
  is only **3** injected fns, not the plan's "4" — `dispatchProjectedToolStream`,
  `lookupByMcpName`, `getWorkspaceId` (wrapping `activeWorkspaceId`); the
  `allowedTools` "4th" is already a caller *option*, not a coupling. Wire shape:
  add a required `host: { lookupByMcpName, dispatchProjectedToolStream,
  getWorkspaceId }` to `StartEndpointIpcServerOptions`; `UnifiedToolContext` /
  `DispatchProjectedDeps` stay `import type` (no runtime dep); `./framing` →
  `@papercusp/ipc-framing`. Package deps: `@papercusp/ipc-framing` + `@papercusp/agent-mcp`
  (type-only) + `@papercusp/tooldef` (the test's `registerProjectedTool`/
  `classifyEventWire` — already shipped). Consumers to rewire: the boot site
  `instrumentation-node.ts` (~line 445, pass `host:` alongside the existing
  `deps`/`allowedTools`), and a re-export shim at `endpoint-ipc/server.ts` for
  `dev_ipc_echo_e2e.test.ts`. `sys-http.ts` has NO external consumer (only a
  doc-comment mention) — moves cleanly.

  **Attempt 1 reverted:** `git mv`'d sys-http out before the shim → original
  `server.ts`'s `./sys-http` dangled = main briefly broken. Lesson applied in
  attempt 2: use `cp` (originals stay intact until the end), write-package-first.

  **Attempt 2 (cp-based, main NEVER broke) — got the package fully built + 31/33
  tests passing, then reverted on a real harness artifact:**
  - Built `packages/ipc-endpoint-server`: `server.ts` (host-seam DI), `sys-http.ts`
    (verbatim, `./framing`→`@papercusp/ipc-framing`), `index.ts` barrel,
    package.json (deps: `@papercusp/ipc-framing` + `@papercusp/tooldef`), README.
  - **NEW resolution requirement discovered:** this is the FIRST extracted package
    whose *tests* import sibling `@papercusp/*` packages, and standalone `vitest run`
    in a bare package cannot resolve their raw-`.ts` entry points. Fix = a package
    `vitest.config.ts` with BOTH `server.deps.inline: [/^@papercusp\//]` (tooldef
    already has the inline half) AND `resolve.alias` mapping
    `@papercusp/ipc-framing` + `@papercusp/tooldef` to `../<pkg>/src/index.ts`.
    With that, resolution worked and **31 tests passed** (all 12 sys-http, binds,
    allowlist, unknown-tool, errors).
  - **The 2 remaining failures are a harness artifact, NOT a code defect:** the
    streaming-dispatch + cancel integration tests register a synthetic tool via
    `registerProjectedTool` and rely on `dispatchProjectedToolStream` reading the
    SAME module-singleton registry. Aliasing `@papercusp/tooldef` instantiates a
    SECOND tooldef module → the test's registry ≠ dispatch's registry → no stream.
    The extracted `server.ts` is byte-identical to the working original (only the
    framing import + host injection changed, both covered by the 31 green tests).
  - Reverted clean (cp originals untouched; `rm` the new pkg + symlink); main
    green, zero residue, 6 prior packages intact.

  **Attempt 3 — ROOT CAUSE nailed (main NEVER broke; reverted clean incl. a
  trial ipc-framing exports change):** the package built fine; the blocker is
  purely standalone-vitest sibling resolution, and the precise mechanism is now
  known:
  - This is the FIRST extracted package whose **test files directly import two
    sibling `@papercusp/*` `.ts` packages** (`ipc-framing` + `tooldef`).
    `desktop-ipc` gets sibling resolution "for free" because it imports its one
    sibling (`tooldef`) in **non-test src** that vite bundles, and it has **no
    vitest.config** (pure vitest defaults).
  - **Two distinct sub-issues, both confirmed by node-vs-vite tests:**
    (1) `@papercusp/ipc-framing` uses **string-shorthand `exports`**
    (`{".":"./src/index.ts"}`) which vite's resolver won't follow as a dependency
    entry; switching it to the conditional-object form (like `tooldef`) fixed
    `ipc-framing` resolution. (`docs-engine`/`rate-limit` also use the shorthand
    but resolve in the operator via vite-tsconfig-paths, NOT standalone — so the
    shorthand is a latent standalone-vitest footgun across our packages.)
    (2) `@papercusp/tooldef` (object exports, node-resolvable, resolves fine for
    `desktop-ipc`) still failed once I **added a custom `vitest.config.ts`** —
    because a hand-written config **replaces** vitest's default resolution rather
    than extending it. `node require.resolve('@papercusp/tooldef')` succeeds from
    the package dir, so the symlink is correct; vite just needs the repo's base
    resolver.
  - **Turnkey redo (validated path):** create the package's `vitest.config.ts` by
    **extending the repo base** — `import { defineVitestConfig } from
    '@papercusp/test-config'` (or `mergeConfig` with it) the way `apps/operator`
    does — instead of a bare `defineConfig`; that pulls in vite-tsconfig-paths +
    `deps.inline` so both siblings resolve as a **single instance** (keeping
    tooldef's registry shared, so the 2 streaming/cancel tests pass too). Pair
    with switching `ipc-framing`'s `exports` to object form (its own 16 tests use
    relative `./index` imports, so unaffected; the operator consumes it via the
    shim, also unaffected — net-positive consistency fix). Fallback if base-config
    resolution still fights: keep the registry-dependent `server.test.ts`
    dispatch/cancel cases in `apps/operator` (operator vitest, single tooldef) and
    ship the package with its standalone-safe tests (sys-http, bind, allowlist).
  - **Do NOT** use `resolve.alias` for `tooldef` (forks its registry — the
    attempt-2 failure) and do NOT hand-roll a config that drops the base resolver
    (the attempt-3 failure). This is the libsoup pool-exhaustion fix. → D-006
- **P-031** `done` Extract `@papercusp/rate-limit` from `lib/auth-rate-limit.ts`
  (2-bucket, PG-durable; **verified zero domain coupling**, generic string keys).
  **Shipped** (`packages/rate-limit`, 8 unit tests, on `main`). **Seam deviation:**
  used an injected `BucketStore` (`read`/`write`/`delete`/`gcStale`/`clearPrefix`)
  instead of the planned `PgHandle`+table — safer for security-sensitive login
  code (parameterizing a schema-qualified table identifier into postgres-js tagged
  SQL is error-prone); the operator keeps its exact `harness_shared.auth_rate_limit`
  SQL verbatim inside a `BucketStore` impl while the package owns the algorithm.
  `isLoopbackIp()` exported as a reusable helper. `auth-rate-limit.ts` is now a thin
  host adapter; **zero consumer rewire** (login.ts + 2 test files unchanged). The
  opaque-session `auth.ts` follow-on remains optional/lower-priority. → D-010

## Phase 5 — Promote what's already factored (Population A)

- **P-040** `wip` Publish/promote the already-clean libs (audit confirmed all (ALL LIBS STAY private:true — agents have private-repo access, no npm publish [user 2026-05-30]. READMEs added host-platform+docs-engine 97b5c755; all 9 have READMEs. Submodule packaging DONE 2026-05-30: token-kit→0.1.0 (e808c0d), ui-primitives private:true+desc (8075a3c), papergrid version+desc (9eb01cb); superproject pointers bumped e5736201 — LOCAL-ONLY, not pushed (don't-push-without-asking; coordinated submodule push still owed). REMAINING: only git-graph private:true+desc — its package.json has another agent's uncommitted react-diff-view edit, so a clean P-040-only commit isn't possible; do it when that lands. agent-chat excluded chat, D-001.)
  nine carry zero domain imports): `@restart/sse`, `@papercusp/token-kit`,
  `@papercusp/host-platform`, `@papercusp/docs-engine`, `@papercusp/file-claim`,
  the four React libs, `@papercusp/flags`. Packaging only (versioning, README).
  → D-007

## Phase 6 — Verification

- **P-050** `done` Each extracted package: its in-memory/test impl passes the (12/12 extracted-package suites green rrf7 epd6 plan-parser5 rate-limit8 ipc-framing16 desktop-ipc43 ipc-endpoint22 backup11 search9 locks15 memory5 coordination31. Search had ZERO tests — added engine conformance suite 5f177bc2 fan-out/RRF/degradation. Dual-impl swappability confirmed: coordination Fs+InMem log, Pg+InMem presence, file-claim, rate-limit. Operator tsc stable at 779.)
  same conformance suite as the production impl; the operator re-points at the
  package with no behavior change; existing suites green. blocked-by: P-010,
  P-011, P-012, P-013, P-020, P-021, P-022, P-023, P-024, P-030, P-031
- **P-051** `done` Proof-of-genericity: stand up one extracted package (recommend (Detached proof: throwaway /tmp script outside the repo imported @papercusp/coordination by absolute path and exercised core + FsCoordLogtempdir + InMemoryCoordLog + InMemoryPresenceStore — 13/13 checks pass with operator AND postgres absent. Any hidden @/operator coupling would have failed to resolve. Confirms genuine host-agnostic / detached mode.) (detached-mode proof shipped — examples/detached-mode.ts runs @papercusp/coordination core + FsCoordLog with zero operator/PG, exits 0; commit 89d3b1c3)
  `@papercusp/coordination` via the `FsCoordLog` event-log) in a throwaway
  non-Papercusp script with zero operator/PG present, to prove detached mode
  works. blocked-by: P-011

## Decisions

### D-001 — Scope: everything reusable except endpoint + chat
Date: 2026-05-29
This plan covers all general-purpose systems EXCEPT the two already in flight:
the endpoint/`defineTool` system ([[papercusp-tooldef-extraction-2026-05-29]])
and the chat system (`@restart/agent-chat` + `chat-stream.ts`). Those are owned
by other agents; duplicating them here would collide. User framing, 2026-05-29.

### D-002 — Bundle into ~4 packages, not ~12 micro-libs (proposed, needs P-000)
Date: 2026-05-29
The systems cluster by shared dependency, so the recommendation is ~4 bundles —
`@papercusp/agent-coord`, `@papercusp/agent-retrieval`, `@papercusp/plan-kit`,
`@papercusp/desktop-runtime`. Note (post-audit) these bundles are **internally
heterogeneous** — e.g. `agent-coord` contains a self-contained side-DB lock
package (locks) next to a fs-default event log (coord); the bundle is a publish
unit, not a shared-architecture claim. Final call gated on P-000.

### D-003 — REFUTED: there is no single storage seam (superseded by D-010)
Date: 2026-05-29
**Original (wrong) decision:** "The trapped subsystems share exactly one coupling
— PG access via `withWorkspace()`/`inWorkspaceTxn()` + hardcoded `harness_shared.*`
— so define one `WorkspaceStore` seam and inject it everywhere." A per-component
adversarial code read (2026-05-29) **refuted this**: there are five distinct
DB-access mechanisms, and locks (own DB + advisory lock) and memory (mem0 owns
the connection) cannot accept a shared tx handle at all. What survives: the
subsystems are **not domain-coupled**, so they are still extractable — but each
behind its own seam. See D-010 for the corrected model. This entry is kept (not
deleted) as the audit-trail record of the correction.

### D-004 — The file+PG hybrid is correct and deliberate
Date: 2026-05-29
Resolves the audit's open question on *why* coordination has two backends. The
hybrid is deliberate, shipped architecture (`agent-coordination-architecture-v2-2026-05-20.md`,
§2/§4), not drift. L3 async channels + read-cursors are JSONL files (`coord/*`) so
a detached OMP agent with no operator/PG still participates by direct fs I/O
(stated portability goal); L1 live presence is PG (`harness_shared.coord_presence`)
because it's many-writer heartbeat state that JOINs the durable
`power_user_sessions` roster. Do NOT collapse to PG-only — that deletes
detached-mode portability. (How to *package* this is D-009.)

### D-005 — Plans: extract the pure PARSER TIER only; lint + lifecycle stay in-app
Date: 2026-05-29
**Audit correction to the first draft** (which said "parser + lint"). The pure,
zero-import tier is `parser.ts` + `effective-status.ts` + `content-hash.ts`
(609 LOC) → `@papercusp/plan-parser`. `lint.ts` is NOT pure — it imports
`source.ts` (harness file discovery) — so it stays in-app. The lifecycle
(revisions, promote-to-features, launch, runs, CAS chunked writes, git history)
uses `withWorkspace(DEFAULT_WORKSPACE_ID, …)` (mechanism (a)) and stays in the
operator. The clean DAG (parser ← effective-status ← lint ← source) has no
cycles, so the parser-tier cut is safe.

### D-006 — Tauri IPC: extract as 3 pieces; server needs 4 injection points
Date: 2026-05-29
**Audit refinement of the first draft** ("pluggable dispatch"). The transport
(`desktop-bootstrap.ts` + friends) and the framing codec (`framing.ts`) are
**zero-coupling** and extract cleanly as `@papercusp/desktop-ipc` +
`@papercusp/ipc-framing`. The coupling lives only in `endpoint-ipc/server.ts`,
which is already DI-shaped (`DispatchProjectedDeps`) and needs FOUR injected
deps, not one: `dispatchProjectedToolStream`, `lookupByMcpName`, `getWorkspaceId`,
and the tool allowlist. Extract the server as `@papercusp/ipc-endpoint-server`
with those injected. Solves the WebKitGTK/libsoup `max-conns-per-host=6` problem.

### D-007 — Population A is publish-work, not extraction-work
Date: 2026-05-29
The libs already in `libs/`+`packages/` (sse, token-kit, host-platform,
docs-engine, file-claim, the four React libs, flags) were audited 2026-05-29 and
confirmed to carry zero `harness_shared.*` / `@restart/db-org` / domain-type
imports. Treat them as a packaging/publish pass (P-040), not re-architecture.

### D-008 — Keep the harness core in-tree
Date: 2026-05-29
Orchestrator (`libs/papercusp/packages/orchestrator/`, ~2MB), roles/experts,
autoloop/goals, `zero-harness`, and `papercup-shared` are the Papercusp domain
itself (audit-confirmed: heavy harness/feature/role/shop imports); extracting
them would just recreate a generic agent runner with none of the value. The nuqs
UI-control surface is a *pattern* to document (already in `CLAUDE.md`), not a
library. `prompt-assembly.ts` is HIGH-coupled (audit-confirmed: hardcoded 10-role
enum at `prompt-assembly.ts:67-77` + direct `listAllProjectedTools()` call into
`@papercusp/agent-mcp` + hardcoded `apps/operator/prompts/` fs paths) — document
the layering pattern, defer extraction until the tooldef work
([[papercusp-tooldef-extraction-2026-05-29]]) settles the catalog interface.

### D-009 — Coordination = pure core + TWO separate stores, not one interface
Date: 2026-05-29
A first draft proposed a single `CoordStore` interface with file and PG backends.
A line-by-line read of all eight coordination modules refuted that: the file
surfaces and presence are **different data models, not one logic over two
engines.** File surfaces are an *append-only event log* (state derived by
scanning + folding: `readInbox` union-scans outboxes, `readThread` graph-walks
`related_msg_id`, `listWatches` folds subscribe−unsubscribe), single-writer-per-
file, no locks, history-bearing, portable. Presence is a *mutable single-row-per-
owner* table (`INSERT … ON CONFLICT DO UPDATE`, `UPDATE` heartbeat, `DELETE`),
many concurrent writers, no history, relational (`LEFT JOIN power_user_sessions`).
A shared interface would need `append`+`scanAll` AND `upsertRow`+`joinRoster` —
two unrelated contracts in a trenchcoat. So extract as: (1) `coord-core` (pure
identity + envelope + protocol), (2) `CoordEventLog` (the only honestly swappable
seam — `append`/`readAll`, fs default + optional PG), (3) `PresenceStore` (PG,
not behind the log interface). The user's "keep them separate, share certain
components" instinct was correct; this decision records it against the code.

### D-010 — Five DB-access mechanisms → a per-subsystem seam, not one shared seam
Date: 2026-05-29
The corrected replacement for D-003. The per-component code audit found the
trapped subsystems reach the database five different ways:
(a) `withWorkspace(DEFAULT_WORKSPACE_ID, tx => …)` from `@restart/papercusp-db` —
**plans lifecycle only**;
(b) locks-local `inWorkspaceTxn()` + its own pool + its own `papercusp_su` DB +
`pg_advisory_xact_lock` (not RLS) — **locks**;
(c) raw `getOrgPg()` with NO transaction — **backup, auth-rate-limit, coord
presence, memory side-effects**;
(d) a mem0-owned `pg.Client` allocated at construction — **memory core**;
(e) the dispatcher's `ctx.tx` from context-assembly, optional and currently
unchecked — **search**.
Consequences: (b) and (d) **cannot** accept a shared tx handle (different DB /
pre-owned connection); (a) is the only one matching the first draft's assumption,
and it isn't being extracted. Therefore: **abstract each subsystem behind its own
injection interface.** The only genuinely shared artifacts are the `file-claim`
*pattern* (pure interface + conformance + injected dep) and an OPTIONAL minimal
`PgHandle { sql }` for the mechanism-(c) consumers. There is no single
`WorkspaceStore` that unlocks the cluster; P-001 is documentation of the per-
subsystem seams, not a blocking gate, and Phase 1 (rrf / embedded-pg-discovery /
plan-parser) needs no seam at all.

## Addendum — Phase 1 shipped (2026-05-30) + impact on in-flight plans

Phase 1 (the three no-seam pure extractions) is **done and on `main`**. This
records exactly what changed and how it affects the four plans whose agents were
paused for this extraction window.

### What shipped

| Item | Package | Commit | Approach | Consumer impact |
|---|---|---|---|---|
| **P-002** | `@papercusp/rrf` | `f7f39bf5` | move + rewire | `search/semantic.ts` and `endpoint-route/routes/user/search.ts` now import `rrfCombine`/`RRF_K_DEFAULT` from `@papercusp/rrf`; old `agent-tools/search/rrf.ts` **deleted** |
| **P-003** | `@papercusp/embedded-pg-discovery` | `68e5116a` | wrapper | none — `lib/embedded-pg-discovery.ts` is now a thin wrapper around `resolvePgUrl({envVars,discoveryFile,fallbackUrl})`; all `getHarnessAdminUrl` callers untouched |
| **P-022** | `@papercusp/plan-parser` | `e96f63f3` | move + re-export shim | none — `plans/{parser,effective-status,content-hash}.ts` are now one-line re-exports of the package; **33 import sites (all in `apps/operator/`)** resolve unchanged — verified repo-wide, zero in operator-vite/libs |

17 package tests green (7 + 5 + 5); all three resolve from the operator. Pattern
for all three: a new `packages/<name>/` with **src-as-entry** (no build step,
mirrors `@papercusp/docs-engine`), the package owns its vitest suite, and
`node_modules/<pkg>` is **symlinked directly** because root `npm install` is
blocked by a **pre-existing `@blocknote/mantine` ERESOLVE** (unrelated to this
work — don't chase it; use the symlink or `--legacy-peer-deps`).

### Two known follow-ups (not blockers)

- **P-013** (already in Phase 3): `search/semantic.ts` + `search/fulltext.ts` read
  `ctx.tx`, which is optional. **Re-verified 2026-05-30:** NOT a null-deref — every
  use is `try/catch`-guarded, so an absent `ctx.tx` (no-bearer call) degrades to
  empty results, not a crash; `routes/user/search.ts` doesn't use `ctx.tx` at all.
  Untouched by P-002 (import-only). The gap (silent-empty + implicit DB contract)
  is fixed by injecting a `PgHandle` during the P-020 search extraction.
- **P-023b** (new): rewire the 33 `plan-parser` consumers to import
  `@papercusp/plan-parser` directly and delete the three re-export shims.
  Deferred because paperclip was actively `git add -A`-committing the shared
  checkout during this window, making a 33-file rewire unsafe to land atomically.

### Impact on the four paused plans

- **`search-STATUS-2026-05-29`** — **directly affected**. RRF is no longer a
  local module: any work on `search/semantic.ts` or
  `endpoint-route/routes/user/search.ts` must import from `@papercusp/rrf` (not
  `./rrf`, which is gone). The hybrid-search source-registry + embedder-DI +
  `ctx.tx` cleanup remain this plan's territory — coordinate against P-013/P-020
  here so we don't collide; RRF itself is now settled upstream.
- **`scout-refactor-STATUS-2026-05-29`** and
  **`data-fetch-surfaces-strategy-2026-05-29`** — search/retrieval-adjacent. No
  files of theirs changed, but if either touches the search ranking path, the
  same "import RRF from `@papercusp/rrf`" rule applies and the `ctx.tx` (P-013)
  hazard is live in that surface.
- **`papercusp-tooldef-extraction-2026-05-29`** (companion) — no conflict, and a
  small upside: `@papercusp/embedded-pg-discovery` is now a clean PG-dep-free
  package and `@papercusp/plan-parser` is importable without the operator, both
  consistent with that plan's D-007 goal ("core has zero `@papercusp`/`@restart`/
  PG deps").

No edits were made to the four plans themselves; this addendum is the single
source of truth for the cross-plan effect. Agents resuming those plans should
read it first.

## P-001 — Per-subsystem seam map (the Phase-2 contract specs)

The corrected replacement for the refuted single-`WorkspaceStore` idea (D-003 →
D-010). There is **no shared seam**; each remaining Population-B subsystem gets
its **own** injection interface, derived from the per-component code audit. The
signatures below are the *design target* — each extraction still re-reads its
source before coding (the discipline that caught the keystone error), but this
is the contract to build to.

### The template (every seam follows it)

`@papercusp/file-claim` is the proven shape, verified against
`libs/papercusp/packages/file-claim/src/index.ts`:

- A **vocabulary-only package** — types + a conformance suite, importing nothing
  from any backend. Backends import *it*; the dependency is one-way, so a new
  backend (Redis/etcd/in-memory) joins by satisfying the shape.
- The real `FileClaimCoordinator` is **5 methods** — `acquire` / `release` /
  `extend` / `heartbeat` / `reap` (verified directly in the source; an earlier
  draft of this section wrongly "corrected" it to 4 with an invented `inspect` —
  the sub-agent audit was right here. Quote the source, not your memory of it.)
  Notable contract details from the header: `extend` returns a *fresh* claim
  (never mutates the input), `release` is idempotent, empty-path acquire is legal,
  `acquire` carries `waitMs` so blocking and try-only backends share one method.
- Every extracted seam ships an **in-memory implementation** that passes the
  *same* conformance suite as the production (PG/fs) one — that's the P-050 gate.

### The one optional shared primitive — `PgHandle`

Not a transaction/unit-of-work (that was the D-003 mistake). Just a query handle:

```ts
interface PgHandle { sql: <T = Row>(strings: TemplateStringsArray, ...vals: unknown[]) => Promise<T[]> }
```

Consumed by the four **mechanism-(c)** subsystems (raw `getOrgPg()`, no txn):
backup settings, auth-rate-limit, coord `PresenceStore`, memory side-effects.
The operator passes `{ sql: getOrgPg().sql }`; tests pass a Map-backed fake or a
testcontainer handle. **Not** consumed by locks (own pool/DB) or memory-core
(mem0 owns its connection).

### locks → `@papercusp/locks` (P-010) — seam: NONE NEW

Already `implements FileClaimCoordinator`. Extract **as-is**: keep the dedicated
`papercusp_su` connection pool, the locks-local `inWorkspaceTxn`, and the
`pg_advisory_xact_lock` serialization (mechanism (b)) — a shared handle *cannot*
provide these. The caller supplies only an opaque `coordinationDomain: string`
(today = workspace UUID). The `@papercusp/file-claim` conformance suite + the
in-process `FileLockQueue` are the ready-made double. **Do not** inject a
`PgHandle`/`WorkspaceStore`. Stays in operator: the `papercusp_su` bootstrap +
identity→ownerId resolution.

### coordination → `@papercusp/coordination` (P-011, P-012; D-009) — 3 pieces

1. **`coord-core`** (pure, no seam): `resolveAgentIdentity`/`AgentIdentity`,
   `CoordEnvelope`/`newMsgId`/`CoordKind`, and the protocol logic (handoff state
   machine, escalation severities + resolve, watermark merge, `patternToRegex`,
   thread graph traversal, inbox filter predicates). Zero I/O.
2. **`CoordEventLog`** seam — the append-only channel surfaces:
   ```ts
   interface CoordEventLog {
     append(surface: string, line: CoordEnvelope): Promise<void>;
     readAll(surface: string): Promise<CoordEnvelope[]>;
   }
   ```
   Ships `FsCoordLog` (default, portable — per-sender JSONL under `coord/`, the
   detached-mode path) + an optional PG-backed log. Covers messages/acks/
   handoffs/escalations/watermarks/subscriptions/plan-events. **Prereq P-012:**
   migrate `escalations.resolveEscalation` from in-place mutation to an
   `escalation_resolved` append so the log is cleanly append-only (and therefore
   honestly PG-swappable).
3. **`PresenceStore`** seam — the PG upsert + roster-join (mechanism (c), takes a
   `PgHandle`), kept **separate** from the event log because it's a different
   data model (D-009):
   ```ts
   interface PresenceStore {
     write(identity: AgentIdentity, input: PresenceInput): Promise<void>; // upsert
     touchHeartbeat(ownerId: string): Promise<void>;                      // UPDATE
     clear(ownerId: string): Promise<void>;                               // DELETE
     list(opts: { workspaceId?: string | null }): Promise<PresenceRecord[]>; // SELECT … LEFT JOIN roster
     get(ownerId: string): Promise<PresenceRecord | null>;
   }
   ```
   The roster table (`power_user_sessions`) is a config arg to the PG impl.
   Stays in operator: `coord/` path resolution, roster ownership, MCP wiring.
   Doubles: in-memory `CoordEventLog` (Map of arrays) + in-memory `PresenceStore`
   (Map of rows).

### search → `@papercusp/search` (P-013 prereq, P-020) — 3 seams

**Prereq P-013:** make the DB-access contract explicit. Today `ctx.tx` is an
optional dispatcher field (undefined on no-bearer calls); the reads are
`try/catch`-guarded so absence degrades to empty results (not a crash — see P-013).
Replacing it with the injected `PgHandle` below removes the implicit dependency.
Reuses the already-shipped `@papercusp/rrf` for fusion. Seams:

1. **`SearchSource`** registry — replaces the 4 hardcoded `escalations/brainstorm/
   turns/decisions` branches:
   ```ts
   interface SearchSource {
     key: string;            // 'escalations'
     table: string;          // 'harness_shared.harness_escalations'
     tsvColumn: string;      // BM25 tsvector column
     vecColumn?: string;     // pgvector column (omit → BM25-only for this source)
     toHit: (row: Row) => Hit;
   }
   ```
2. **`EmbedderProvider`** — `(text: string) => Promise<number[] | null>` (null →
   BM25-only fallback). Replaces the hard-imported `readCredentials` +
   `loadVoicePrefs` cascade.
3. **`PgHandle`** — replaces `ctx.tx`.

Stays in operator: the 4 concrete `SearchSource` registrations, the embedder-mode
resolution, MCP wiring. Doubles: Map-backed `PgHandle` over fixture rows +
identity embedder.

### memory → `@papercusp/memory` (P-021) — 3 seams + 1 optional

**Not** a `PgHandle`/`WorkspaceStore` for the core: mem0 (`mem0ai`, external dep)
owns its own `pg.Client` at construction (mechanism (d)). Seams:

1. **`PgDiscovery`** — `() => Promise<{host,port,user,password,database}>`
   (replaces `getHarnessAdminUrl`; can be produced by `@papercusp/embedded-pg-discovery`).
2. **`EmbedderProvider`** — OpenAI/local/disabled (same shape as search's → a
   future shared `@papercusp/embedder` could serve both).
3. **`VectorStoreProvider`** — canonical pgvector vs mem0 in-process.
4. *(optional)* **`LlmJudge`** — dedup `(a, b) => Promise<boolean>`; default no-op
   (feature-flagged off today, `PAPERCUSP_MEMORY_DEDUP`).

Scoping (`user:`/`harness:`) is **caller-supplied, not a seam**. Stays in
operator: `detect-harness-slug.ts`, the pre-turn `buildMemoryContextBlock`
wiring, `getSessionUserOrDefault`. Doubles: in-memory VectorStoreProvider +
identity embedder + no-op judge.

### backup → `@papercusp/backup` (P-023, P-024) — seam is host-config, NOT a tx

Dominant coupling is the **workspace-root filesystem path** (the kopia repo lives
at `<workspaceRoot>/backups/kopia-repo`); PG access is raw `getOrgPg()` with no
transaction (mechanism (c)). Seam:

```ts
interface BackupHost {
  workspaceRoot: string;   // anchors kopia repo + pre-snapshot pglite hook
  workspaceId: string;     // settings/event row key
  pg: PgHandle;            // settings: harness_shared.workspace_backup_settings; events: backup_events
  kopiaBin?: string;       // default 'kopia'
}
```

**P-024:** externalize the `SnapshotTriggerReason` enum (`pre_destructive`/
`post_run`/`plugin_install`/`secret_change`/…) into a caller-registered trigger
registry so the package isn't bound to harness lifecycle events. **Keep** the
load-bearing self-exclusion guard — `IGNORE_PATTERNS` must contain `backups`,
enforced every snapshot by `assertSelfExclusionPolicy` (else the kopia repo
recursively snapshots itself toward 1TB). Doubles: `PgHandle` fake + a temp
`workspaceRoot`; kopia stubbed in unit, real in integration.

### desktop-IPC → 3 packages (P-030; D-006)

1. **`@papercusp/ipc-framing`** — `framing.ts`, pure binary codec, zero coupling,
   no seam (property-test the encode/decode roundtrip).
2. **`@papercusp/desktop-ipc`** — `desktop-bootstrap.ts` (`IpcEventSource`,
   `ipcFetch`, `installDesktopIpcPolyfills`) + `ipc-fetch`/`ipc-event-source`/
   `ipc-stream`. **Re-scoped 2026-05-30 — NOT a clean 4-file cut (deferred).**
   The audit said "4 IPC files, zero coupling"; the actual import graph in
   `lib/transport-adapters/` refutes a simple lift: the IPC files depend on
   **shared siblings** — `ipc-stream.ts`→`types.ts`; `ipc-event-source.ts`→
   `types.ts`+`sse-parser.ts`; `ipc-fetch.ts`→`ipc-stream.ts`+`types.ts` — and
   `types.ts` + `sse-parser.ts` are ALSO consumed by the HTTP path
   (`http-stream.ts`) and the `index.ts` transport-picker, which wires IPC+HTTP
   together behind a Tauri feature-detect. So extracting "just the 4 IPC files"
   would orphan or duplicate `types.ts`/`sse-parser.ts`. The honest seam is one
   of: (a) extract the WHOLE `transport-adapters/` dir as `@papercusp/desktop-ipc`
   (IPC **and** HTTP transport + shared types/sse-parser — it's a cohesive
   "endpoint-stream transport" unit, arguably the right boundary), or (b) leave
   it in-app. Decide (a) vs (b) before coding; do NOT do the 4-file cut. The
   `ipc-framing` codec (piece 1) is already cleanly out, which was the genuinely
   pure part. Coupling here is LOW (Tauri/`window` globals, no harness domain),
   so (a) is viable — but it's a ~9-file move, not the "zero-coupling" trivial
   one the audit implied.
3. **`@papercusp/ipc-endpoint-server`** — `endpoint-ipc/server.ts`, already
   DI-shaped (`DispatchProjectedDeps`); needs **four** injected deps, not one:
   ```ts
   interface IpcEndpointServerDeps {
     dispatch: typeof dispatchProjectedToolStream;
     lookupByMcpName: (name: string) => ProjectedTool | undefined;
     getWorkspaceId: () => string;
     toolAllowlist: string[];
   }
   ```
   This is the WebKitGTK/libsoup `max-conns-per-host=6` starvation fix.

### auth-rate-limit → `@papercusp/rate-limit` (P-031) — lowest-risk

Zero domain coupling, generic string keys, raw `getOrgPg()` no-txn (mechanism
(c)). Seam:

```ts
interface RateLimitConfig {
  pg: PgHandle;
  table?: string;                                    // default 'harness_shared.auth_rate_limit'
  soft?: { windowMs: number; capacity: number };     // default 10 / 60s per IP
  hard?: { windowMs: number; capacity: number; lockoutMs: number }; // default 5 / 15m, 5m lockout
}
```

`isLoopbackIp()` is reusable as-is. Double: Map-backed `PgHandle`.

### Phase-2 readiness

With this map, every remaining extraction has a defined target. The two gates
before Phase-2 *code* work (not this doc) start: (1) the canonical checkout is
back on `main` (it drifted onto `feat/psu-wrappers` during Phase 1 — see the
Addendum), and (2) paperclip is paused, since locks (~2.4K LOC) and coordination
(~4.5K LOC) are large multi-file moves that the `git add -A` sweeper would
otherwise fragment. Lowest-risk first once unblocked: `rate-limit` → `backup` →
the `ipc-framing`/`desktop-ipc` pair (all near-zero coupling), then the heavier
`locks` / `coordination` / `search` / `memory`.
