---
title: Port SU coordination channels to Postgres
slug: coord-channels-pg-port-2026-05-30
status: ready
created: 2026-05-30
updated: 2026-05-30
owner: avi@storewolf.com
related: [agent-coordination-architecture-v2-2026-05-20, BRIEF-coordination-extraction-2026-05-30, three-client-lock-enforcement-2026-05-30]
---

# Port SU coordination channels to Postgres

## Now

**State:** Phases 1 & 2 shipped on main (commits 164abb55, 87f98889, 4d897dba, 16955277, 3fb42f00, 75fb8468). The FS→PG cutover is code-complete: PgCoordLog is workspace_id-scoped (P-019/D-007); PgWatermarkStore + PgSubscriptionStore added with in-memory doubles + conformance (P-002/P-003); host ensureSchema wrappers wired (P-001/P-004); log.ts/watermarks.ts/subscriptions.ts/`/api/coord` cut over to PG (P-005..P-009). Verified: all three coord PG stores pass conformance against the live embedded PG (event-log 7/7 incl. workspace isolation, watermark 4/4, subscription 4/4); operator tsc 725 (down from the 727 pre-existing baseline), zero errors in changed files. NOT YET LIVE: the running :3070 operator (`tsx bin/hono-host.ts`, no file-watch) still serves the old FsCoordLog — a probe coord:send landed in coord/*.jsonl, not PG — so P-013's live cross-shell check is blocked on an operator restart (which also resets the papercusp-su MCP session). Phase 3 (P-010/P-011, remove the OMP coord-hook detached FS readers) and Phase 5 (gated by P-014) remain.

**Next:** Human restarts the :3070 operator (tsx bin/hono-host.ts) so it loads the PgCoordLog cutover, then an agent runs the P-013 live cross-shell check; in parallel an agent can do Phase 3 (P-010/P-011, OMP hook) which is independent pure code.

## Background

The SU coordination layer is three layers over one identity primitive: L1 identity/presence, L2 file locks (Postgres, `papercusp_su` DB), L3 async channels. L3 was deliberately built on filesystem JSONL — `agent-coordination-architecture-v2-2026-05-20.md` D-002 chose it for **portability (detached mode), grep-ability, human-editability**, and prior art (the rust-port `coord/*.jsonl` pattern). The user has now reversed the portability priority and wants L3 on Postgres, modeled on the harness-agent `messages` system.

The extraction into `@papercusp/coordination` (P-011, `BRIEF-coordination-extraction-2026-05-30.md`) was done with this reversal anticipated: `CoordEventLog` is "the one swappable storage seam," and a `PgCoordLog` ("optional single-table Postgres backend") was written alongside `FsCoordLog` and passes the same conformance gate. Presence already made the move — `coord:presence` runs on `PgPresenceStore` against `harness_shared.coord_presence` today. This plan finishes the migration the presence move started.

## What's already built (the head start)

- `packages/coordination/src/event-log/pg-log.ts` — `PgCoordLog implements CoordEventLog`, one table `harness_shared.coord_event_log (id bigserial, surface, writer_key, msg_id, body jsonb, ts)` with a partial unique index on `(surface, msg_id) WHERE surface IN ('handoffs','escalations')` so event surfaces upsert and line surfaces pure-append. Exports `ensureCoordEventLogTable`.
- `apps/operator/lib/agent-tools/coordination/log.ts` — the 3-line seam; comment already says "a future PG-backed CoordEventLog is a one-line swap here."
- `packages/coordination/src/presence/pg-store.ts` + `apps/operator/lib/agent-tools/coordination/presence.ts` — the working `getSql`/`ensureSchema` injection template to copy for the two new stores.
- Conformance suites (`event-log/conformance.ts`, `presence/conformance.ts`) — the P-050 swappability gate; new stores follow the same fs/pg/in-memory + conformance shape.

**One caveat the swap is not free of:** the shipped `PgCoordLog`/`ensureCoordEventLogTable` carry no scoping column, whereas `coord_presence` has `workspace_id`. The port adds `workspace_id` to it (P-019, D-007), so P-005 is "swap **+ add the scoping column**," not a literal one-line swap.

## Scope

**In scope (move to PG):**
- Event-log channels via the existing seam: `messages` (+ acks/threads/notifies), `plan-events`, `handoffs` (+ acceptances), `escalations` (+ resolves). One `log.ts` swap moves all of them.
- Subscriptions (`coord/subscriptions/<owner>.jsonl`) — net-new `PgSubscriptionStore`.
- Watermarks (`coord/watermarks/<owner>.json`) — net-new `PgWatermarkStore`.
- The two operator-side direct-FS readers that bypass the seam (`/api/coord` `readAllMessages`, `subscriptions.fireNotifications`).
- The OMP `coord-hook.ts` detached-mode FS readers (removed).

**Out of scope:**
- L1 identity (`resolveAgentIdentity` — no storage), L2 locks (`papercusp_su` — stays isolated), presence (already PG).
- Three-client lock enforcement — orthogonal, untouched.
- The two legacy rust-port flat `coord/*.jsonl` directories — never owned by these tools; left on disk.
- Cross-machine coord and live LISTEN/NOTIFY push — flagged as future (see Open questions).

## Storage design

All in the main `papercusp` embedded-pg DB, `harness_shared` schema, resolved via `getOrgPg()` — matching presence and `PgCoordLog`. Created lazily via `ensureSchema` wrappers in `apps/operator/lib/ensure-schema.ts` (next to `ensureCoordPresenceTable`), the established pattern (D-008); no numbered SQL migration.

Every table carries `workspace_id text NOT NULL DEFAULT 'default'`, bound at construction on the PG stores and filtered on read — parity with `coord_presence` (which writes `identity.workspaceId ?? 'default'` and filters `list()` on it). Today every row is `'default'` (zero behavior change); the column makes the multi-install case (Q-3) a non-event the same way presence already handles it. See D-007.

- `coord_event_log` — modified from the shipped DDL to add the scoping column; the event-surface uniqueness widens to include it:

```sql
CREATE TABLE IF NOT EXISTS harness_shared.coord_event_log (
  id           bigserial   PRIMARY KEY,
  workspace_id text        NOT NULL DEFAULT 'default',
  surface      text        NOT NULL,
  writer_key   text,
  msg_id       text        NOT NULL,
  body         jsonb       NOT NULL,
  ts           timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS coord_event_log_event_uq
  ON harness_shared.coord_event_log (workspace_id, surface, msg_id)
  WHERE surface IN ('handoffs', 'escalations');
CREATE INDEX IF NOT EXISTS coord_event_log_surface_id
  ON harness_shared.coord_event_log (workspace_id, surface, id);
```

- `coord_watermarks` — mutable, one row per (workspace, owner):

```sql
CREATE TABLE IF NOT EXISTS harness_shared.coord_watermarks (
  workspace_id text        NOT NULL DEFAULT 'default',
  owner_id     text        NOT NULL,
  surfaces     jsonb       NOT NULL DEFAULT '{}'::jsonb,  -- messages_since_ts, plan_events_since_ts, ...
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, owner_id)
);
```

- `coord_subscriptions` — one row per watch, soft state via `cancelled_at` + `expires_ts` (mirroring the harness `messages` status-transition house style):

```sql
CREATE TABLE IF NOT EXISTS harness_shared.coord_subscriptions (
  msg_id       text        PRIMARY KEY,
  workspace_id text        NOT NULL DEFAULT 'default',
  owner_id     text        NOT NULL,
  pattern      text        NOT NULL,
  trigger      text        NOT NULL,
  expires_ts   timestamptz,
  cancelled_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS coord_subscriptions_owner_active
  ON harness_shared.coord_subscriptions (workspace_id, owner_id)
  WHERE cancelled_at IS NULL;
```

The `CoordEnvelope` shape is unchanged — it rides in `body jsonb`. The per-writer-file / per-event-file layout dissolves: it was a filesystem concurrency workaround, not a domain rule (D-004).

## Per-client impact

| Client | Coord access today | Change |
|---|---|---|
| Claude | 100% via operator `coord:*` MCP tools | **None** — tools transparently hit PG |
| Codex | 100% via operator `coord:*` MCP tools | **None** |
| OMP | MCP tools when attached; `coord/*.jsonl` direct reads when detached | Remove the detached FS readers in `coord-hook.ts`; attached path unchanged |

Only OMP has a turn-start coord-injection hook with FS-direct readers; Claude/Codex `cc/` hooks are locks-only. So "drop detached mode" is a one-file edit to the OMP hook.

## Phase 1 — Schema + package stores

- **P-001** `done` Host `ensureSchema` wrapper for `harness_shared.coord_event_log` in `apps/operator/lib/ensure-schema.ts`, wrapping the package's `ensureCoordEventLogTable(getOrgPg().sql)`.
- **P-002** `done` Add `PgWatermarkStore` to `@papercusp/coordination` behind a `WatermarkStore` interface, with an in-memory double + conformance suite (mirror `PresenceStore`). Backing table `coord_watermarks`, carrying a construction-bound `workspace_id`.
- **P-003** `done` Add `PgSubscriptionStore` to `@papercusp/coordination` behind a `SubscriptionStore` interface, with an in-memory double + conformance suite. Backing table `coord_subscriptions`, carrying a construction-bound `workspace_id`.
- **P-019** `done` Add a construction-bound `workspace_id` (default `'default'`) to `PgCoordLog` + `ensureCoordEventLogTable`: column + widened uniqueness/read indexes, all reads/writes filtered by the bound id. Update the event-log conformance harness to construct with a domain. (Parity with `coord_presence`; D-007.)
- **P-004** `done` Host `ensureSchema` wrappers for `coord_watermarks` + `coord_subscriptions` in `ensure-schema.ts`. blocked-by: P-002, P-003

## Phase 2 — Host wiring (the swap)

- **P-005** `done` Swap `log.ts` `FsCoordLog` to `PgCoordLog({ getSql: () => getOrgPg().sql, ensureSchema, workspaceId })`. Moves messages/plan-events/handoffs/escalations to PG in one change. Lands as a unit with P-008 (see Review hardening). blocked-by: P-001, P-019
- **P-006** `done` Repoint `watermarks.ts` (`readWatermark`/`writeWatermark`) from `fs` to `PgWatermarkStore`. blocked-by: P-002, P-004
- **P-007** `done` Repoint `subscriptions.ts` (`addWatch`/`removeWatch`/`listWatches`) from `fs` to `PgSubscriptionStore`. blocked-by: P-003, P-004
- **P-008** `done` Redirect `subscriptions.fireNotifications()` to `coordLog.appendLine('messages', watcher, env)` instead of the FS `appendCoordLine`, so notifies land in the same store as messages. Land in the same change as P-005. blocked-by: P-005
- **P-009** `done` Repoint `/api/coord` `readAllMessages()` (history + inbox endpoints) from direct `coord/messages/*.jsonl` reads to `coordLog.readLines('messages')`. blocked-by: P-005

## Phase 3 — Detached-mode removal (OMP only)

- **P-010** `done` Remove the detached-mode FS readers (`coordDirFs`, `readInboxFs`, `readPlanEventsFs`, `readWatermarkFs`, `writeWatermarkFs`) from `scripts/hooks/omp/coord-hook.ts`; keep the attached MCP/HTTP turn-start injection; degrade to the "operator unreachable" marker when detached. Claude/Codex `cc/` hooks untouched. blocked-by: P-005
- **P-011** `done` Update the `coord-hook.ts` header/contract comments to state detached coord-channel reading is no longer supported. blocked-by: P-010

## Phase 4 — Verify

- **P-012** `done` Package conformance suites green (event-log incl. the new domain-scoped construction, presence, new watermark + subscription stores); `npm run test:affected`. blocked-by: P-002, P-003, P-005, P-006, P-007, P-019 (All three coord PG stores pass conformance against the live embedded PG event-log 7/7 incl. workspace isolation, watermark 4/4, subscription 4/4; in-memory suites green; operator tsc 725 down from 727 baseline, zero in changed files. Full test:affected closure not run heavy; targeted conformance + tsc cover the change.)
- **P-013** `blocked` Live cross-shell check: two `claude-su` shells `coord:send`/`coord:inbox` through the running operator confirm messages flow via PG; `psql` shows rows in `harness_shared.coord_event_log`. blocked-by: P-008, P-009 (External: the :3070 operator is `tsx bin/hono-host.ts`, a no-watch long-running process still serving the pre-cutover FsCoordLog proven — a live coord:send landed in coord/messages/*.jsonl, not PG. Needs an operator restart to load the PgCoordLog cutover; restarting also resets the papercusp-su MCP session, so it is the user's call.)

## Phase 5 — Cleanup + docs (gated)

- **P-014** `needs-human` Sign-off before destructive cleanup — confirm PG-only is final (detached coord intentionally dropped) before deleting the `coord/` channel dirs and amending the v2 decisions.
- **P-015** `todo` Remove dead FS path helpers from `paths.ts` (`messagesDir`/`escalationFile`/`handoffFile`/`outboxFile`/`subscriptionsDir`/`watermarkFile` as applicable) and the `FsCoordLog` import. blocked-by: P-012, P-013, P-014
- **P-016** `todo` Delete the now-unused `coord/` channel dirs (messages, plan-events, escalations, handoffs, subscriptions, watermarks); leave the legacy rust-port flat `coord/*.jsonl` untouched. blocked-by: P-015
- **P-017** `todo` Amend the v2 plan's three filesystem-for-L3 rulings (the FS-substrate, per-writer-file, and detached-mode-first-class decisions) to record the reversal; link this plan as the successor. blocked-by: P-014
- **P-018** `todo` Update the `@papercusp/coordination` README + `examples/detached-mode.ts` note (the detached event-log path is no longer the product path). blocked-by: P-016

## Decisions

### D-001 — PG-only; drop detached mode
Date: 2026-05-30
Reverses the v2 filesystem-for-L3 rulings. The user originally chose JSONL for portability (an OMP agent participating with no operator/PG) but has reversed that priority. Presence already broke detached mode when it went PG; this finishes the migration rather than starting a new compromise. Accepted losses: grep-ability, human-editability of channel files, and detached-mode L3. Mitigations: the `/coord` UI history viewer and the `/dev` SQL surface cover the human-read need.

### D-002 — Target the main papercusp DB, harness_shared schema — not papercusp_su
Date: 2026-05-30
Presence (`coord_presence`) and the prebuilt `PgCoordLog` already target `harness_shared` via `getOrgPg()`. The locks DB (`papercusp_su`) is deliberately isolated — the locks extraction brief states that isolation "is the point" and forbids injecting a shared handle. Coord channels share the substrate (PG/`harness_shared`) but keep their own tables and `coord:*` namespace, which is exactly the posture the docs endorse versus reusing the harness `messages`/`spawns` tables.

### D-003 — Full scope: event-log channels AND subscriptions + watermarks
Date: 2026-05-30
"Port this system to PG" means no half-FS/half-PG residue. The event-log channels ride the existing `PgCoordLog` seam (near-free). Subscriptions + watermarks are not behind that seam (they are mutable, not append-only), so they get two net-new PG stores built to the same P-050 seam pattern (interface + in-memory double + conformance) the package already uses for presence and the event log. End state: the `coord/` channel directory is deleted.

### D-004 — The per-writer-file / per-event-file layout dissolves under PG
Date: 2026-05-30
v2 mandated one-writer-per-file (per-sender outboxes, per-event JSON files) purely to avoid JSONL write contention without a lock. Postgres MVCC + a serial id handle concurrent writers natively, so this constraint is consciously dropped: a single `coord_event_log` table with a `writer_key` column replaces the per-agent files, and acks become ordered rows instead of "append to your own outbox, reconstruct by scanning." The `CoordEnvelope` schema itself is unchanged.

### D-005 — Client impact is asymmetric; only the OMP hook changes
Date: 2026-05-30
Claude and Codex reach coord exclusively through operator-mediated `coord:*` MCP tools, so the PG swap is transparent to them — zero client changes. Only OMP has a turn-start coord-injection hook (`coord-hook.ts`) with FS-direct readers, and only those readers are removed. The three-client lock-enforcement work (`three-client-lock-enforcement-2026-05-30.md`) is orthogonal and is not touched.

### D-006 — No automatic data backfill
Date: 2026-05-30
Pre-alpha, no production; existing `coord/*.jsonl` channel data is dev chatter. The port starts the PG tables empty. A one-shot import script can be added on request if any channel history needs preserving.

### D-007 — Scope coord channels by workspace_id (parity with presence), not coordination_domain
Date: 2026-05-30
Peer review flagged that `coord_event_log` has no scoping column while `coord_presence` carries `workspace_id` and the locks table carries `coordination_domain`. Decided pre-alpha (per the repo's "do the right schema now" philosophy) to add a scoping column to all three new coord tables. It is `workspace_id`, not `coordination_domain`: coord channels are agent-to-agent messaging whose roster IS `coord_presence`, so the channel scope must equal the roster scope, or an agent could be messageable in a scope it isn't visible in. `coordination_domain` is the locks partition — deliberately per-machine and in a separate DB (v2 §13) — and does not belong in `harness_shared` coord tables. The column is bound at construction on the PG stores (the operator instance serves one workspace) and filtered on every read/write; it defaults to `'default'` exactly as presence does, so it is a no-op today and makes Q-3 a non-event tomorrow.

### D-008 — Tables created via lazy ensureSchema wrappers, matching the presence precedent
Date: 2026-05-30
Peer review asked us to be deliberate about lazy `ensureSchema` vs a boot-applied numbered SQL migration. Chosen: lazy `ensureSchema` wrappers in `apps/operator/lib/ensure-schema.ts`, matching the immediate sibling `ensureCoordPresenceTable` and keeping the DDL in one place (the package's `ensure*Table` functions) rather than duplicating it into a numbered migration. The build step will confirm whether the `ensure-schema.ts` wrappers are invoked at boot (if so they are effectively boot-applied, satisfying the storage-policy intent too).

## Review hardening (peer review 2026-05-30)

A peer review verified the plan's claims and raised six points. #1 (scoping column) is adopted as D-007; #5 (migration pattern) as D-008. The rest, with the code evidence behind each call:

- #2 (ordering parity) — **rejected as a concern; already safe.** The review worried that `FsCoordLog` union-sorts by `(ts, msg_id)` while `PgCoordLog.readLines` is `ORDER BY id ASC`. Verified: `FsCoordLog.readLines` actually returns readdir-then-append order (no ts sort), and order doesn't matter either way because the *consumers* pin it — `filterInbox` ends with `.sort(compareByTsThenId)` (`core/inbox.ts:44`) and `foldThread` likewise (`core/thread.ts:36`). The store's return order is intentionally unspecified; display order is fixed by the pure core. So the FS→PG swap cannot change inbox/thread order, and PG's id-ASC is in fact more deterministic than FS readdir. A conformance order-assertion is optional documentation, not a correctness requirement.
- #3 (sequencing) — **rejected; keeping P-008 blocked-by P-005, not P-007.** The review suggested gating P-008 on P-007 to avoid a split-brain. Verified `fireNotifications` (`subscriptions.ts:205`) reads the watch list (subscriptions) and writes the notify into the watcher's *message* outbox — two different stores, so there is no split-brain between them. The real broken window is "P-005 landed, P-008 hasn't" (notify written to FS while inbox reads PG); P-007's state is irrelevant to delivery. Gating P-008 on P-007 (itself blocked on P-003/P-004) would *delay* the notify fix relative to P-005 and *widen* that window. Mitigation instead: P-005 and P-008 land in the same change (noted on both items).
- #4 (/coord liveness) — **folded into Q-1.** No regression risk (FS had no push either), but `coord_event_log` lands next to the dogfood-reactive tables, so wiring the existing `emit_change_notify()` trigger for the UI path is near-free. Q-1 now splits "agent path (polls, defer)" from "UI path (wire the trigger if the UI wants live)."
- #6 (empty watermarks) — **confirm during build.** A missing watermark behaving as "since epoch" is unchanged from today's FS behavior (a missing watermark file is the same situation), so it is not a port regression. The build will confirm the turn-start hook's `since` default is bounded so accumulated rows never produce a re-surface flood for a fresh owner.

## Open questions

- **Q-1** Live push for `/coord`. Agent path: the turn-start hook polls, so server push is not required — defer. UI path: `coord_event_log` is in `harness_shared` next to tables that already fire `emit_change_notify()` → `pg_notify('sync_invalidate', …)`; if the `/coord` inbox wants live updates, adding the table to the reactive set is near-free. Decide the UI path when building P-009.
- **Q-2** Subscriptions store shape: mutable rows (`cancelled_at` + `expires_ts`) vs append-and-fold. Proposal: mutable rows — simpler, and subscriptions are inherently mutable state, not an audit channel.
- **Q-3** Cross-machine coord (multiple installs sharing one PG). Now addressed structurally by the `workspace_id` column (D-007): distinct installs use distinct workspace ids and never cross-contaminate. Activating it as a real feature (a shared DB across installs) is still a future tier and out of scope here.

## Rejected alternatives

- **Put coord channels in `papercusp_su` (the locks DB).** Rejected — the locks DB's isolation is deliberate (locks brief); presence already set `harness_shared` as the coord home.
- **Scope coord channels by `coordination_domain`.** Rejected (D-007) — that is the per-machine locks partition in a separate DB; coord channels must share `coord_presence`'s `workspace_id` scope since presence is the roster they address.
- **Dual-store (FS + PG) to preserve detached mode.** Rejected per D-001 — adds a PG↔FS consistency gap and real complexity for a capability the user is intentionally dropping.
- **Build the PG backend from scratch.** Moot — `PgCoordLog` already exists and passes conformance; the work is wiring + two small new stores + a scoping column, not a rebuild.
