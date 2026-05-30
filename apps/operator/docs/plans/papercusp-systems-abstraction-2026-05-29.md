---
title: Abstract Papercusp's reusable systems into standalone libraries — per-subsystem seams and the extraction backlog
slug: papercusp-systems-abstraction-2026-05-29
status: draft
created: 2026-05-29
updated: 2026-05-29
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

**Next:** a human confirms bundling (P-000, needs-human). Then Phase 1 — the
three genuinely-pure extractions (`rrf`, `embedded-pg-discovery`, `plan-parser`)
that need **no** seam at all — can start immediately and in parallel; they are
the proof-of-pattern. Everything else defines its own per-subsystem seam (D-010).

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
| (e) dispatcher `ctx.tx` from context-assembly (role-gated, **optional/unchecked**) | **search** | no — it's the dispatch pipeline, not a db-org call; and `ctx.tx` is used without a null-check (latent bug, P-013) |

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

- **P-000** `needs-human` Confirm the bundling decision (D-002): ship as ~4
  bundles vs. one package per system. This sets every package boundary
  downstream. → D-001 D-002
- **P-001** `todo` Write the per-subsystem seam map (NOT one shared seam — that
  was refuted, D-003/D-010): for each Population-B target, the exact injection
  interface it needs. Define the one genuinely-shared optional primitive — a
  minimal `PgHandle { sql }` — for the `getOrgPg`-based consumers (backup,
  auth-rate-limit, coord presence, memory side-effects). This is documentation +
  one tiny type, NOT a blocking gate; Phase 1 does not depend on it. → D-003 D-010

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

- **P-010** `todo` Extract `@papercusp/locks` from `agent-tools/locks/`,
  **AS-IS**. **Audit correction:** do NOT inject a `WorkspaceStore`. `SuLocksCoordinator`
  already fully `implements FileClaimCoordinator` (conformance-tested) and has its
  own connection pool, its own `papercusp_su` database, and `pg_advisory_xact_lock`
  serialization (mechanism (b)) — none of which fit a shared tx handle. Move
  `su-lock-store.ts` / `coordinator.ts` / `in-workspace-txn.ts` (locks-local) /
  `workspace-listener.ts` / `path-normalize.ts` / `sql/`, keep the internal txn +
  side-DB, expose `SuLocksCoordinator`. The caller supplies an opaque
  `coordinationDomain` string (today: workspace UUID). → D-010
- **P-011** `todo` Extract `@papercusp/coordination` as **three pieces, not one
  dual-backend interface** (D-009): (a) `coord-core` — pure `identity` +
  `envelope` + protocol logic; (b) `CoordEventLog` — `append`/`readAll` over the
  append-only channel surfaces, `FsCoordLog` default + optional PG log;
  (c) `PresenceStore` — PG upsert+roster-join (mechanism (c), `getOrgPg`), NOT
  behind the event-log interface. → D-004 D-009
- **P-012** `todo` Normalize the lone mutating file surface: migrate
  `escalations.resolveEscalation` from read-modify-write-in-place to emitting an
  `escalation_resolved` envelope (the `CoordKind` already exists, `envelope.ts:28`),
  matching `handoffs`. Makes `CoordEventLog` cleanly append-only (and PG-swappable).
  Pre-alpha, no users → safe to change the on-disk shape now. → D-009

## Phase 3 — Retrieval cluster (search + memory; each its own seam)

- **P-013** `todo` **Bug fix (audit-found), pre-req for P-020:** `fulltext.ts` and
  `semantic.ts` read `ctx.tx` unconditionally, but it's optional (only populated
  when a bearer token is present or the dispatcher wraps in `withWorkspace`). When
  absent, search throws on `undefined.sql`. Add a null-check / explicit
  pg-handle resolution before extraction so the extracted package has a defined
  DB contract. → D-010
- **P-020** `todo` Extract `@papercusp/search` (BM25 + pgvector hybrid). Three
  seams (mechanism (e) today): (i) **source registry** — the 4 surfaces
  (escalations/brainstorm/turns/decisions) are hardcoded literal branches, not a
  registry; turn them into a `SearchSource` adapter callers register; (ii) **embedder**
  — already a cascade (`buildQueryEmbedder`) but hard-imports `readCredentials` +
  `loadVoicePrefs`; lift to injected DI; (iii) **pg-handle** — pass a `PgHandle`
  instead of relying on `ctx.tx`. Depends on `rrf` (P-002) + the `ctx.tx` fix
  (P-013). blocked-by: P-002, P-013 → D-010
- **P-021** `todo` Extract `@papercusp/memory`. **Audit correction:** mem0 is an
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

- **P-023** `todo` Extract `@papercusp/backup` (kopia wrapper, ~95% CLI
  passthrough). **Audit correction:** the real seam is NOT a PG tx handle. Backup
  uses raw `getOrgPg()` with no transactions (mechanism (c)); its dominant
  coupling is the **workspace-root filesystem path** (the kopia repo lives at
  `<workspaceRoot>/backups/kopia-repo`). Inject: workspace-root path + workspaceId
  + a settings-table accessor (table is `harness_shared.workspace_backup_settings`,
  **not** `workspace_backup_config` as the first draft said). Keep the load-bearing
  self-exclusion guard (`policy.ts` `IGNORE_PATTERNS` must contain `backups`;
  enforced on every `snapshot()` by `assertSelfExclusionPolicy`). → D-010
- **P-024** `todo` Resolve backup's harness-lifecycle coupling: the
  `SnapshotTriggerReason` enum (`pre_destructive`/`post_run`/`plugin_install`/
  `secret_change`/…) is hardcoded and `triggerSnapshotEvent` is called from
  git/restore/plugin call-sites. Externalize as a caller-registered trigger
  registry (or accept a loose string list) so the extracted package isn't bound to
  harness events. blocked-by: P-023 → D-010
- **P-030** `todo` Extract the Tauri IPC stack as **three pieces** (audit:
  coupling is in `server.ts`, NOT the transport): (i) `@papercusp/ipc-framing` —
  `framing.ts`, pure binary codec, zero coupling; (ii) `@papercusp/desktop-ipc` —
  `desktop-bootstrap.ts` + `ipc-fetch.ts` + `ipc-event-source.ts` + `ipc-stream.ts`,
  **verified zero Papercusp coupling**; (iii) `@papercusp/ipc-endpoint-server` —
  `endpoint-ipc/server.ts`, which needs MORE than "pluggable dispatch": inject
  `dispatchProjectedToolStream` **and** `lookupByMcpName` **and** `getWorkspaceId`
  **and** the tool allowlist (all already DI-shaped via `DispatchProjectedDeps`).
  This is the libsoup pool-exhaustion fix. → D-006
- **P-031** `todo` Extract `@papercusp/rate-limit` from `lib/auth-rate-limit.ts`
  (2-bucket, PG-durable; **verified zero domain coupling**, generic string keys).
  Mechanism (c): raw `getOrgPg()`, no `withWorkspace` — confirmed. Inject a
  `PgHandle` + options (windows/capacities/table name); `isLoopbackIp()` is
  reusable as-is. Ready to extract; lowest-risk of the seam'd ones. → D-010

## Phase 5 — Promote what's already factored (Population A)

- **P-040** `todo` Publish/promote the already-clean libs (audit confirmed all
  nine carry zero domain imports): `@restart/sse`, `@papercusp/token-kit`,
  `@papercusp/host-platform`, `@papercusp/docs-engine`, `@papercusp/file-claim`,
  the four React libs, `@papercusp/flags`. Packaging only (versioning, README).
  → D-007

## Phase 6 — Verification

- **P-050** `todo` Each extracted package: its in-memory/test impl passes the
  same conformance suite as the production impl; the operator re-points at the
  package with no behavior change; existing suites green. blocked-by: P-010,
  P-011, P-012, P-013, P-020, P-021, P-022, P-023, P-024, P-030, P-031
- **P-051** `todo` Proof-of-genericity: stand up one extracted package (recommend
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
| **P-022** | `@papercusp/plan-parser` | `e96f63f3` | move + re-export shim | none — `plans/{parser,effective-status,content-hash}.ts` are now one-line re-exports of the package; ~24 in-plans consumers resolve unchanged |

17 package tests green (7 + 5 + 5); all three resolve from the operator. Pattern
for all three: a new `packages/<name>/` with **src-as-entry** (no build step,
mirrors `@papercusp/docs-engine`), the package owns its vitest suite, and
`node_modules/<pkg>` is **symlinked directly** because root `npm install` is
blocked by a **pre-existing `@blocknote/mantine` ERESOLVE** (unrelated to this
work — don't chase it; use the symlink or `--legacy-peer-deps`).

### Two known follow-ups (not blockers)

- **P-013** (already in Phase 3): `search/semantic.ts` + `search.ts` read
  `ctx.tx` unconditionally though it's optional — a latent null-deref. Untouched
  by P-002 (import-only change); still owed before the search package extraction.
- **P-023b** (new): rewire the ~24 `plan-parser` consumers to import
  `@papercusp/plan-parser` directly and delete the three re-export shims.
  Deferred because paperclip was actively `git add -A`-committing the shared
  checkout during this window, making a 24-file rewire unsafe to land atomically.

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
