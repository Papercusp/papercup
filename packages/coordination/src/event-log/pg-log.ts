/**
 * pg-log.ts — PgCoordLog: a single-table Postgres CoordEventLog. The
 * optional production-grade swappable backend alongside FsCoordLog (the
 * portable default) and InMemoryCoordLog (the test double). It satisfies
 * the SAME `CoordEventLog` conformance suite (the P-050 swappability gate)
 * — see `event-log/conformance.ts`.
 *
 * One append-only table, `harness_shared.coord_event_log`, holds every
 * channel:
 *   - LINE surfaces (`messages`, `plan-events`): append a row, read ordered
 *     by the serial `id` (append order). The fs-only `filesBack` rotation
 *     hint is ignored — a single table has no rotation, exactly as the
 *     `ReadLinesOpts` contract permits.
 *   - EVENT surfaces (`handoffs`, `escalations`): one immutable record per
 *     `(workspace_id, surface, msg_id)`, enforced by a PARTIAL unique index +
 *     upsert. The predicate keeps pure-append line rows out of the uniqueness
 *     constraint.
 *
 * Every row carries a `workspace_id` scope, bound at construction (the
 * operator instance serves one workspace) and filtered on every read/write.
 * This is parity with `harness_shared.coord_presence.workspace_id` — the
 * coord channels are agent-to-agent messaging whose roster IS presence, so
 * the channel scope must equal the roster scope. It defaults to `'default'`
 * (the same fallback presence uses), so it is a no-op in the one-workspace
 * install of today and isolates channels cleanly if multiple installs ever
 * share one database (coord-channels-pg-port D-007). The fs layout had no
 * such column — the coord *directory* was the partition; under PG the bound
 * `workspace_id` plays that role.
 *
 * Host couplings are injected, matching PgPresenceStore: the org PG handle
 * (`getSql`) and the table bootstrap (`ensureSchema`). The canonical DDL is
 * exported as `ensureCoordEventLogTable` so a host's `ensureSchema` seam (and
 * the conformance harness) can create the table without duplicating schema.
 */

import type { Sql } from 'postgres';
import type { CoordEnvelope } from '@papercusp/pubsub-substrate/core';
import type {
  CoordEventLog,
  CoordLogCursorPage,
  EventSurface,
  LineSurface,
  ReadLinesOpts,
} from '@papercusp/pubsub-substrate/event-log';

/** The coordination scope used when a host does not bind one. Matches the
 *  `'default'` fallback `PgPresenceStore` writes for a workspace-less agent. */
export const DEFAULT_COORD_WORKSPACE = 'default';

export interface PgCoordLogOptions {
  /** The org Postgres handle (postgres-js tagged template). Called per use. */
  getSql: () => Sql;
  /** Ensure `harness_shared.coord_event_log` exists before first use. */
  ensureSchema: () => Promise<void>;
  /**
   * Coordination scope for every row this instance reads/writes — parity
   * with `coord_presence.workspace_id`. Bound at construction because the
   * surface methods carry no identity. Defaults to `'default'`.
   */
  workspaceId?: string;
  /**
   * Per-call workspace resolver (workspace-data-isolation-leaks-2026-06-17 F-C1).
   * When provided AND it returns a non-empty value, it OVERRIDES the fixed
   * `workspaceId` on every read/write — so the operator's single coordLog can
   * scope coord to the REQUEST's active workspace instead of one shared
   * partition. Falls back to `workspaceId` / 'default' when it returns empty.
   * Bound as a resolver (not a construction value) because one operator process
   * serves every workspace.
   */
  getWorkspaceId?: () => string;
}

/**
 * Normalize a `jsonb` body to the envelope. postgres-js returns a jsonb
 * column inserted as `${JSON.stringify(x)}::jsonb` as the raw TEXT it was
 * cast from (not an auto-parsed object) under the prod handle's options
 * (`prepare: false`), so parse a string defensively — same posture as
 * PgPresenceStore's `parseFiles`.
 *
 * WI-3912: also BACKSTOPS `ts`/`msg_id` from the row's own NOT-NULL columns
 * when `body` itself is missing/blank them. Every LOCAL write path
 * (appendLine/putEvent/putEvents) stamps the columns FROM the envelope, so
 * body and column agree by construction for local rows — but a FEDERATED
 * remote row folds whatever the peer sent as `body` verbatim (fold-apply
 * does not re-validate CoordEnvelope shape), so a malformed/incomplete
 * remote envelope (observed live: coord_event_log id 458510, a deliberate
 * `origin=remote` test probe body with no `ts`/`msg_id` at all) can land in
 * the log with a body that violates the CoordEnvelope contract. Every
 * reader downstream (feed.ts's `compareByTsThenId`, which calls
 * `.localeCompare` on `a.ts`/`a.msg_id` unconditionally) assumed that
 * contract always holds — ONE such row made `coord:feed` throw a
 * `TypeError: Cannot read properties of undefined (reading 'localeCompare')`
 * on EVERY call reading it, not just a request touching that row specially
 * (it's within the default recent-window read). Filling the gap here, at
 * the read boundary, fixes the whole reader-side CLASS (any current or
 * future malformed row, local or remote) in one place instead of hardening
 * every consumer's sort/compare call individually.
 */
function parseBody(v: unknown, fallback?: { ts?: unknown; msg_id?: unknown }): CoordEnvelope {
  const parsed = (typeof v === 'string' ? JSON.parse(v) : v) as Record<string, unknown>;
  if ((typeof parsed.ts !== 'string' || !parsed.ts) && fallback?.ts != null) {
    parsed.ts = fallback.ts instanceof Date ? fallback.ts.toISOString() : String(fallback.ts);
  }
  if ((typeof parsed.msg_id !== 'string' || !parsed.msg_id) && fallback?.msg_id != null) {
    parsed.msg_id = String(fallback.msg_id);
  }
  return parsed as CoordEnvelope;
}

/**
 * Create the `coord_event_log` table + indexes if absent. Idempotent. The
 * canonical schema for `PgCoordLog` — wire it into a host `ensureSchema` seam
 * (or call it directly in a conformance harness).
 *
 * The `workspace_id` column + the `ADD COLUMN`/`DROP INDEX` guards keep this
 * idempotent across a schema that predates the scoping column (D-007): a
 * fresh table gets the scoped definitions outright; a table left over from
 * before the column existed is migrated in place (pre-alpha, test-only, so
 * the index rebuild is safe — no production data on this table yet). Every
 * mutating step is gated by a catalog existence check (`columnExists` /
 * `indexNeedsRebuild`) so the already-migrated steady state issues NO
 * lock-taking DDL — an unconditional `ALTER TABLE … ADD COLUMN IF NOT EXISTS`
 * still grabs an ACCESS EXCLUSIVE lock and would trip `lock_timeout` against
 * the busy live org DB (the EI-1576 family of checkpoint flakes).
 */
export async function ensureCoordEventLogTable(sql: Sql): Promise<void> {
  await sql`CREATE SCHEMA IF NOT EXISTS harness_shared`;
  await sql`
    CREATE TABLE IF NOT EXISTS harness_shared.coord_event_log (
      id           bigserial   PRIMARY KEY,
      workspace_id text        NOT NULL DEFAULT 'default',
      surface      text        NOT NULL,
      writer_key   text,
      msg_id       text        NOT NULL,
      body         jsonb       NOT NULL,
      ts           timestamptz NOT NULL DEFAULT now()
    )
  `;
  // Migrate a pre-D-007 table that has no scoping column. Guarded by a catalog
  // existence check so the steady state takes NO lock: `ALTER TABLE … ADD COLUMN
  // IF NOT EXISTS` acquires an ACCESS EXCLUSIVE lock on the table BEFORE it
  // evaluates the `IF NOT EXISTS`, so issuing it unconditionally on every call
  // blocks behind the live operator's concurrent writes to coord_event_log and
  // trips `lock_timeout` ("canceling statement due to lock timeout") under load —
  // observed as a green-checkpoint flake. The column already exists on every
  // migrated DB, so the ALTER now only ever runs once, on a genuinely legacy
  // table (same steady-state-skip posture as the index `indexNeedsRebuild` guards
  // below).
  if (!(await columnExists(sql, 'coord_event_log', 'workspace_id'))) {
    await sql`
      ALTER TABLE harness_shared.coord_event_log
        ADD COLUMN IF NOT EXISTS workspace_id text NOT NULL DEFAULT 'default'
    `;
  }
  // harness_slug: the harness scope projected from CoordEnvelope.harness_slug.
  // NULL = operator-scope/workspace-global (local). The federation migration
  // (147) adds the same column + the capture triggers + the fed unique index;
  // keeping it here too means the runtime-bootstrapped table (conformance / fresh
  // test rigs) has the scope column without depending on migration order. Same
  // lock-avoiding existence guard as workspace_id above.
  if (!(await columnExists(sql, 'coord_event_log', 'harness_slug'))) {
    await sql`
      ALTER TABLE harness_shared.coord_event_log
        ADD COLUMN IF NOT EXISTS harness_slug text
    `;
  }
  // EVENT surfaces are keyed: exactly one immutable record per (workspace_id,
  // surface, msg_id). LINE surfaces (messages/plan-events) are pure append —
  // the partial predicate keeps them out of the uniqueness constraint so the
  // upsert below targets only the event rows.
  //
  // These indexes are (re)built ONLY when missing or in the legacy pre-D-007
  // shape (without `workspace_id`). A blind DROP-then-CREATE on EVERY call is
  // NOT concurrency-safe: this DDL runs against the LIVE org DB — both the
  // operator's `getOrgPg` and the conformance / integration suites that
  // resolve the same `connectionString()` — and during the brief
  // ACCESS-EXCLUSIVE window between DROP and CREATE every concurrent
  // `putEvent` upsert fails with `42P10: there is no unique or exclusion
  // constraint matching the ON CONFLICT specification` (EI-1576; the window
  // widens under PG congestion, where the DROP itself waits on a lock). The
  // index already exists with the right shape on every migrated DB, so the
  // common path now leaves it untouched — the window only ever opens once, to
  // widen a genuinely legacy index. (Pre-alpha: no production data on this
  // table, so that one-time legacy rebuild remains safe.)
  if (await indexNeedsRebuild(sql, 'coord_event_log_event_uq')) {
    await sql`DROP INDEX IF EXISTS harness_shared.coord_event_log_event_uq`;
    await sql`
      CREATE UNIQUE INDEX IF NOT EXISTS coord_event_log_event_uq
        ON harness_shared.coord_event_log (workspace_id, surface, msg_id)
        WHERE surface IN ('handoffs', 'escalations')
    `;
  }
  if (await indexNeedsRebuild(sql, 'coord_event_log_surface_id')) {
    await sql`DROP INDEX IF EXISTS harness_shared.coord_event_log_surface_id`;
    await sql`
      CREATE INDEX IF NOT EXISTS coord_event_log_surface_id
        ON harness_shared.coord_event_log (workspace_id, surface, id)
    `;
  }
}

/**
 * True when the named `harness_shared.coord_event_log` index is absent or in
 * the legacy pre-D-007 shape (lacking `workspace_id`) and so must be
 * (re)built; false when it already carries the scoped definition and MUST be
 * left in place. Reading `pg_indexes.indexdef` lets `ensureCoordEventLogTable`
 * skip the destructive DROP/CREATE in the steady state — the fix for the
 * recurring 42P10 upsert failures of EI-1576.
 */
async function indexNeedsRebuild(sql: Sql, indexName: string): Promise<boolean> {
  const rows = await sql<{ indexdef: string }[]>`
    SELECT indexdef FROM pg_indexes
     WHERE schemaname = 'harness_shared' AND indexname = ${indexName}
  `;
  if (rows.length === 0) return true; // missing → build
  return !/\bworkspace_id\b/.test(rows[0].indexdef); // legacy narrow → widen
}

/**
 * True when `harness_shared.<table>` already has the named column. Lets
 * `ensureCoordEventLogTable` skip the `ALTER TABLE … ADD COLUMN` in the steady
 * state — Postgres grabs an ACCESS EXCLUSIVE lock on the table BEFORE it checks
 * `IF NOT EXISTS`, so the otherwise no-op ALTER still blocks on a busy live
 * `coord_event_log` and trips `lock_timeout`. The catalog read takes only
 * ACCESS SHARE on the system catalogs (never on coord_event_log itself), so it
 * never contends with the operator's row writes. Same steady-state-skip posture
 * as `indexNeedsRebuild`.
 */
async function columnExists(sql: Sql, table: string, column: string): Promise<boolean> {
  const rows = await sql<{ present: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'harness_shared'
         AND table_name = ${table}
         AND column_name = ${column}
    ) AS present
  `;
  return rows[0]?.present === true;
}

export class PgCoordLog implements CoordEventLog {
  /** Construction-time fallback scope; the per-call resolver (F-C1) overrides it. */
  private readonly fallbackWs: string;

  constructor(private readonly opts: PgCoordLogOptions) {
    this.fallbackWs = opts.workspaceId ?? DEFAULT_COORD_WORKSPACE;
  }

  /**
   * The coordination workspace to scope to NOW (F-C1): the per-call
   * `getWorkspaceId` resolver when set + non-empty, else the construction-time
   * fallback. Resolved per use because one operator coordLog serves every
   * workspace — binding it once would pin all coord to a single partition.
   */
  private resolveWs(): string {
    const dyn = this.opts.getWorkspaceId?.();
    return dyn && dyn.trim() ? dyn : this.fallbackWs;
  }

  /**
   * The coordination workspace every row of this instance reads/writes. Exposed
   * so a caller issuing its OWN targeted `coord_event_log` query (rather than
   * going through readLines) can scope it to the SAME workspace this seam uses —
   * keeping such reads consistent with appendLine/readLines instead of assuming
   * `'default'`. (operator-core readAckedMsgIds relies on this.)
   */
  get workspaceId(): string {
    return this.resolveWs();
  }

  /**
   * The postgres handle this seam reads/writes. Exposed alongside `workspaceId`
   * so a targeted-query caller hits the SAME database — in production this is
   * `getOrgPg().sql`, but a swapped seam (tests, a non-default backend) points
   * elsewhere, so a caller must NOT reach for `getOrgPg()` independently.
   */
  getSql(): Sql {
    return this.opts.getSql();
  }

  async appendLine(surface: LineSurface, writerKey: string, line: CoordEnvelope): Promise<void> {
    await this.opts.ensureSchema();
    const sql = this.opts.getSql();
    // `::text::jsonb` (not bare `::jsonb`): the explicit text cast forces
    // postgres-js to bind the JSON as a plain text param, so it stores a real
    // jsonb OBJECT under BOTH the operator runtime client (getOrgPg — where a
    // bare `::jsonb` happens to work but `sql.json()` throws) AND a fresh /
    // testcontainer pool (where bare `::jsonb` double-encodes to a jsonb
    // string). One form, correct everywhere. See agent-insight
    // postgres-js-jsonb-binding.
    //
    // WI-3826 (fleet-reliability-verification-2026-07-10): `ts` is stamped
    // EXPLICITLY from `line.ts` (the envelope's own construction-time
    // timestamp) instead of the column's DEFAULT now(). The row USED to get
    // its `ts` from whenever this INSERT happened to commit — but callers
    // (e.g. sendMessage) build the envelope, then `await` audience/hive-scope
    // resolution BEFORE calling appendLine, so a slow resolve step let the
    // column drift >1s past body.ts on ~4.3% of live `messages` rows. Any
    // `WHERE ts >= $since` pushdown compared against body.ts (what
    // application code, e.g. filterInbox, has always used) would then
    // silently drop those rows. Stamping from `line.ts` makes column and body
    // agree BY CONSTRUCTION for every future row. (Existing divergent rows are
    // one-time-repaired by migration 546; `id` — not `ts` — is the append-order
    // cursor everywhere in this codebase, e.g. coord-inbox-bus.ts, so this
    // does not disturb ordering semantics.)
    await sql`
      INSERT INTO harness_shared.coord_event_log (workspace_id, surface, writer_key, msg_id, body, harness_slug, ts)
      VALUES (${this.resolveWs()}, ${surface}, ${writerKey}, ${line.msg_id}, ${JSON.stringify(line)}::text::jsonb, ${line.harness_slug ?? null}, ${line.ts}::timestamptz)
    `;
  }

  async readLines(surface: LineSurface, _opts: ReadLinesOpts = {}): Promise<CoordEnvelope[]> {
    await this.opts.ensureSchema();
    const sql = this.opts.getSql();
    // `filesBack` is an fs-rotation hint; a single table has no rotation, so
    // we read everything (the interface explicitly allows ignoring it).
    const rows = await sql<{ body: unknown; ts: Date; msg_id: string }[]>`
      SELECT body, ts, msg_id FROM harness_shared.coord_event_log
       WHERE workspace_id = ${this.resolveWs()} AND surface = ${surface}
       ORDER BY id ASC
    `;
    return rows.map((r) => parseBody(r.body, r));
  }

  async putEvent(surface: EventSurface, msgId: string, record: CoordEnvelope): Promise<void> {
    await this.opts.ensureSchema();
    const sql = this.opts.getSql();
    // WI-3826: the FIRST insert stamps `ts` from `record.ts` (same reasoning as
    // appendLine — column agrees with body by construction). A re-put (ON CONFLICT)
    // keeps its deliberate `ts = now()` — that path means the event was genuinely
    // TOUCHED again (e.g. an escalation resolve), and its ts is meant to reflect
    // that touch, not the original envelope's timestamp.
    await sql`
      INSERT INTO harness_shared.coord_event_log (workspace_id, surface, writer_key, msg_id, body, harness_slug, ts)
      VALUES (${this.resolveWs()}, ${surface}, NULL, ${msgId}, ${JSON.stringify(record)}::text::jsonb, ${record.harness_slug ?? null}, ${record.ts}::timestamptz)
      ON CONFLICT (workspace_id, surface, msg_id) WHERE surface IN ('handoffs', 'escalations')
      DO UPDATE SET body = EXCLUDED.body, ts = now(), harness_slug = EXCLUDED.harness_slug
    `;
  }

  async putEvents(
    surface: EventSurface,
    records: ReadonlyArray<{ msgId: string; record: CoordEnvelope }>,
  ): Promise<void> {
    if (records.length === 0) return;
    await this.opts.ensureSchema();
    const sql = this.opts.getSql();
    const ws = this.resolveWs();
    // The batch win (escalation-drain WI-346 / round3 P-001): write N records in
    // ONE statement instead of N separate `putEvent` INSERTs. Per-row putEvent
    // costs N round-trips AND — inside a DBOS step-budgeted reconcile — N steps,
    // capping a drain tick at a few hundred. One multi-row INSERT is one
    // round-trip + one DBOS step, so a large backlog drains in a single tick.
    //
    // Bind the rows as parallel text[] arrays and expand with `unnest`. `body`
    // goes through `::text::jsonb` per-row exactly like putEvent/appendLine: the
    // explicit text cast forces postgres-js to store a real jsonb OBJECT under
    // BOTH the prod handle and a fresh/testcontainer pool (agent-insight
    // postgres-js-jsonb-binding). Same ON CONFLICT upsert as putEvent — caller
    // must pass distinct msgIds within one batch (a re-put of an existing id
    // upserts; two identical ids in ONE batch would trip the ON CONFLICT
    // "cannot affect row a second time" — escalation resolves use fresh msg_ids).
    // WI-3826: `ts` travels alongside `body`/`harness_slug` in the same unnest, so the
    // FIRST insert of each row stamps ts from ITS OWN record.ts (matches putEvent).
    const msgIds = records.map((r) => r.msgId);
    const bodies = records.map((r) => JSON.stringify(r.record));
    const harnessSlugs = records.map((r) => r.record.harness_slug ?? null);
    const timestamps = records.map((r) => r.record.ts);
    await sql`
      INSERT INTO harness_shared.coord_event_log (workspace_id, surface, writer_key, msg_id, body, harness_slug, ts)
      SELECT ${ws}, ${surface}, NULL, t.msg_id, t.body::text::jsonb, t.harness_slug, t.ts::timestamptz
        FROM unnest(${msgIds}::text[], ${bodies}::text[], ${harnessSlugs}::text[], ${timestamps}::text[])
          AS t(msg_id, body, harness_slug, ts)
      ON CONFLICT (workspace_id, surface, msg_id) WHERE surface IN ('handoffs', 'escalations')
      DO UPDATE SET body = EXCLUDED.body, ts = now(), harness_slug = EXCLUDED.harness_slug
    `;
  }

  async readEvents(surface: EventSurface): Promise<CoordEnvelope[]> {
    await this.opts.ensureSchema();
    const sql = this.opts.getSql();
    const rows = await sql<{ body: unknown; ts: Date; msg_id: string }[]>`
      SELECT body, ts, msg_id FROM harness_shared.coord_event_log
       WHERE workspace_id = ${this.resolveWs()} AND surface = ${surface}
       ORDER BY id ASC
    `;
    return rows.map((r) => parseBody(r.body, r));
  }

  async readEventsBounded(
    surface: EventSurface,
    opts: { limit: number; kinds?: string[] },
  ): Promise<CoordEnvelope[]> {
    await this.opts.ensureSchema();
    const sql = this.opts.getSql();
    // Hard-clamp the LIMIT so a caller can never re-open the unbounded-read hole
    // this method exists to close (EI-1548). ORDER BY id DESC rides the
    // coord_event_log_surface_id (workspace_id, surface, id) index.
    const limit = Math.max(1, Math.min(Math.floor(opts.limit) || 1, 1000));
    const kinds = opts.kinds?.filter((k) => typeof k === 'string' && k.trim());
    const rows =
      kinds && kinds.length
        ? await sql<{ body: unknown; ts: Date; msg_id: string }[]>`
            SELECT body, ts, msg_id FROM harness_shared.coord_event_log
             WHERE workspace_id = ${this.resolveWs()} AND surface = ${surface}
               AND body->>'kind' = ANY(${kinds}::text[])
             ORDER BY id DESC
             LIMIT ${limit}
          `
        : await sql<{ body: unknown; ts: Date; msg_id: string }[]>`
            SELECT body, ts, msg_id FROM harness_shared.coord_event_log
             WHERE workspace_id = ${this.resolveWs()} AND surface = ${surface}
             ORDER BY id DESC
             LIMIT ${limit}
          `;
    return rows.map((r) => parseBody(r.body, r));
  }

  async readLinesBounded(
    surface: LineSurface,
    opts: { limit: number; sinceTs?: string; planSlug?: string; kinds?: string[] },
  ): Promise<CoordEnvelope[]> {
    await this.opts.ensureSchema();
    const sql = this.opts.getSql();
    // Line surfaces (`messages`/`plan-events`) live in the SAME coord_event_log
    // table, so this is the line parallel of readEventsBounded: newest-first,
    // hard-clamped LIMIT, ORDER BY id DESC riding the coord_event_log_surface_id
    // index. The since_ts / plan_slug pushdown (EI-1737 / fleet-concurrency-first
    // P-005) keeps the watermark-advancing coord:plan-events delta (turn start,
    // ×fleet) reading only its tail instead of the whole ~3.5MB surface. Optional
    // `AND`s — an omitted filter inlines to an empty fragment (no-op).
    const limit = Math.max(1, Math.min(Math.floor(opts.limit) || 1, 1000));
    const kinds = opts.kinds?.filter((k) => typeof k === 'string' && k.trim());
    const sinceTs = typeof opts.sinceTs === 'string' && opts.sinceTs ? opts.sinceTs : null;
    const planSlug = typeof opts.planSlug === 'string' && opts.planSlug ? opts.planSlug : null;
    const rows = await sql<{ body: unknown; ts: Date; msg_id: string }[]>`
      SELECT body, ts, msg_id FROM harness_shared.coord_event_log
       WHERE workspace_id = ${this.resolveWs()} AND surface = ${surface}
         ${kinds && kinds.length ? sql`AND body->>'kind' = ANY(${kinds}::text[])` : sql``}
         ${sinceTs ? sql`AND body->>'ts' > ${sinceTs}` : sql``}
         ${planSlug ? sql`AND body->>'plan_slug' = ${planSlug}` : sql``}
       ORDER BY id DESC
       LIMIT ${limit}
    `;
    return rows.map((r) => parseBody(r.body, r));
  }

  async getEvent(surface: EventSurface, msgId: string): Promise<CoordEnvelope | null> {
    await this.opts.ensureSchema();
    const sql = this.opts.getSql();
    const rows = await sql<{ body: unknown; ts: Date; msg_id: string }[]>`
      SELECT body, ts, msg_id FROM harness_shared.coord_event_log
       WHERE workspace_id = ${this.resolveWs()} AND surface = ${surface} AND msg_id = ${msgId}
       LIMIT 1
    `;
    return rows.length > 0 ? parseBody(rows[0].body, rows[0]) : null;
  }

  /**
   * WI-3880: the true incremental-pagination sibling of `readEventsBounded`.
   * `id` is the table's real bigserial PK — a persistent, monotonic
   * append-order cursor — so `beforeId` (`AND id < $beforeId`) lets a caller
   * walk arbitrarily deep into history instead of being capped at one
   * fixed-size window. Fetches `limit + 1` rows to detect `exhausted` (whether
   * anything OLDER than the returned page remains) without a second
   * round-trip, then trims the extra row off the returned page.
   */
  async readEventsBoundedCursor(
    surface: EventSurface,
    opts: { limit: number; kinds?: string[]; beforeId?: number },
  ): Promise<CoordLogCursorPage> {
    await this.opts.ensureSchema();
    const sql = this.opts.getSql();
    const limit = Math.max(1, Math.min(Math.floor(opts.limit) || 1, 1000));
    const kinds = opts.kinds?.filter((k) => typeof k === 'string' && k.trim());
    const beforeId =
      typeof opts.beforeId === 'number' && Number.isFinite(opts.beforeId) ? Math.floor(opts.beforeId) : null;
    const rows = await sql<{ id: number; body: unknown; ts: Date; msg_id: string }[]>`
      SELECT id, body, ts, msg_id FROM harness_shared.coord_event_log
       WHERE workspace_id = ${this.resolveWs()} AND surface = ${surface}
         ${kinds && kinds.length ? sql`AND body->>'kind' = ANY(${kinds}::text[])` : sql``}
         ${beforeId !== null ? sql`AND id < ${beforeId}` : sql``}
       ORDER BY id DESC
       LIMIT ${limit + 1}
    `;
    const exhausted = rows.length <= limit;
    const page = rows.slice(0, limit);
    // `id` is bigserial (int8); postgres-js returns int8 columns as a STRING
    // (not a JS number) to avoid precision loss outside Number.MAX_SAFE_INTEGER.
    // Normalize to a real number here — this table will never approach 2^53
    // rows — so a caller's round-tripped `beforeId` (typeof === 'number') binds
    // correctly on the next call instead of silently failing the `typeof
    // opts.beforeId === 'number'` guard above and dropping the cursor filter.
    return {
      rows: page.map((r) => ({ id: Number(r.id), envelope: parseBody(r.body, r) })),
      exhausted,
    };
  }

  /** The line-surface sibling of {@link readEventsBoundedCursor} — same
   *  `id < beforeId` cursor, plus the existing `sinceTs`/`planSlug` pushdowns. */
  async readLinesBoundedCursor(
    surface: LineSurface,
    opts: { limit: number; sinceTs?: string; planSlug?: string; kinds?: string[]; beforeId?: number },
  ): Promise<CoordLogCursorPage> {
    await this.opts.ensureSchema();
    const sql = this.opts.getSql();
    const limit = Math.max(1, Math.min(Math.floor(opts.limit) || 1, 1000));
    const kinds = opts.kinds?.filter((k) => typeof k === 'string' && k.trim());
    const sinceTs = typeof opts.sinceTs === 'string' && opts.sinceTs ? opts.sinceTs : null;
    const planSlug = typeof opts.planSlug === 'string' && opts.planSlug ? opts.planSlug : null;
    const beforeId =
      typeof opts.beforeId === 'number' && Number.isFinite(opts.beforeId) ? Math.floor(opts.beforeId) : null;
    const rows = await sql<{ id: number; body: unknown; ts: Date; msg_id: string }[]>`
      SELECT id, body, ts, msg_id FROM harness_shared.coord_event_log
       WHERE workspace_id = ${this.resolveWs()} AND surface = ${surface}
         ${kinds && kinds.length ? sql`AND body->>'kind' = ANY(${kinds}::text[])` : sql``}
         ${sinceTs ? sql`AND body->>'ts' > ${sinceTs}` : sql``}
         ${planSlug ? sql`AND body->>'plan_slug' = ${planSlug}` : sql``}
         ${beforeId !== null ? sql`AND id < ${beforeId}` : sql``}
       ORDER BY id DESC
       LIMIT ${limit + 1}
    `;
    const exhausted = rows.length <= limit;
    const page = rows.slice(0, limit);
    // See the same Number(...) normalization note in readEventsBoundedCursor.
    return {
      rows: page.map((r) => ({ id: Number(r.id), envelope: parseBody(r.body, r) })),
      exhausted,
    };
  }
}
