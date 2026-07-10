/**
 * federation-probe-store — REAL-PG regression guard (WI-3812, P-010).
 *
 * Applies the real migration 544 and pins:
 *   1. insertProbe writes with `captured` already stamped, status 'pending';
 *   2. a probe_key collision is a loud InvalidInputError, never a silent
 *      overwrite of a DIFFERENT probe's receipts;
 *   3. recordProbeHop is idempotent (COALESCE — never moves a landed hop
 *      backwards) and refuses to stamp a hop on a non-pending (terminal) row;
 *   4. insertRefusedProbe + getProbe/listRecentProbes round-trip correctly.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFreshPgDb, applyMigrationForTest, type FreshPgDb } from '../../../test/_pg-helpers';
import {
  insertProbe,
  insertRefusedProbe,
  recordProbeHop,
  markProbeAcked,
  markProbeTimedOut,
  getProbe,
  listRecentProbes,
} from './federation-probe-store';
import { stampProbe } from './federation-probe';

const SQL_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../../../libs/papercusp/libs/db/sql');

let db: FreshPgDb;

beforeAll(async () => {
  db = await createFreshPgDb('federation-probe-store');
  await applyMigrationForTest(db.sql, join(SQL_DIR, '544-federation-probes.sql'));
});
afterAll(async () => {
  await db?.cleanup();
});
afterEach(async () => {
  await db.sql.unsafe('TRUNCATE harness_shared.federation_probes');
});

function stamp(overrides: Partial<Parameters<typeof stampProbe>[0]> = {}) {
  const result = stampProbe({
    workspaceId: 'ws-int',
    harnessSlug: 'papercusp',
    emittedBy: 'su-int-test',
    harnessIsFederated: true,
    nowMs: Date.now(),
    ...overrides,
  });
  if (!result.ok) throw new Error(`unexpected refusal in test setup: ${result.reason}`);
  return result.stamped;
}

describe('insertProbe against the real 544 schema', () => {
  it('inserts with captured already stamped and status pending', async () => {
    const receipt = await insertProbe(stamp(), db.sql);
    expect(receipt.status).toBe('pending');
    expect(typeof receipt.hops.captured).toBe('number');
    expect(receipt.hops.drained).toBeUndefined();
  });

  it('refuses a probe_key collision loudly instead of silently overwriting', async () => {
    const stamped = stamp();
    await insertProbe(stamped, db.sql);
    await expect(insertProbe(stamped, db.sql)).rejects.toThrow(/already exists \(collision\)/);
  });

  it('round-trips via getProbe', async () => {
    const stamped = stamp();
    await insertProbe(stamped, db.sql);
    const got = await getProbe(stamped.probeKey, db.sql);
    expect(got?.probeKey).toBe(stamped.probeKey);
    expect(got?.harnessSlug).toBe('papercusp');
  });

  it('listRecentProbes scopes by workspace+harness, newest first', async () => {
    const a = stamp({ nowMs: 1000 });
    const b = stamp({ nowMs: 2000 });
    await insertProbe(a, db.sql);
    await insertProbe(b, db.sql);
    const list = await listRecentProbes('ws-int', 'papercusp', 10, db.sql);
    expect(list.map((r) => r.probeKey)).toEqual([b.probeKey, a.probeKey]);
  });
});

describe('insertRefusedProbe', () => {
  it('persists a refused probe with a null captured hop', async () => {
    await insertRefusedProbe(
      {
        workspaceId: 'ws-int',
        harnessSlug: 'papercusp',
        emittedBy: 'su-int-test',
        probeKey: 'papercusp:v2t:refused-1',
        reason: 'harness_not_federated',
        nowMs: Date.now(),
      },
      db.sql,
    );
    const got = await getProbe('papercusp:v2t:refused-1', db.sql);
    expect(got?.status).toBe('refused');
    expect(got?.refusalReason).toBe('harness_not_federated');
    expect(got?.hops.captured).toBeUndefined();
  });
});

describe('recordProbeHop', () => {
  it('stamps a new hop and returns the updated receipt', async () => {
    const stamped = stamp();
    await insertProbe(stamped, db.sql);
    const updated = await recordProbeHop(stamped.probeKey, 'drained', Date.now(), 'drain observed', db.sql);
    expect(updated?.hops.drained).toBeTypeOf('number');
  });

  it('is idempotent — a later call never moves an already-landed hop backwards', async () => {
    const stamped = stamp();
    await insertProbe(stamped, db.sql);
    const first = await recordProbeHop(stamped.probeKey, 'drained', 5_000_000, undefined, db.sql);
    const second = await recordProbeHop(stamped.probeKey, 'drained', 9_999_999, undefined, db.sql);
    expect(first?.hops.drained).toBe(second?.hops.drained);
  });

  it('refuses to stamp a hop on a non-pending (terminal) row', async () => {
    const stamped = stamp();
    await insertProbe(stamped, db.sql);
    await markProbeTimedOut(stamped.probeKey, db.sql);
    const result = await recordProbeHop(stamped.probeKey, 'drained', Date.now(), undefined, db.sql);
    expect(result).toBeNull();
  });

  it('returns null for an unknown probeKey', async () => {
    const result = await recordProbeHop('no-such-probe', 'drained', Date.now(), undefined, db.sql);
    expect(result).toBeNull();
  });
});

describe('markProbeAcked / markProbeTimedOut', () => {
  it('flips status from pending to acked', async () => {
    const stamped = stamp();
    await insertProbe(stamped, db.sql);
    await markProbeAcked(stamped.probeKey, db.sql);
    const got = await getProbe(stamped.probeKey, db.sql);
    expect(got?.status).toBe('acked');
  });

  it('flips status from pending to timed_out', async () => {
    const stamped = stamp();
    await insertProbe(stamped, db.sql);
    await markProbeTimedOut(stamped.probeKey, db.sql);
    const got = await getProbe(stamped.probeKey, db.sql);
    expect(got?.status).toBe('timed_out');
  });
});
