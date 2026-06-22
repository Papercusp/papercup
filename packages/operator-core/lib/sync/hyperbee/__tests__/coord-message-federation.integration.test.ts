/**
 * Integration test for coord_event_log (message rail) federation (Track A,
 * distributed-coordination-shared-harness-2026-06-04, surface #1). Real Postgres.
 *
 * Proves the full send + apply seam for the highest-value coord surface:
 *   1. CAPTURE: migration-147 triggers enqueue a substrate_outbox row for a
 *      HARNESS-scoped, ORIGINAL, local message/handoff/escalation — and enqueue
 *      NOTHING for an operator-scope row, a fan-out delivery copy (notify_kind
 *      set), a plan-events row, or a remote-origin (projected) row.
 *   2. RESHAPE: outboxRowToLocalWriteOp → a 'coord-messages' op with the body
 *      envelope + epoch-ms ts.
 *   3. APPLY: the projection upserts a remote row (origin='remote'); and a
 *      two-peer A→B convergence through the real reshape→decode→project chain.
 *
 * Owns its schema (the 000-baseline coord_event_log + the real 102 outbox/capture
 * fn + migration 147 verbatim); does not touch the dev DB.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createFreshPgDb, type FreshPgDb } from '../../../../test/_pg-helpers';
import { outboxRowToLocalWriteOp, type OutboxRow } from '../feature-issue-op-keys';
import { buildCoordMessageProjection, type CoordMessageRow } from '../projections/coord-message';

// EI-279: the projection's federated deliver-and-wake fan dynamically imports
// wakeRecipients — mock it so these tests assert the fan contract without the
// real await-event pump.
vi.mock('../../../agent-tools/coordination/inbox-wake', () => ({
  wakeRecipients: vi.fn(async (recipients: readonly string[]) => ({
    targets: [...recipients],
    keys: [],
    woken: 1,
    staged: 0,
  })),
}));
import { wakeRecipients } from '../../../agent-tools/coordination/inbox-wake';
import { HARNESS_FEATURES_CONSOLIDATED_DDL } from "./../../../../test/_work-items-schema";

const HERE = dirname(fileURLToPath(import.meta.url));
const SQL_DIR = resolve(HERE, '../../../../../../libs/papercusp/libs/db/sql');
const OUTBOX_MIGRATION = resolve(SQL_DIR, 'archive/102-substrate-outbox.sql');
const FED_MIGRATION = resolve(SQL_DIR, '150-coord-event-log-federation.sql');

function stripMeta(sql: string): string {
  return sql
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      if (t.startsWith('\\')) return false;
      if (/^(begin|commit);$/i.test(t)) return false;
      return true;
    })
    .join('\n');
}

const WS = 'ws_msg';
const HARNESS = 'fed';

interface OutboxDbRow {
  table_name: string;
  op: string;
  key: string;
  row: Record<string, unknown> | null;
  ts: number;
  harness_slug: string;
}

function envelope(msgId: string, extra: Record<string, unknown> = {}) {
  return { ts: '2026-06-04T00:00:00Z', msg_id: msgId, from: 'su-A', to: ['su-B'], kind: 'message', summary: 's', ...extra };
}

describe('coord_event_log federation (real PG)', () => {
  let db: FreshPgDb;

  beforeAll(async () => {
    db = await createFreshPgDb('coord_msg_fed');
  await db.sql.unsafe(HARNESS_FEATURES_CONSOLIDATED_DDL);
    await db.sql.unsafe(`
      DO $r$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'harness_app') THEN CREATE ROLE harness_app NOLOGIN; END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'harness_admin') THEN CREATE ROLE harness_admin NOLOGIN; END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'harness_zero') THEN CREATE ROLE harness_zero NOLOGIN; END IF;
      END $r$;
    `);

    // The 000-baseline coord_event_log (pre-147 — no harness_slug/origin yet).
    await db.sql.unsafe(`
      CREATE TABLE harness_shared.coord_event_log (
        id           bigserial   PRIMARY KEY,
        workspace_id text        NOT NULL DEFAULT 'default',
        surface      text        NOT NULL,
        writer_key   text,
        msg_id       text        NOT NULL,
        body         jsonb       NOT NULL,
        ts           timestamptz NOT NULL DEFAULT now()
      );
    `);

    // Migration 102 attaches triggers to the consolidated tables → they must exist.
    await db.sql.unsafe(`
      CREATE TABLE harness_shared.harness_features_consolidated (
        workspace_id TEXT NOT NULL DEFAULT '', harness_slug TEXT NOT NULL,
        feature_id TEXT NOT NULL, author_pubkey TEXT, origin TEXT NOT NULL DEFAULT 'local',
        PRIMARY KEY (harness_slug, feature_id));
      CREATE TABLE harness_shared.harness_issues_consolidated (
        workspace_id TEXT NOT NULL DEFAULT '', harness_slug TEXT NOT NULL,
        issue_id TEXT NOT NULL, author_pubkey TEXT, origin TEXT NOT NULL DEFAULT 'local',
        PRIMARY KEY (harness_slug, issue_id));
    `);

    await db.sql.unsafe(readFileSync(OUTBOX_MIGRATION, 'utf8'));
    // Migration 147 verbatim: adds harness_slug/origin/author_pubkey + fed index + triggers.
    await db.sql.unsafe(stripMeta(readFileSync(FED_MIGRATION, 'utf8')));
    // EI-79 step 2 (mig 181): the PG-level LWW guard column the writer stamps.
    await db.sql.unsafe(`ALTER TABLE harness_shared.coord_event_log ADD COLUMN IF NOT EXISTS fed_ts BIGINT`);
    await db.sql.unsafe(`ALTER TABLE harness_shared.coord_event_log ADD COLUMN IF NOT EXISTS fed_hlc TEXT`);
  }, 60_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  async function insertRow(opts: {
    msgId: string; surface?: string; harness?: string | null; writer?: string | null;
    body?: Record<string, unknown>; origin?: string;
  }) {
    await db.sql`
      INSERT INTO harness_shared.coord_event_log
        (workspace_id, surface, writer_key, msg_id, body, harness_slug, origin)
      VALUES (${WS}, ${opts.surface ?? 'messages'}, ${opts.writer === undefined ? 'su-A' : opts.writer}, ${opts.msgId},
        ${JSON.stringify(opts.body ?? envelope(opts.msgId))}::text::jsonb,
        ${opts.harness === undefined ? HARNESS : opts.harness}, ${opts.origin ?? 'local'})
    `;
  }
  async function outbox(): Promise<OutboxDbRow[]> {
    return db.sql<OutboxDbRow[]>`
      SELECT table_name, op, key, row, ts, harness_slug FROM harness_shared.substrate_outbox ORDER BY id`;
  }
  async function clearOutbox() {
    await db.sql`DELETE FROM harness_shared.substrate_outbox`;
  }

  it('a harness-scoped local message enqueues one put outbox row keyed by msg_id', async () => {
    await clearOutbox();
    await insertRow({ msgId: 'm-1' });
    const rows = await outbox();
    expect(rows).toHaveLength(1);
    expect(rows[0].table_name).toBe('coord_event_log');
    expect(rows[0].op).toBe('put');
    expect(rows[0].key).toBe('m-1');
    expect(rows[0].harness_slug).toBe(HARNESS);
  });

  it('an operator-scope message (harness_slug NULL) enqueues NOTHING', async () => {
    await clearOutbox();
    await insertRow({ msgId: 'm-op', harness: null });
    expect(await outbox()).toHaveLength(0);
  });

  it('a fan-out delivery copy (body.notify_kind set) enqueues NOTHING', async () => {
    await clearOutbox();
    await insertRow({ msgId: 'm-fan', writer: 'su-B', body: envelope('m-fan', { notify_kind: 'topic' }) });
    expect(await outbox()).toHaveLength(0);
  });

  it('a plan-events row enqueues NOTHING (surface filter — plans federate separately)', async () => {
    await clearOutbox();
    await insertRow({ msgId: 'm-pe', surface: 'plan-events' });
    expect(await outbox()).toHaveLength(0);
  });

  it('a remote-origin message enqueues NOTHING (echo-loop guard)', async () => {
    await clearOutbox();
    await insertRow({ msgId: 'm-remote', origin: 'remote' });
    expect(await outbox()).toHaveLength(0);
  });

  it('a harness-scoped handoff enqueues a put; the reshape builds a coord-messages op', async () => {
    await clearOutbox();
    await insertRow({ msgId: 'h-1', surface: 'handoffs', writer: null, body: envelope('h-1', { kind: 'handoff' }) });
    const rows = await outbox();
    expect(rows).toHaveLength(1);
    const op = outboxRowToLocalWriteOp({
      table_name: rows[0].table_name, op: rows[0].op as 'put', key: rows[0].key, ts: rows[0].ts, row: rows[0].row,
    } as OutboxRow);
    expect(op.type).toBe('put');
    expect(op.table).toBe('coord-messages');
    expect(op.hbKey).toBe('h-1');
    const value = (op as { value: CoordMessageRow }).value;
    expect(value.msg_id).toBe('h-1');
    expect(value.surface).toBe('handoffs');
    expect(value.writer_key).toBeNull();
    expect(value.body.kind).toBe('handoff');
    expect(typeof value.ts).toBe('number');
    expect(value.ts).toBeGreaterThan(0);
  });

  it("projection writeToPg upserts a remote message (origin='remote') and deleteFromPg removes it", async () => {
    const proj = buildCoordMessageProjection({ workspaceId: WS, harnessSlug: HARNESS, sql: db.sql });
    const remote: CoordMessageRow = {
      harness_slug: HARNESS, msg_id: 'm-peer', surface: 'messages', writer_key: 'peer-A',
      body: envelope('m-peer', { summary: 'from a peer' }), ts: 1_700_000_000_000,
    };
    await proj.writeToPg(remote, { authorPubkey: 'peerPubA', origin: 'remote' });
    const [row] = await db.sql<{ origin: string; author_pubkey: string | null; surface: string; writer_key: string | null }[]>`
      SELECT origin, author_pubkey, surface, writer_key FROM harness_shared.coord_event_log WHERE workspace_id=${WS} AND msg_id='m-peer'`;
    expect(row.origin).toBe('remote');
    expect(row.author_pubkey).toBe('peerPubA');
    expect(row.surface).toBe('messages');
    expect(row.writer_key).toBe('peer-A');

    // Upsert is idempotent on re-merge (same msg_id).
    await proj.writeToPg({ ...remote, body: envelope('m-peer', { summary: 'edited' }) }, { authorPubkey: 'peerPubA', origin: 'remote' });
    const dupes = await db.sql`SELECT 1 FROM harness_shared.coord_event_log WHERE workspace_id=${WS} AND msg_id='m-peer'`;
    expect(dupes).toHaveLength(1);

    await proj.deleteFromPg('m-peer');
    expect(await db.sql`SELECT 1 FROM harness_shared.coord_event_log WHERE workspace_id=${WS} AND msg_id='m-peer'`).toHaveLength(0);
  });

  it('two-peer convergence: a message sent on A lands on B (origin=remote) via the real reshape→decode→project chain', async () => {
    const dbB = await createFreshPgDb('coord_msg_fed_b');
    try {
      await dbB.sql.unsafe(`
        CREATE TABLE harness_shared.coord_event_log (
          id bigserial PRIMARY KEY, workspace_id text NOT NULL DEFAULT 'default', surface text NOT NULL,
          writer_key text, msg_id text NOT NULL, body jsonb NOT NULL, ts timestamptz NOT NULL DEFAULT now(),
          harness_slug text, origin text NOT NULL DEFAULT 'local', author_pubkey text,
          fed_ts bigint, fed_hlc text); -- mig 181 fed_ts + mig 314 fed_hlc LWW-guard columns
        CREATE UNIQUE INDEX coord_event_log_fed_uq ON harness_shared.coord_event_log (workspace_id, msg_id)
          WHERE harness_slug IS NOT NULL AND (body->>'notify_kind') IS NULL;
      `);
      const projB = buildCoordMessageProjection({ workspaceId: WS, harnessSlug: HARNESS, sql: dbB.sql });
      async function applyOnB(r: OutboxDbRow) {
        const op = outboxRowToLocalWriteOp({ table_name: r.table_name, op: r.op as 'put', key: r.key, ts: r.ts, row: r.row } as OutboxRow);
        if (op.type === 'del') return projB.deleteFromPg(op.hbKey);
        const decoded = projB.decodeValue((op as { value: unknown }).value);
        expect(decoded, 'reshaped message must satisfy the projection decoder').not.toBeNull();
        await projB.writeToPg(decoded!, { authorPubkey: 'peerA', origin: 'remote' });
      }

      await clearOutbox();
      await insertRow({ msgId: 'conv-msg', body: envelope('conv-msg', { summary: 'cross-machine ping', to: ['su-B'] }) });
      for (const r of await outbox()) await applyOnB(r);
      const [onB] = await dbB.sql<{ summary: unknown; origin: string; surface: string }[]>`
        SELECT body->>'summary' AS summary, origin, surface FROM harness_shared.coord_event_log WHERE msg_id='conv-msg'`;
      expect(onB.summary).toBe('cross-machine ping');
      expect(onB.origin).toBe('remote');
      expect(onB.surface).toBe('messages');

      // DELETE on A converges to absent on B.
      await clearOutbox();
      await db.sql`DELETE FROM harness_shared.coord_event_log WHERE workspace_id=${WS} AND msg_id='conv-msg'`;
      for (const r of await outbox()) await applyOnB(r);
      expect(await dbB.sql`SELECT 1 FROM harness_shared.coord_event_log WHERE msg_id='conv-msg'`).toHaveLength(0);
    } finally {
      await dbB.cleanup();
    }
  });

  describe('EI-279 — federated deliver-and-wake fan', () => {
    const proj = () => buildCoordMessageProjection({ workspaceId: WS, harnessSlug: HARNESS, sql: db.sql });
    const remoteWakeRow = (msgId: string): CoordMessageRow => ({
      harness_slug: HARNESS,
      msg_id: msgId,
      surface: 'messages',
      writer_key: 'peer-A',
      body: envelope(msgId, { wake: true, summary: 'wake me', to: ['su-B', 'su-C'] }),
      ts: 1_700_000_000_000,
    });

    it('the wake intent FEDERATES: body.wake survives capture → reshape', async () => {
      await clearOutbox();
      await insertRow({ msgId: 'wake-fed', body: envelope('wake-fed', { wake: true }) });
      const rows = await outbox();
      expect(rows).toHaveLength(1);
      const op = outboxRowToLocalWriteOp({
        table_name: rows[0].table_name, op: rows[0].op as 'put', key: rows[0].key,
        ts: rows[0].ts, row: rows[0].row,
      } as OutboxRow);
      expect(((op as { value: CoordMessageRow }).value.body as { wake?: unknown }).wake).toBe(true);
    });

    it('a FRESH remote-origin row with body.wake fires the local fan ONCE; re-applies never re-wake', async () => {
      vi.mocked(wakeRecipients).mockClear();
      const p = proj();
      await p.writeToPg(remoteWakeRow('wake-1'), { authorPubkey: 'peerPubA', origin: 'remote' });
      expect(wakeRecipients).toHaveBeenCalledExactlyOnceWith(['su-B', 'su-C'], {
        summary: 'wake me',
        source: 'su-A',
        workspaceId: WS,
      });

      // At-least-once re-apply (same op after a cursor reset) → UPDATE path → no re-wake.
      await p.writeToPg(remoteWakeRow('wake-1'), { authorPubkey: 'peerPubA', origin: 'remote' });
      expect(wakeRecipients).toHaveBeenCalledTimes(1);
    });

    it('no wake intent → no fan; local origin → no fan (defensive)', async () => {
      vi.mocked(wakeRecipients).mockClear();
      const p = proj();
      const noWake: CoordMessageRow = {
        ...remoteWakeRow('wake-2'),
        body: envelope('wake-2', { summary: 'plain inject' }),
      };
      await p.writeToPg(noWake, { authorPubkey: 'peerPubA', origin: 'remote' });
      await p.writeToPg(remoteWakeRow('wake-3'), { authorPubkey: 'peerPubA', origin: 'local' });
      expect(wakeRecipients).not.toHaveBeenCalled();
    });

    it('a wake-fan failure never fails the projection apply (message persists)', async () => {
      vi.mocked(wakeRecipients).mockRejectedValueOnce(new Error('pump down'));
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        await proj().writeToPg(remoteWakeRow('wake-4'), { authorPubkey: 'peerPubA', origin: 'remote' });
        expect(
          await db.sql`SELECT 1 FROM harness_shared.coord_event_log WHERE workspace_id=${WS} AND msg_id='wake-4'`,
        ).toHaveLength(1);
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining('federated wake fan failed'),
          expect.anything(),
        );
      } finally {
        warnSpy.mockRestore();
      }
    });
  });
});
