import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { applyMigrationForTest, createFreshPgDb, type FreshPgDb } from '../../../../test/_pg-helpers';
import {
  createMergeCursor, createPgMergeCursorSeedCache, mergeAdmittedLogsIncremental,
  persistCursor, seedCursorFromPg, seedCursorFromSnapshots,
  type AdmittedLog, type MergeApplyFailure, type MergeCursor,
} from '../read-merge';
import { createPgMergeCursorStore } from '../pg-merge-cursor-store';
import type { OpEnvelope } from '../op-envelope-types';
import type { PeerLogOp } from '../peer-log';

function migrationPath(name: string): string {
  const path = fileURLToPath(new URL(`../../../../../../libs/papercusp/libs/db/sql/${name}`, import.meta.url));
  return existsSync(path) ? path : `${path}.DRAFT`;
}
function put(id: string, ts = 1): PeerLogOp {
  return { type: 'put', table: 'features-by-id', hbKey: id, value: { id }, ts, schema_version: 1, author_pubkey: 'pk' };
}
function log(keyHex: string, ops: PeerLogOp[]): AdmittedLog {
  return { keyHex, length: ops.length, get: async (i) => ops[i] ?? null };
}

describe('P-515 durable unapplied entry recovery', () => {
  let db: FreshPgDb;
  let sql: postgres.Sql;
  beforeAll(async () => {
    db = await createFreshPgDb('merge-apply-failure');
    sql = db.sql;
    for (const name of [
      '493-substrate-merge-cursor.sql', '685-substrate-merge-cursor-apply-binding.sql',
      '1122-substrate-merge-cursor-apply-failure.sql', '1122-substrate-merge-cursor-apply-failure.sql',
    ]) await applyMigrationForTest(sql, migrationPath(name));
    await sql`CREATE TABLE materialized (id text PRIMARY KEY, version bigint NOT NULL)`;
  }, 180_000);
  afterAll(async () => { await db?.cleanup(); });
  afterEach(() => vi.restoreAllMocks());

  const apply = async (op: OpEnvelope): Promise<boolean> => {
    const rows = await sql`
      INSERT INTO materialized (id, version) VALUES (${op.hbKey!}, ${op.ts!})
      ON CONFLICT (id) DO UPDATE SET version = EXCLUDED.version
      WHERE materialized.version < EXCLUDED.version RETURNING id
    `;
    return rows.length > 0;
  };

  it('retains outage failures past the old budget, survives consumer restart, and replays idempotently', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const alert = vi.spyOn(console, 'error').mockImplementation(() => {});
    const store = createPgMergeCursorStore('w', 'outage', () => sql);
    const cursor = createMergeCursor();
    const source = log('source', [put('outage-row'), put('after-outage', 2)]);
    const persist = (c: MergeCursor) => persistCursor(c.positions, store, 'home', c.applyFailures ?? new Map());
    const unavailable = async (): Promise<boolean> => { throw Object.assign(new Error('database unavailable'), { code: '08006' }); };
    for (let i = 0; i < 6; i++) {
      const result = await mergeAdmittedLogsIncremental([source], cursor, {
        applyImpl: unavailable, getTimeoutMs: 0, onCursorAdvance: () => persist(cursor),
      });
      expect(result.caughtUp).toBe(false);
    }
    expect((await store.load('home')).get('source')).toBe(0);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(alert).toHaveBeenCalledWith(expect.stringContaining('UNAPPLIED BACKLOG'), 'database unavailable');
    expect((await store.loadApplyFailures!('home')).get('source')).toMatchObject({
      position: 0, kind: 'retryable', errorCode: '08006', attempts: 6,
    });
    expect(await store.loadApplyFailures!('another-home')).toEqual(new Map());

    const restarted = createMergeCursor();
    await seedCursorFromPg(restarted, store, 'home');
    expect(restarted.positions.has('source')).toBe(true); // ZERO is an explicit hold.
    const read = vi.fn(source.get);
    await seedCursorFromSnapshots([{ ...source, get: read }], restarted);
    expect(read).not.toHaveBeenCalled(); // a later snapshot cannot hide the failure.
    const result = await mergeAdmittedLogsIncremental([source], restarted, {
      applyImpl: apply, getTimeoutMs: 0, onCursorAdvance: () => persist(restarted),
    });
    expect(result).toMatchObject({ applied: 2, caughtUp: true });
    expect(await store.loadApplyFailures!('home')).toEqual(new Map());
    expect((await store.load('home')).get('source')).toBe(2);
    const replay = await mergeAdmittedLogsIncremental([source], createMergeCursor(), { applyImpl: apply, getTimeoutMs: 0 });
    expect(replay).toMatchObject({ applied: 0, caughtUp: true });
    expect(await sql`SELECT id FROM materialized WHERE id IN ('outage-row', 'after-outage')`).toHaveLength(2);
  });

  it('a failed cursor save cannot skip an unapplied operation after restart', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = createPgMergeCursorStore('w', 'persist-outage', () => sql);
    await store.save(new Map([['source', 0]]), null, new Map());
    const cursor = createMergeCursor();
    const source = log('source', [put('persist-recovery')]);
    await mergeAdmittedLogsIncremental([source], cursor, {
      applyImpl: async () => { throw new Error('connection lost'); }, getTimeoutMs: 0,
      onCursorAdvance: async () => { throw new Error('cursor database unavailable too'); },
    });
    const restarted = createMergeCursor();
    await seedCursorFromPg(restarted, store, null);
    expect(restarted.positions.get('source')).toBe(0);
    const read = vi.fn(source.get);
    await seedCursorFromSnapshots([{ ...source, get: read }], restarted);
    expect(read).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('cursor HELD'), 'connection lost');
    expect(await mergeAdmittedLogsIncremental([source], restarted, { applyImpl: apply, getTimeoutMs: 0 }))
      .toMatchObject({ applied: 1, caughtUp: true });
  });

  it('a failed durable seed prevents snapshot skipping for present and later-admitted logs', async () => {
    const seed = createPgMergeCursorSeedCache();
    const store = createPgMergeCursorStore('w', 'failed-load', () => { throw new Error('database unavailable'); });
    const cursor = createMergeCursor();
    await expect(seed.seed(cursor, store, null, ['first'])).rejects.toThrow('database unavailable');
    await seed.seed(cursor, store, null, ['first', 'later']);
    expect([...cursor.positions]).toEqual([['first', 0], ['later', 0]]);
  });

  it('SQL refuses a cursor advance past an unresolved dead letter', async () => {
    const store = createPgMergeCursorStore('w', 'rejected', () => sql);
    const failure: MergeApplyFailure = {
      position: 0, groupKey: 'features-by-id::bad', kind: 'rejected', reason: 'invalid schema',
      attempts: 1, firstSeenAt: 1, lastSeenAt: 1,
    };
    await store.save(new Map([['source', 0]]), null, new Map([['source', failure]]));
    expect((await store.loadApplyFailures!(null)).get('source')).toEqual(failure);
    // An old caller omitting the failure argument cannot erase the dead letter.
    await expect(store.save(new Map([['source', 1]]), null)).rejects.toThrow(/apply_failure_check/);
    expect((await store.load(null)).get('source')).toBe(0);
    await store.save(new Map([['source', 1]]), null, new Map());
    expect(await store.loadApplyFailures!(null)).toEqual(new Map());
  });

  it('a real FK dependency can arrive later in the same pass and the child replays after restart', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await sql`CREATE TABLE parent_rows (id text PRIMARY KEY)`;
    await sql`CREATE TABLE child_rows (id text PRIMARY KEY, parent text REFERENCES parent_rows(id))`;
    const store = createPgMergeCursorStore('w', 'fk', () => sql);
    const source = log('source', [put('child'), put('parent', 2)]);
    const applyDependency = async (op: OpEnvelope): Promise<boolean> => {
      if (op.hbKey === 'child') await sql`INSERT INTO child_rows VALUES ('child', 'parent') ON CONFLICT DO NOTHING`;
      else await sql`INSERT INTO parent_rows VALUES ('parent') ON CONFLICT DO NOTHING`;
      return true;
    };
    const cursor = createMergeCursor();
    const first = await mergeAdmittedLogsIncremental([source], cursor, {
      applyImpl: applyDependency, getTimeoutMs: 0,
      onCursorAdvance: () => persistCursor(cursor.positions, store, null, cursor.applyFailures),
    });
    expect(first).toMatchObject({ applied: 1, caughtUp: false });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('structural apply deferral'), expect.stringContaining('foreign key'));
    expect((await store.loadApplyFailures!(null)).get('source')).toMatchObject({ kind: 'dependency-waiting', position: 0 });
    const restarted = createMergeCursor();
    await createPgMergeCursorSeedCache().seed(restarted, store, null, ['source']);
    expect((await mergeAdmittedLogsIncremental([source], restarted, { applyImpl: applyDependency, getTimeoutMs: 0 })).caughtUp).toBe(true);
    expect(await sql`SELECT id FROM child_rows`).toEqual([{ id: 'child' }]);
  });
});
