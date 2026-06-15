/**
 * dispatch-ledger.integration.test.ts — the PG half of the dispatch ledger
 * (consume-edges P-010 / B-04) against a real migrated Postgres: migration 238
 * applies, the fire-time insert / fire-result / resolve-close / orphan writes
 * round-trip, and the EI-365 failure shapes (fire failure, silent worker death)
 * are distinguishable from a worker in progress. The pure stats rollup is
 * dispatch-ledger.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { teardownTestPg } from '@papercusp/test-config';
import { createOrgTestDb, type OrgTestDb } from '../../../test/_org-test-db';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async () => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...actual, getOrgPg: () => ({ sql: h.sql }) };
});

import {
  closeDispatchesForItem,
  computeDispatchStats,
  markDispatchOrphaned,
  readRecentDispatches,
  recordDispatchFired,
  recordFireResult,
} from './dispatch-ledger';

const WS = 'ws-ledger';
let db: OrgTestDb;

beforeAll(async () => {
  db = await createOrgTestDb();
  h.sql = db.adminSql;
}, 180_000);

afterAll(async () => {
  await db?.cleanup();
  if (!process.env.KEEP_TEST_PG) await teardownTestPg();
});

const fire = (itemId: string, attempt = 1) =>
  recordDispatchFired({ workspaceId: WS, itemId, attempt, runnerHarness: 'runner-h' });

describe('improvement_dispatches write path (migration 238)', () => {
  it('(P-012, migration 289) stamps hive_slug on the dispatch row when provided; NULL when omitted', async () => {
    const id = await recordDispatchFired({
      workspaceId: WS,
      itemId: 'EI-HIVE',
      attempt: 1,
      runnerHarness: 'runner-h',
      hiveSlug: 'acme-hive',
    });
    expect(id).toBeTruthy();
    const [r] = await h.sql<{ hive_slug: string | null }[]>`
      SELECT hive_slug FROM harness_shared.improvement_dispatches WHERE id = ${id}`;
    expect(r?.hive_slug).toBe('acme-hive');

    const id2 = await recordDispatchFired({ workspaceId: WS, itemId: 'EI-NOHIVE', attempt: 1, runnerHarness: 'runner-h' });
    const [r2] = await h.sql<{ hive_slug: string | null }[]>`
      SELECT hive_slug FROM harness_shared.improvement_dispatches WHERE id = ${id2}`;
    expect(r2?.hive_slug).toBeNull();
  });

  it('fire-time insert → a pending row with the dispatch identity; ok-result records the spawn correlation', async () => {
    const id = await fire('EI-100', 2);
    expect(id).toBeTruthy();

    let [row] = await readRecentDispatches(WS, { limit: 5 });
    expect(row).toMatchObject({
      id,
      itemId: 'EI-100',
      attempt: 2,
      runnerHarness: 'runner-h',
      fireResult: 'pending',
      spawnedRunId: null,
      outcome: null,
      resolvedAt: null,
    });

    await recordFireResult(id as string, { ok: true, spawnedRunId: 'launch-1749-abc123' });
    [row] = await readRecentDispatches(WS, { limit: 5 });
    expect(row).toMatchObject({ fireResult: 'ok', spawnedRunId: 'launch-1749-abc123', outcome: null });
  });

  it('a FAILED fire is terminal immediately — distinguishable from a worker in progress', async () => {
    const id = await fire('EI-101');
    await recordFireResult(id as string, { ok: false, error: 'invoke route down' });

    const row = (await readRecentDispatches(WS)).find((r) => r.id === id);
    expect(row).toMatchObject({
      fireResult: 'error',
      fireError: 'invoke route down',
      outcome: 'fire-failed',
      resolvedBy: 'system',
    });
    expect(row?.resolvedAt).toBeTruthy();
  });

  it('the resolve back-edge closes ALL open rows for the item — and only that item', async () => {
    const a1 = await fire('EI-102', 1);
    const a2 = await fire('EI-102', 2); // re-dispatch left an older open row
    const other = await fire('EI-103', 1);

    const closed = await closeDispatchesForItem('EI-102', { outcome: 'fixed', by: 'worker-7' });
    expect(closed).toBe(2);

    const rows = await readRecentDispatches(WS);
    for (const id of [a1, a2]) {
      expect(rows.find((r) => r.id === id)).toMatchObject({ outcome: 'fixed', resolvedBy: 'worker-7' });
    }
    expect(rows.find((r) => r.id === other)).toMatchObject({ outcome: null });

    // Idempotent second resolve: nothing left open to close.
    expect(await closeDispatchesForItem('EI-102', { outcome: 'fixed' })).toBe(0);
  });

  it('markDispatchOrphaned takes an OPEN row exactly once — a late resolve cannot double-close it', async () => {
    const id = await fire('EI-104');
    expect(await markDispatchOrphaned(id as string)).toBe(true);
    expect(await markDispatchOrphaned(id as string)).toBe(false); // already terminal
    const row = (await readRecentDispatches(WS)).find((r) => r.id === id);
    expect(row).toMatchObject({ outcome: 'orphaned', resolvedBy: 'orphaned-dispatch-collector' });
  });

  it('SILENT WORKER DEATH is visible: an old open row rolls up as overdue, not in-progress', async () => {
    const id = await fire('EI-105');
    await recordFireResult(id as string, { ok: true, spawnedRunId: null });
    // Backdate the fire 3h — past the 2h default overdue threshold.
    await db.adminSql`
      UPDATE harness_shared.improvement_dispatches
         SET fired_at = now() - interval '3 hours'
       WHERE id = ${id as string}`;

    const stats = computeDispatchStats(await readRecentDispatches(WS));
    expect(stats.overdue).toBeGreaterThanOrEqual(1);
    const row = (await readRecentDispatches(WS)).find((r) => r.id === id);
    expect(row).toMatchObject({ outcome: null }); // still open — terminal is the collector's job (P-011)
  });

  it('reads are workspace-scoped', async () => {
    await recordDispatchFired({ workspaceId: 'ws-other', itemId: 'EI-900', attempt: 1, runnerHarness: null });
    const rows = await readRecentDispatches(WS);
    expect(rows.some((r) => r.itemId === 'EI-900')).toBe(false);
    expect(rows.every((r) => r.workspaceId === WS)).toBe(true);
  });
});
