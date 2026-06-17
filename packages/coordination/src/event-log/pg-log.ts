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
 */
function parseBody(v: unknown): CoordEnvelope {
  if (typeof v === 'string') return JSON.parse(v) as CoordEnvelope;
  return v as CoordEnvelope;
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
 * the index rebuild is safe — no production data on this table yet).
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
  // Migrate a pre-D-007 table that has no scoping column.
  await sql`
    ALTER TABLE harness_shared.coord_event_log
      ADD COLUMN IF NOT EXISTS workspace_id text NOT NULL DEFAULT 'default'
  `;
  // harness_slug: the harness scope projected from CoordEnvelope.harness_slug.
  // NULL = operator-scope/workspace-global (local). The federation migration
  // (147) adds the same column + the capture triggers + the fed unique index;
  // keeping it here too means the runtime-bootstrapped table (conformance / fresh
  // test rigs) has the scope column without depending on migration order.
  await sql`
    ALTER TABLE harness_shared.coord_event_log
      ADD COLUMN IF NOT EXISTS harness_slug text
  `;
  // EVENT surfaces are keyed: exactly one immutable record per (workspace_id,
  // surface, msg_id). LINE surfaces (messages/plan-events) are pure append —
  // the partial predicate keeps them out of the uniqueness constraint so the
  // upsert below targets only the event rows. DROP-then-CREATE so a narrower
  // pre-D-007 index (without workspace_id) is widened rather than kept.
  await sql`DROP INDEX IF EXISTS harness_shared.coord_event_log_event_uq`;
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS coord_event_log_event_uq
      ON harness_shared.coord_event_log (workspace_id, surface, msg_id)
      WHERE surface IN ('handoffs', 'escalations')
  `;
  await sql`DROP INDEX IF EXISTS harness_shared.coord_event_log_surface_id`;
  await sql`
    CREATE INDEX IF NOT EXISTS coord_event_log_surface_id
      ON harness_shared.coord_event_log (workspace_id, surface, id)
  `;
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
    await sql`
      INSERT INTO harness_shared.coord_event_log (workspace_id, surface, writer_key, msg_id, body, harness_slug)
      VALUES (${this.resolveWs()}, ${surface}, ${writerKey}, ${line.msg_id}, ${JSON.stringify(line)}::text::jsonb, ${line.harness_slug ?? null})
    `;
  }

  async readLines(surface: LineSurface, _opts: ReadLinesOpts = {}): Promise<CoordEnvelope[]> {
    await this.opts.ensureSchema();
    const sql = this.opts.getSql();
    // `filesBack` is an fs-rotation hint; a single table has no rotation, so
    // we read everything (the interface explicitly allows ignoring it).
    const rows = await sql<{ body: unknown }[]>`
      SELECT body FROM harness_shared.coord_event_log
       WHERE workspace_id = ${this.resolveWs()} AND surface = ${surface}
       ORDER BY id ASC
    `;
    return rows.map((r) => parseBody(r.body));
  }

  async putEvent(surface: EventSurface, msgId: string, record: CoordEnvelope): Promise<void> {
    await this.opts.ensureSchema();
    const sql = this.opts.getSql();
    await sql`
      INSERT INTO harness_shared.coord_event_log (workspace_id, surface, writer_key, msg_id, body, harness_slug)
      VALUES (${this.resolveWs()}, ${surface}, NULL, ${msgId}, ${JSON.stringify(record)}::text::jsonb, ${record.harness_slug ?? null})
      ON CONFLICT (workspace_id, surface, msg_id) WHERE surface IN ('handoffs', 'escalations')
      DO UPDATE SET body = EXCLUDED.body, ts = now(), harness_slug = EXCLUDED.harness_slug
    `;
  }

  async readEvents(surface: EventSurface): Promise<CoordEnvelope[]> {
    await this.opts.ensureSchema();
    const sql = this.opts.getSql();
    const rows = await sql<{ body: unknown }[]>`
      SELECT body FROM harness_shared.coord_event_log
       WHERE workspace_id = ${this.resolveWs()} AND surface = ${surface}
       ORDER BY id ASC
    `;
    return rows.map((r) => parseBody(r.body));
  }

  async getEvent(surface: EventSurface, msgId: string): Promise<CoordEnvelope | null> {
    await this.opts.ensureSchema();
    const sql = this.opts.getSql();
    const rows = await sql<{ body: unknown }[]>`
      SELECT body FROM harness_shared.coord_event_log
       WHERE workspace_id = ${this.resolveWs()} AND surface = ${surface} AND msg_id = ${msgId}
       LIMIT 1
    `;
    return rows.length > 0 ? parseBody(rows[0].body) : null;
  }
}
