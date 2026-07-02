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
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createFreshPgDb, type FreshPgDb } from '../../../../test/_pg-helpers';
import { outboxRowToLocalWriteOp, type OutboxRow } from '../feature-issue-op-keys';
import { buildCoordMessageProjection, type CoordMessageRow } from '../projections/coord-message';
import { resetFederatedWakeRate } from '../federated-wake-rate';

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
// P-002 (cross-machine-coord-parity): the projection's reply-wake leg reads the
// COORD_WAKE_ON_REPLY flag — mock the server read so ON/OFF is deterministic here.
vi.mock('@papercusp/flags/server', () => ({ getFlag: vi.fn(async () => true) }));
import { getFlag } from '@papercusp/flags/server';
// P-009: the projection's fed-event consumer dynamically imports the await
// engine — mock it so re-fires are asserted without the real pump.
vi.mock('../../../events/await/engine', () => ({
  emitAwaitedEvent: vi.fn(async () => ({ key: '', woken: 0, notified: [], msgId: null })),
}));
import { emitAwaitedEvent } from '../../../events/await/engine';
// P-008: the projection's receipt leg dynamically imports sendMessage +
// machineFingerprint — mock both so receipts are asserted without the coord seam.
vi.mock('../../../agent-tools/coordination/messages', () => ({
  sendMessage: vi.fn(async () => ({ msg_id: 'receipt-1', to: [], ts: 't' })),
}));
import { sendMessage } from '../../../agent-tools/coordination/messages';
vi.mock('../../../identity/device-keychain-id', () => ({
  machineFingerprint: vi.fn(() => 'test-machine'),
}));

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
    // P-013: the quarantine table (mig 436 verbatim).
    await db.sql.unsafe(stripMeta(readFileSync(resolve(SQL_DIR, '436-coord-quarantine.sql'), 'utf8')));
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
    beforeEach(() => resetFederatedWakeRate()); // P-003: isolate each test's wake budget
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

  describe('P-002 — federated wake-on-reply (cross-machine-coord-parity-and-trust-2026-07-01)', () => {
    beforeEach(() => resetFederatedWakeRate()); // P-003: isolate each test's wake budget
    const proj = () => buildCoordMessageProjection({ workspaceId: WS, harnessSlug: HARNESS, sql: db.sql });
    // A remote peer's REPLY: no wake intent of its own — only the reply correlation.
    const remoteReplyRow = (msgId: string, relatedMsgId: string, from = 'su-A'): CoordMessageRow => ({
      harness_slug: HARNESS,
      msg_id: msgId,
      surface: 'messages',
      writer_key: 'peer-A',
      body: envelope(msgId, { from, summary: 'the reply', related_msg_id: relatedMsgId }),
      ts: 1_700_000_000_000,
    });

    it('a fresh remote reply to a LOCAL opted-in original wakes the original sender ONCE (re-applies never re-wake)', async () => {
      await insertRow({
        msgId: 'orig-1',
        body: envelope('orig-1', { from: 'su-LOCAL', to: ['su-A'], wakeOnReply: true }),
      });
      vi.mocked(wakeRecipients).mockClear();
      const p = proj();
      await p.writeToPg(remoteReplyRow('reply-1', 'orig-1'), { authorPubkey: 'peerPubA', origin: 'remote' });
      expect(wakeRecipients).toHaveBeenCalledExactlyOnceWith(['su-LOCAL'], {
        summary: 'the reply',
        source: 'su-A',
        workspaceId: WS,
      });
      // at-least-once re-apply → UPDATE path → no re-wake
      await p.writeToPg(remoteReplyRow('reply-1', 'orig-1'), { authorPubkey: 'peerPubA', origin: 'remote' });
      expect(wakeRecipients).toHaveBeenCalledTimes(1);
    });

    it('an original WITHOUT the wakeOnReply opt-in → no reply-wake', async () => {
      await insertRow({
        msgId: 'orig-2',
        body: envelope('orig-2', { from: 'su-LOCAL', to: ['su-A'] }),
      });
      vi.mocked(wakeRecipients).mockClear();
      await proj().writeToPg(remoteReplyRow('reply-2', 'orig-2'), { authorPubkey: 'peerPubA', origin: 'remote' });
      expect(wakeRecipients).not.toHaveBeenCalled();
    });

    it('COORD_WAKE_ON_REPLY flag OFF → no reply-wake (matches the send-side gate)', async () => {
      await insertRow({
        msgId: 'orig-3',
        body: envelope('orig-3', { from: 'su-LOCAL', to: ['su-A'], wakeOnReply: true }),
      });
      vi.mocked(wakeRecipients).mockClear();
      vi.mocked(getFlag).mockResolvedValueOnce(false as never);
      await proj().writeToPg(remoteReplyRow('reply-3', 'orig-3'), { authorPubkey: 'peerPubA', origin: 'remote' });
      expect(wakeRecipients).not.toHaveBeenCalled();
    });

    it('a reply whose author IS the original sender never self-wakes', async () => {
      await insertRow({
        msgId: 'orig-4',
        body: envelope('orig-4', { from: 'su-A', to: ['su-LOCAL'], wakeOnReply: true }),
      });
      vi.mocked(wakeRecipients).mockClear();
      await proj().writeToPg(remoteReplyRow('reply-4', 'orig-4', 'su-A'), { authorPubkey: 'peerPubA', origin: 'remote' });
      expect(wakeRecipients).not.toHaveBeenCalled();
    });

    it('a reply to an UNKNOWN original is a quiet no-op — the reply row still persists', async () => {
      vi.mocked(wakeRecipients).mockClear();
      await proj().writeToPg(remoteReplyRow('reply-5', 'no-such-original'), { authorPubkey: 'peerPubA', origin: 'remote' });
      expect(wakeRecipients).not.toHaveBeenCalled();
      expect(
        await db.sql`SELECT 1 FROM harness_shared.coord_event_log WHERE workspace_id=${WS} AND msg_id='reply-5'`,
      ).toHaveLength(1);
    });

    it('P-003: an author device over its hourly wake budget gets messages APPLIED but wakes SUPPRESSED', async () => {
      process.env.PAPERCUSP_FED_WAKE_MAX_PER_HOUR = '2';
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        vi.mocked(wakeRecipients).mockClear();
        const p = proj();
        const wakeRow = (id: string): CoordMessageRow => ({
          harness_slug: HARNESS,
          msg_id: id,
          surface: 'messages',
          writer_key: 'peer-A',
          body: envelope(id, { wake: true, summary: 'spend', to: ['su-B'] }),
          ts: 1_700_000_000_000,
        });
        await p.writeToPg(wakeRow('cap-1'), { authorPubkey: 'flooder', origin: 'remote' });
        await p.writeToPg(wakeRow('cap-2'), { authorPubkey: 'flooder', origin: 'remote' });
        await p.writeToPg(wakeRow('cap-3'), { authorPubkey: 'flooder', origin: 'remote' });
        expect(wakeRecipients).toHaveBeenCalledTimes(2); // third wake suppressed
        // …but the third MESSAGE still applied — delivery is never dropped.
        expect(
          await db.sql`SELECT 1 FROM harness_shared.coord_event_log WHERE workspace_id=${WS} AND msg_id='cap-3'`,
        ).toHaveLength(1);
        // a DIFFERENT author device is unaffected by the flooder's exhausted budget
        await p.writeToPg(
          {
            ...wakeRow('cap-4'),
            body: envelope('cap-4', { wake: true, summary: 'legit', to: ['su-B'] }),
          },
          { authorPubkey: 'honest-peer', origin: 'remote' },
        );
        expect(wakeRecipients).toHaveBeenCalledTimes(3);
      } finally {
        warnSpy.mockRestore();
        delete process.env.PAPERCUSP_FED_WAKE_MAX_PER_HOUR;
      }
    });

    it('a reply carrying BOTH wake:true and related_msg_id fires both fans independently', async () => {
      await insertRow({
        msgId: 'orig-6',
        body: envelope('orig-6', { from: 'su-LOCAL', to: ['su-A'], wakeOnReply: true }),
      });
      vi.mocked(wakeRecipients).mockClear();
      const both: CoordMessageRow = {
        harness_slug: HARNESS,
        msg_id: 'reply-6',
        surface: 'messages',
        writer_key: 'peer-A',
        body: envelope('reply-6', {
          from: 'su-A',
          to: ['su-B'],
          wake: true,
          summary: 'urgent reply',
          related_msg_id: 'orig-6',
        }),
        ts: 1_700_000_000_000,
      };
      await proj().writeToPg(both, { authorPubkey: 'peerPubA', origin: 'remote' });
      expect(wakeRecipients).toHaveBeenCalledTimes(2);
      expect(vi.mocked(wakeRecipients).mock.calls[0][0]).toEqual(['su-B']); // EI-279 addressee fan
      expect(vi.mocked(wakeRecipients).mock.calls[1][0]).toEqual(['su-LOCAL']); // P-002 reply-wake
    });
  });
  describe('P-009 — federated event keys (fed_event re-fire)', () => {
    beforeEach(() => {
      resetFederatedWakeRate();
      vi.mocked(emitAwaitedEvent).mockClear();
    });
    const proj = () => buildCoordMessageProjection({ workspaceId: WS, harnessSlug: HARNESS, sql: db.sql });
    const fedEventRow = (msgId: string, key: string): CoordMessageRow => ({
      harness_slug: HARNESS,
      msg_id: msgId,
      surface: 'messages',
      writer_key: 'peer-A',
      body: envelope(msgId, {
        to: [],
        summary: `[fed-event] ${key}`,
        fed_event: { key, payload: { sha: 'abc123' }, source: 'su-A' },
      }),
      ts: 1_700_000_000_000,
    });

    it('a no-recipient fed_event row FEDERATES (capture despite empty to)', async () => {
      await clearOutbox();
      await insertRow({
        msgId: 'fe-cap',
        body: envelope('fe-cap', { to: [], fed_event: { key: 'k', source: 'su-A' } }),
      });
      expect(await outbox()).toHaveLength(1);
    });

    it('a fresh remote fed_event row re-fires the key locally ONCE; re-applies never re-fire', async () => {
      const p = proj();
      await p.writeToPg(fedEventRow('fe-1', 'git:staging-advanced'), { authorPubkey: 'peerPubA', origin: 'remote' });
      expect(emitAwaitedEvent).toHaveBeenCalledExactlyOnceWith({
        key: 'git:staging-advanced',
        payload: { sha: 'abc123' },
        source: 'su-A',
        workspaceId: WS,
      });
      await p.writeToPg(fedEventRow('fe-1', 'git:staging-advanced'), { authorPubkey: 'peerPubA', origin: 'remote' });
      expect(emitAwaitedEvent).toHaveBeenCalledTimes(1);
    });

    it('local-origin rows never re-fire (the origin machine already emitted locally)', async () => {
      await proj().writeToPg(fedEventRow('fe-2', 'k2'), { authorPubkey: 'peerPubA', origin: 'local' });
      expect(emitAwaitedEvent).not.toHaveBeenCalled();
    });

    it('the P-003 author budget bounds fed-event re-fires too (row still applies)', async () => {
      process.env.PAPERCUSP_FED_WAKE_MAX_PER_HOUR = '1';
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const p = proj();
        await p.writeToPg(fedEventRow('fe-3', 'k3'), { authorPubkey: 'flooder-fe', origin: 'remote' });
        await p.writeToPg(fedEventRow('fe-4', 'k4'), { authorPubkey: 'flooder-fe', origin: 'remote' });
        expect(emitAwaitedEvent).toHaveBeenCalledTimes(1); // second suppressed
        expect(
          await db.sql`SELECT 1 FROM harness_shared.coord_event_log WHERE workspace_id=${WS} AND msg_id='fe-4'`,
        ).toHaveLength(1);
      } finally {
        warnSpy.mockRestore();
        delete process.env.PAPERCUSP_FED_WAKE_MAX_PER_HOUR;
      }
    });
  });

  describe('P-008 — delivery receipts on apply', () => {
    beforeEach(() => {
      resetFederatedWakeRate();
      vi.mocked(sendMessage).mockClear();
      vi.mocked(wakeRecipients).mockClear();
    });
    const proj = () => buildCoordMessageProjection({ workspaceId: WS, harnessSlug: HARNESS, sql: db.sql });
    const receiptRow = (msgId: string): CoordMessageRow => ({
      harness_slug: HARNESS,
      msg_id: msgId,
      surface: 'messages',
      writer_key: 'peer-A',
      body: envelope(msgId, { wake: true, receipt: true, summary: 'need ack', to: ['su-B'] }),
      ts: 1_700_000_000_000,
    });

    it('applying a receipt-requesting row emits coord:receipt:<msg_id> back with the woken count', async () => {
      await proj().writeToPg(receiptRow('rcpt-1'), { authorPubkey: 'peerPubA', origin: 'remote' });
      expect(sendMessage).toHaveBeenCalledTimes(1);
      const [identity, opts] = vi.mocked(sendMessage).mock.calls[0] as [
        { ownerId: string },
        { to: string[]; harnessSlug?: string; extra?: { fed_event?: { key: string; payload: Record<string, unknown> } } },
      ];
      expect(identity.ownerId).toBe('fed-receipt');
      expect(opts.to).toEqual([]); // no inbox noise
      expect(opts.harnessSlug).toBe(HARNESS); // rides back over the same hive scope
      expect(opts.extra?.fed_event?.key).toBe('coord:receipt:rcpt-1');
      expect(opts.extra?.fed_event?.payload).toMatchObject({
        msg_id: 'rcpt-1',
        delivered: true,
        woken: 1, // the mocked fan woke 1
        machine: 'test-machine',
      });
    });

    it('re-applies never re-emit the receipt (once per msg_id)', async () => {
      const p = proj();
      await p.writeToPg(receiptRow('rcpt-2'), { authorPubkey: 'peerPubA', origin: 'remote' });
      await p.writeToPg(receiptRow('rcpt-2'), { authorPubkey: 'peerPubA', origin: 'remote' });
      expect(sendMessage).toHaveBeenCalledTimes(1);
    });

    it('no receipt without the request flag; local-origin rows never emit receipts', async () => {
      const p = proj();
      await p.writeToPg(
        {
          ...receiptRow('rcpt-3'),
          body: envelope('rcpt-3', { wake: true, to: ['su-B'] }), // no receipt flag
        },
        { authorPubkey: 'peerPubA', origin: 'remote' },
      );
      await p.writeToPg(receiptRow('rcpt-4'), { authorPubkey: 'peerPubA', origin: 'local' });
      expect(sendMessage).not.toHaveBeenCalled();
    });

    it('a budget-suppressed wake still delivers + receipts with woken:0 (truthful)', async () => {
      process.env.PAPERCUSP_FED_WAKE_MAX_PER_HOUR = '1';
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const p = proj();
        await p.writeToPg(receiptRow('rcpt-5'), { authorPubkey: 'spender', origin: 'remote' });
        await p.writeToPg(receiptRow('rcpt-6'), { authorPubkey: 'spender', origin: 'remote' });
        expect(sendMessage).toHaveBeenCalledTimes(2);
        const second = vi.mocked(sendMessage).mock.calls[1][1] as {
          extra?: { fed_event?: { payload: Record<string, unknown> } };
        };
        expect(second.extra?.fed_event?.payload).toMatchObject({ delivered: true, woken: 0 });
      } finally {
        warnSpy.mockRestore();
        delete process.env.PAPERCUSP_FED_WAKE_MAX_PER_HOUR;
      }
    });
  });

  describe('P-013/P-014 — comms-tier enforcement (hive-bound projections only)', () => {
    beforeEach(() => {
      resetFederatedWakeRate();
      vi.mocked(wakeRecipients).mockClear();
      vi.mocked(emitAwaitedEvent).mockClear();
      vi.mocked(sendMessage).mockClear();
    });
    const tierProj = (tier: 'observe' | 'message' | 'wake' | 'steer') =>
      buildCoordMessageProjection({
        workspaceId: WS,
        harnessSlug: HARNESS,
        sql: db.sql,
        hiveHomeSlug: HARNESS, // hive-bound ⇒ enforcement active
        resolveCommsTier: async () => ({ tier, githubUserId: 4242 }),
      });
    const wakeRow = (msgId: string, extra: Record<string, unknown> = {}): CoordMessageRow => ({
      harness_slug: HARNESS,
      msg_id: msgId,
      surface: 'messages',
      writer_key: 'peer-A',
      body: envelope(msgId, { wake: true, summary: 'hi', to: ['su-B'], ...extra }),
      ts: 1_700_000_000_000,
    });
    async function applied(msgId: string): Promise<boolean> {
      const r = await db.sql`SELECT 1 FROM harness_shared.coord_event_log WHERE workspace_id=${WS} AND msg_id=${msgId}`;
      return r.length > 0;
    }
    async function quarantined(msgId: string) {
      const r = await db.sql<{ reason: string; author_github_user_id: string | number | null }[]>`
        SELECT reason, author_github_user_id FROM harness_shared.coord_quarantine WHERE workspace_id=${WS} AND msg_id=${msgId}`;
      return r[0] ?? null;
    }

    it("below 'message' (observe): the row NEVER applies — QUARANTINED with the verified author", async () => {
      await tierProj('observe').writeToPg(wakeRow('q-1'), { authorPubkey: 'peerPubA', origin: 'remote' });
      expect(await applied('q-1')).toBe(false);
      const q = await quarantined('q-1');
      expect(q?.reason).toBe('below-message-tier');
      expect(Number(q?.author_github_user_id)).toBe(4242);
      expect(wakeRecipients).not.toHaveBeenCalled();
    });

    it("at 'message': the row APPLIES but no fan, no reply-wake, no fed-event re-fire (attention, not spend)", async () => {
      // seed an opted-in original so the reply-wake WOULD fire if allowed
      await insertRow({ msgId: 'q-orig', body: envelope('q-orig', { from: 'su-LOCAL', to: ['su-A'], wakeOnReply: true }) });
      const p = tierProj('message');
      await p.writeToPg(
        wakeRow('q-2', { related_msg_id: 'q-orig', fed_event: { key: 'k-q2', source: 'su-A' } }),
        { authorPubkey: 'peerPubA', origin: 'remote' },
      );
      expect(await applied('q-2')).toBe(true);
      expect(await quarantined('q-2')).toBeNull();
      expect(wakeRecipients).not.toHaveBeenCalled();
      expect(emitAwaitedEvent).not.toHaveBeenCalled();
    });

    it("at 'wake': the fan fires as usual", async () => {
      await tierProj('wake').writeToPg(wakeRow('q-3'), { authorPubkey: 'peerPubA', origin: 'remote' });
      expect(await applied('q-3')).toBe(true);
      expect(wakeRecipients).toHaveBeenCalledTimes(1);
    });

    it("a HANDOFF below 'steer' is quarantined even from a wake-tier author", async () => {
      const handoff: CoordMessageRow = {
        ...wakeRow('q-4'),
        surface: 'handoffs',
        body: envelope('q-4', { kind: 'handoff', to: ['su-B'] }),
      };
      await tierProj('wake').writeToPg(handoff, { authorPubkey: 'peerPubA', origin: 'remote' });
      expect(await applied('q-4')).toBe(false);
      expect((await quarantined('q-4'))?.reason).toBe('handoff-below-steer');
    });

    it('P-014: a quarantined receipt-requesting message acks delivered:false + quarantined:true', async () => {
      await tierProj('observe').writeToPg(
        wakeRow('q-5', { receipt: true }),
        { authorPubkey: 'peerPubA', origin: 'remote' },
      );
      expect(sendMessage).toHaveBeenCalledTimes(1);
      const opts2 = vi.mocked(sendMessage).mock.calls[0][1] as {
        extra?: { fed_event?: { key: string; payload: Record<string, unknown> } };
      };
      expect(opts2.extra?.fed_event?.key).toBe('coord:receipt:q-5');
      expect(opts2.extra?.fed_event?.payload).toMatchObject({
        delivered: false,
        quarantined: true,
        reason: 'below-message-tier',
      });
    });

    it("'steer' passthrough + NON-hive-bound projections stay byte-identical (no gate)", async () => {
      await tierProj('steer').writeToPg(wakeRow('q-6'), { authorPubkey: 'peerPubA', origin: 'remote' });
      expect(await applied('q-6')).toBe(true);
      expect(wakeRecipients).toHaveBeenCalledTimes(1);
      // non-hive-bound (no hiveHomeSlug): even an 'observe' resolver is never consulted
      const resolver = vi.fn(async () => ({ tier: 'observe' as const, githubUserId: 1 }));
      const plain = buildCoordMessageProjection({
        workspaceId: WS, harnessSlug: HARNESS, sql: db.sql, resolveCommsTier: resolver,
      });
      await plain.writeToPg(wakeRow('q-7'), { authorPubkey: 'peerPubA', origin: 'remote' });
      expect(await applied('q-7')).toBe(true);
      expect(resolver).not.toHaveBeenCalled();
    });
  });

});
