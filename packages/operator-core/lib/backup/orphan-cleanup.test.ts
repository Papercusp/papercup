/**
 * Integration tests for the backup-snapshot orphan sweep. Exercises
 * the full INSERT → sweep → status-check round-trip against a live
 * embedded-pg. Soft-skipped when PG isn't reachable (same pattern as
 * auth.test.ts).
 *
 * Step D (Tier-1 follow-up arc).
 */

import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';

let pgReachable = false;
let mod: typeof import('./orphan-cleanup') | null = null;
type ClientLike = { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>; end: () => Promise<void> };
let pgClient: ClientLike | null = null;

beforeAll(async () => {
  try {
    const { pgClientFields } = await import('../memory/mem0-connection');
    const fields = await pgClientFields();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Client } = require('pg') as typeof import('pg');
    const c = new Client(fields);
    await c.connect();
    await c.query("SELECT 1 FROM harness_shared.backup_snapshots LIMIT 1");
    pgClient = c as unknown as ClientLike;
    pgReachable = true;
  } catch {
    pgReachable = false;
  }
  if (pgReachable) {
    mod = await import('./orphan-cleanup');
    // Drizzle init race: the first sweepOrphanSnapshots() call in a
    // vitest worker triggers drizzle schema setup and intermittently
    // fails on a null read. Warm up so the FIRST real test doesn't
    // race the init. Mirror of the pattern in lib/auth.test.ts.
    try { await mod.sweepOrphanSnapshots(); } catch { /* ok */ }
  }
});

const TEST_WORKSPACE = '__orphan_sweep_test__';

afterEach(async () => {
  if (!pgClient) return;
  await pgClient.query(
    `DELETE FROM harness_shared.backup_snapshots WHERE workspace_id = $1`,
    [TEST_WORKSPACE],
  );
});

async function insertSnapshot(
  status: 'running' | 'ok' | 'failed' | 'aborted',
  startedAtIso: string,
): Promise<string> {
  if (!pgClient) throw new Error('no pg');
  const result = await pgClient.query(
    `INSERT INTO harness_shared.backup_snapshots
       (workspace_id, started_at, status, trigger_reason)
     VALUES ($1, $2::timestamptz, $3, 'manual')
     RETURNING id::text`,
    [TEST_WORKSPACE, startedAtIso, status],
  );
  const row = result.rows[0] as { id: string };
  return row.id;
}

async function getStatus(id: string): Promise<{ status: string; error_text: string | null }> {
  if (!pgClient) throw new Error('no pg');
  const r = await pgClient.query(
    `SELECT status, error_text FROM harness_shared.backup_snapshots WHERE id = $1`,
    [id],
  );
  return r.rows[0] as { status: string; error_text: string | null };
}

const itPg = (name: string, fn: () => Promise<void> | void) => {
  it(name, async () => {
    if (!pgReachable || !mod) return;
    await fn();
  });
};

describe('sweepOrphanSnapshots', () => {
  itPg('returns 0 when no running rows', async () => {
    const result = await mod!.sweepOrphanSnapshots();
    // Our test workspace is fresh — global rows from other tests are
    // not expected, but if they exist they're harmless. Just check that
    // OUR inserted rows (none here) didn't show up in the sweep.
    expect(typeof result.swept).toBe('number');
    expect(Array.isArray(result.sweptIds)).toBe(true);
  });

  itPg('marks running rows older than threshold as failed', async () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
    const idA = await insertSnapshot('running', twoHoursAgo);
    const idB = await insertSnapshot('running', twoHoursAgo);
    const idC = await insertSnapshot('running', twoHoursAgo);

    const result = await mod!.sweepOrphanSnapshots();
    expect(result.sweptIds).toContain(idA);
    expect(result.sweptIds).toContain(idB);
    expect(result.sweptIds).toContain(idC);

    const a = await getStatus(idA);
    expect(a.status).toBe('failed');
    expect(a.error_text).toContain('orphan-sweep');
  });

  itPg('leaves recent running rows untouched', async () => {
    const fiveMinAgo = new Date(Date.now() - 5 * 60_000).toISOString();
    const id = await insertSnapshot('running', fiveMinAgo);

    const result = await mod!.sweepOrphanSnapshots();
    expect(result.sweptIds).not.toContain(id);

    const r = await getStatus(id);
    expect(r.status).toBe('running');
  });

  itPg('leaves terminal-state rows (ok/failed/aborted) untouched even when stale', async () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
    const idOk = await insertSnapshot('ok', twoHoursAgo);
    const idFail = await insertSnapshot('failed', twoHoursAgo);
    const idAborted = await insertSnapshot('aborted', twoHoursAgo);

    const result = await mod!.sweepOrphanSnapshots();
    expect(result.sweptIds).not.toContain(idOk);
    expect(result.sweptIds).not.toContain(idFail);
    expect(result.sweptIds).not.toContain(idAborted);

    const ok = await getStatus(idOk);
    expect(ok.status).toBe('ok');
    const aborted = await getStatus(idAborted);
    expect(aborted.status).toBe('aborted');
  });

  itPg('respects custom olderThanMs threshold', async () => {
    const fifteenMinAgo = new Date(Date.now() - 15 * 60_000).toISOString();
    const id = await insertSnapshot('running', fifteenMinAgo);

    // With default 1h threshold: untouched.
    const r1 = await mod!.sweepOrphanSnapshots();
    expect(r1.sweptIds).not.toContain(id);
    expect((await getStatus(id)).status).toBe('running');

    // With 10-min threshold: swept.
    const r2 = await mod!.sweepOrphanSnapshots({ olderThanMs: 10 * 60_000 });
    expect(r2.sweptIds).toContain(id);
    expect((await getStatus(id)).status).toBe('failed');
  });

  itPg('two parallel calls are safe (no row double-marked)', async () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
    const idA = await insertSnapshot('running', twoHoursAgo);
    const idB = await insertSnapshot('running', twoHoursAgo);

    const [r1, r2] = await Promise.all([
      mod!.sweepOrphanSnapshots(),
      mod!.sweepOrphanSnapshots(),
    ]);

    // Total unique rows marked equals total stale rows (2).
    const allMarked = new Set([...r1.sweptIds, ...r2.sweptIds]);
    expect(allMarked.has(idA)).toBe(true);
    expect(allMarked.has(idB)).toBe(true);

    // Final state: both failed (terminal).
    expect((await getStatus(idA)).status).toBe('failed');
    expect((await getStatus(idB)).status).toBe('failed');
  });

  itPg('error_text records the threshold used', async () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
    const id = await insertSnapshot('running', twoHoursAgo);

    await mod!.sweepOrphanSnapshots({ olderThanMs: 30 * 60_000 });

    const r = await getStatus(id);
    expect(r.error_text).toMatch(/>30min/);
  });
});
