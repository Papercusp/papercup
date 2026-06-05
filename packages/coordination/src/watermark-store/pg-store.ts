/**
 * pg-store.ts — PgWatermarkStore: the production watermark store over an
 * injected postgres-js handle. One mutable row per `(workspace_id,
 * owner_id)` in `harness_shared.coord_watermarks`; the whole `Watermark`
 * rides in a `surfaces` jsonb column. Satisfies the SAME WatermarkStore
 * conformance suite as the in-memory double (the P-050 gate).
 *
 * Host couplings injected, matching PgPresenceStore / PgCoordLog: the org
 * PG handle (`getSql`), the table bootstrap (`ensureSchema`), and the
 * construction-bound `workspaceId` scope (parity with
 * coord_presence.workspace_id — see coord-channels-pg-port D-007).
 *
 * Single-writer-per-owner (an agent writes only its own cursor, at turn
 * end), so the read-modify-write is safe without a lock — the same
 * invariant the fs adapter relied on.
 */

import type { Sql } from 'postgres';
import {
  emptyWatermark,
  mergeWatermark,
  normaliseWatermark,
  type Watermark,
} from '@papercusp/pubsub-substrate/core';
import { DEFAULT_COORD_WORKSPACE } from '../event-log/pg-log';
import type { WatermarkStore } from '@papercusp/pubsub-substrate/watermark-store';

export interface PgWatermarkStoreOptions {
  /** The org Postgres handle (postgres-js tagged template). Called per use. */
  getSql: () => Sql;
  /** Ensure `harness_shared.coord_watermarks` exists before first use. */
  ensureSchema: () => Promise<void>;
  /** Coordination scope (parity with coord_presence.workspace_id). Default 'default'. */
  workspaceId?: string;
}

/**
 * postgres-js returns a jsonb column as raw TEXT under `prepare: false`
 * (the org handle's option) — so parse a string defensively, same posture
 * as PgPresenceStore.parseFiles / PgCoordLog.parseBody.
 */
function parseSurfaces(v: unknown): Watermark {
  if (typeof v === 'string') {
    try {
      return normaliseWatermark(JSON.parse(v) as Partial<Watermark>);
    } catch {
      return emptyWatermark();
    }
  }
  if (v && typeof v === 'object') return normaliseWatermark(v as Partial<Watermark>);
  return emptyWatermark();
}

/** Create the `coord_watermarks` table if absent. Idempotent. */
export async function ensureCoordWatermarksTable(sql: Sql): Promise<void> {
  await sql`CREATE SCHEMA IF NOT EXISTS harness_shared`;
  await sql`
    CREATE TABLE IF NOT EXISTS harness_shared.coord_watermarks (
      workspace_id text        NOT NULL DEFAULT 'default',
      owner_id     text        NOT NULL,
      surfaces     jsonb       NOT NULL DEFAULT '{}'::jsonb,
      updated_at   timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (workspace_id, owner_id)
    )
  `;
}

export class PgWatermarkStore implements WatermarkStore {
  private readonly ws: string;

  constructor(private readonly opts: PgWatermarkStoreOptions) {
    this.ws = opts.workspaceId ?? DEFAULT_COORD_WORKSPACE;
  }

  async read(ownerId: string): Promise<Watermark> {
    await this.opts.ensureSchema();
    const sql = this.opts.getSql();
    const rows = await sql<{ surfaces: unknown }[]>`
      SELECT surfaces FROM harness_shared.coord_watermarks
       WHERE workspace_id = ${this.ws} AND owner_id = ${ownerId}
       LIMIT 1
    `;
    return rows.length > 0 ? parseSurfaces(rows[0].surfaces) : emptyWatermark();
  }

  async write(ownerId: string, patch: Partial<Watermark>): Promise<Watermark> {
    await this.opts.ensureSchema();
    const sql = this.opts.getSql();
    const next = mergeWatermark(await this.read(ownerId), patch);
    await sql`
      INSERT INTO harness_shared.coord_watermarks (workspace_id, owner_id, surfaces, updated_at)
      VALUES (${this.ws}, ${ownerId}, ${JSON.stringify(next)}::text::jsonb, now())
      ON CONFLICT (workspace_id, owner_id)
      DO UPDATE SET surfaces = EXCLUDED.surfaces, updated_at = now()
    `;
    return next;
  }
}
