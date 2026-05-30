/**
 * pg-store.ts — PgSubscriptionStore: the production watch store over an
 * injected postgres-js handle. One mutable row per watch in
 * `harness_shared.coord_subscriptions`; unwatch sets `cancelled_at` (soft,
 * mirroring the harness `messages` status-transition house style) and
 * expiry is a `WHERE expires_ts > now()` filter — so the fs append-and-fold
 * of subscribe/unsubscribe lines collapses to plain rows. Satisfies the
 * SAME SubscriptionStore conformance suite as the in-memory double (P-050).
 *
 * Host couplings injected, matching the sibling PG stores: `getSql`,
 * `ensureSchema`, and the construction-bound `workspaceId` scope (parity
 * with coord_presence.workspace_id — coord-channels-pg-port D-007).
 */

import type { Sql } from 'postgres';
import { DEFAULT_COORD_WORKSPACE } from '../event-log/pg-log';
import type {
  AddSubscriptionInput,
  SubscriptionRecord,
  SubscriptionStore,
} from './types';

export interface PgSubscriptionStoreOptions {
  /** The org Postgres handle (postgres-js tagged template). Called per use. */
  getSql: () => Sql;
  /** Ensure `harness_shared.coord_subscriptions` exists before first use. */
  ensureSchema: () => Promise<void>;
  /** Coordination scope (parity with coord_presence.workspace_id). Default 'default'. */
  workspaceId?: string;
}

/** Normalize a timestamptz (Date under postgres-js, or a string) to ISO. */
function tsToIso(v: unknown): string {
  if (v instanceof Date) return v.toISOString();
  return new Date(v as string).toISOString();
}

interface SubRow {
  msg_id: string;
  owner_id: string;
  pattern: string;
  trigger: string;
  created_at: unknown;
  expires_ts: unknown;
}

/** Create the `coord_subscriptions` table + partial index if absent. Idempotent. */
export async function ensureCoordSubscriptionsTable(sql: Sql): Promise<void> {
  await sql`CREATE SCHEMA IF NOT EXISTS harness_shared`;
  await sql`
    CREATE TABLE IF NOT EXISTS harness_shared.coord_subscriptions (
      msg_id       text        PRIMARY KEY,
      workspace_id text        NOT NULL DEFAULT 'default',
      owner_id     text        NOT NULL,
      pattern      text        NOT NULL,
      trigger      text        NOT NULL,
      expires_ts   timestamptz,
      cancelled_at timestamptz,
      created_at   timestamptz NOT NULL DEFAULT now()
    )
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS coord_subscriptions_owner_active
      ON harness_shared.coord_subscriptions (workspace_id, owner_id)
      WHERE cancelled_at IS NULL
  `;
}

export class PgSubscriptionStore implements SubscriptionStore {
  private readonly ws: string;

  constructor(private readonly opts: PgSubscriptionStoreOptions) {
    this.ws = opts.workspaceId ?? DEFAULT_COORD_WORKSPACE;
  }

  async add(sub: AddSubscriptionInput): Promise<void> {
    await this.opts.ensureSchema();
    const sql = this.opts.getSql();
    await sql`
      INSERT INTO harness_shared.coord_subscriptions
        (msg_id, workspace_id, owner_id, pattern, trigger, expires_ts, created_at)
      VALUES (${sub.msg_id}, ${this.ws}, ${sub.owner_id}, ${sub.pattern}, ${sub.trigger},
              ${sub.expires_ts ?? null}, ${sub.created_ts})
      ON CONFLICT (msg_id) DO NOTHING
    `;
  }

  async cancel(ownerId: string, msgId: string): Promise<void> {
    await this.opts.ensureSchema();
    const sql = this.opts.getSql();
    await sql`
      UPDATE harness_shared.coord_subscriptions
         SET cancelled_at = now()
       WHERE workspace_id = ${this.ws} AND owner_id = ${ownerId} AND msg_id = ${msgId}
         AND cancelled_at IS NULL
    `;
  }

  async listActive(opts: { owner?: string } = {}): Promise<SubscriptionRecord[]> {
    await this.opts.ensureSchema();
    const sql = this.opts.getSql();
    const owner = opts.owner ?? null;
    const rows = await sql<SubRow[]>`
      SELECT msg_id, owner_id, pattern, trigger, created_at, expires_ts
        FROM harness_shared.coord_subscriptions
       WHERE workspace_id = ${this.ws}
         AND cancelled_at IS NULL
         AND (expires_ts IS NULL OR expires_ts > now())
         AND ${owner == null ? sql`TRUE` : sql`owner_id = ${owner}`}
       ORDER BY created_at ASC, msg_id ASC
    `;
    return rows.map((r) => ({
      msg_id: r.msg_id,
      owner_id: r.owner_id,
      pattern: r.pattern,
      trigger: r.trigger,
      created_ts: tsToIso(r.created_at),
      expires_ts: r.expires_ts == null ? null : tsToIso(r.expires_ts),
    }));
  }
}
