/**
 * receipt-gc.integration.test.ts — gcGovernorReceipts (WI-924391) against real Postgres.
 *
 * WHY AN INTEGRATION TEST: the whole GC is one SQL predicate. A fake-sql unit test
 * would assert that we built the string we built, which is not evidence about
 * anything. The properties below are exactly the ones a fake cannot prove.
 *
 * THE CONTROLS ARE THE POINT, not padding. A GC that deleted EVERY row would pass a
 * subject-only assertion ("the old terminal receipt is gone") perfectly. Three cases
 * here exist to make that impossible:
 *   - a NON-RECEIPT work-item survives      (the discriminator works at all)
 *   - an ACTIVE receipt survives            (live admission state is never aged out)
 *   - a RECENT terminal receipt survives    (the age cutoff is real)
 * If a future edit breaks the predicate into "delete everything", at least one of
 * those fails. That is the difference between a test and a decoration.
 *
 * FIXTURE NOTE: this hand-rolls a minimal harness_shared.work_items (the four columns
 * the GC touches + its PK) rather than applying real migrations, matching
 * operator-turns-gc.integration.test.ts. That is deliberate but NOT free: a migration
 * adding a NOT NULL column to work_items will not strand this file (we insert an
 * explicit column list), but a migration that changes the RECEIPT DISCRIMINATOR or the
 * governor state vocabulary would leave this test passing against a shape the
 * production table no longer has. If you change either, change this fixture with it.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import { getTestPg } from '@papercusp/test-config/pg';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql }) };
});

const { gcGovernorReceipts, GOVERNOR_RECEIPT_RETENTION_HOURS } = await import('./receipt-gc');

let rootSql: postgres.Sql;

const NOW = 1_800_000_000_000; // fixed epoch ms so every cutoff is deterministic
const HOUR = 60 * 60 * 1000;

beforeAll(async () => {
  const adminUri = await getTestPg();
  const dbName = `grgc_${randomBytes(5).toString('hex')}`;
  const admin = postgres(adminUri, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
  } finally {
    await admin.end({ timeout: 5 });
  }
  const u = new URL(adminUri);
  u.pathname = `/${dbName}`;
  rootSql = postgres(u.toString(), { max: 1, onnotice: () => {} });
  await rootSql.unsafe(`CREATE SCHEMA harness_shared`);
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.work_items (
      harness_slug text NOT NULL,
      feature_id   text NOT NULL,
      payload      jsonb,
      created_ts   bigint NOT NULL,
      PRIMARY KEY (harness_slug, feature_id)
    )`);
  h.sql = rootSql;
});

afterAll(async () => {
  await rootSql?.end({ timeout: 5 });
});

/** Insert a governor receipt in `state`, aged `ageHours` before NOW. */
async function receipt(id: string, state: string, ageHours: number): Promise<void> {
  await rootSql`
    INSERT INTO harness_shared.work_items (harness_slug, feature_id, payload, created_ts)
    VALUES ('papercusp', ${id},
            ${rootSql.json({ resource_governor: { state, namespace: 'agent-process' } })},
            ${NOW - ageHours * HOUR})`;
}

/** Insert a NON-receipt work-item (no resource_governor key) aged `ageHours`. */
async function realWorkItem(id: string, ageHours: number): Promise<void> {
  await rootSql`
    INSERT INTO harness_shared.work_items (harness_slug, feature_id, payload, created_ts)
    VALUES ('papercusp', ${id}, ${rootSql.json({ _ei: { severity: 'major' } })},
            ${NOW - ageHours * HOUR})`;
}

async function surviving(): Promise<string[]> {
  const rows = await rootSql<Array<{ feature_id: string }>>`
    SELECT feature_id FROM harness_shared.work_items ORDER BY feature_id`;
  return rows.map((r) => r.feature_id);
}

beforeEach(async () => {
  await rootSql`TRUNCATE harness_shared.work_items`;
});

describe('gcGovernorReceipts', () => {
  it('deletes ONLY aged terminal receipts, and returns the count', async () => {
    await receipt('WI-OLD-COMPLETED', 'completed', 10);
    await receipt('WI-OLD-CANCELLED', 'cancelled', 10);
    await receipt('WI-OLD-EXPIRED', 'expired', 10);
    await receipt('WI-OLD-SUPERSEDED', 'superseded', 10);

    // --- CONTROLS: each of these must SURVIVE, or the predicate is indiscriminate.
    await realWorkItem('WI-REAL-ANCIENT', 10_000); // real work, far past any horizon
    await receipt('WI-OLD-RUNNING', 'running', 10); // live admission state
    await receipt('WI-OLD-LEASED', 'leased', 10);
    await receipt('WI-OLD-QUEUED', 'queued', 10);
    await receipt('WI-OLD-ELIGIBLE', 'eligible', 10);
    await receipt('WI-NEW-COMPLETED', 'completed', 0); // terminal but inside the window

    const deleted = await gcGovernorReceipts({ nowMs: NOW });

    expect(deleted).toBe(4);
    expect(await surviving()).toEqual([
      'WI-NEW-COMPLETED',
      'WI-OLD-ELIGIBLE',
      'WI-OLD-LEASED',
      'WI-OLD-QUEUED',
      'WI-OLD-RUNNING',
      'WI-REAL-ANCIENT',
    ]);
  });

  it('CONTROL: a real work-item is never touched even when every receipt is swept', async () => {
    // Calibration: proves the discriminator, not just the age cutoff. If this ever
    // fails, the GC is deleting by age alone and would eat the work-item ledger.
    await realWorkItem('WI-REAL-OLD', 10_000);
    await receipt('WI-RECEIPT-OLD', 'completed', 10_000);

    expect(await gcGovernorReceipts({ nowMs: NOW })).toBe(1);
    expect(await surviving()).toEqual(['WI-REAL-OLD']);
  });

  it('CONTROL: an ACTIVE receipt is never aged out, however old', async () => {
    // Deleting a leased/running receipt destroys LIVE admission state, not history.
    await receipt('WI-RUNNING-ANCIENT', 'running', 10_000);

    expect(await gcGovernorReceipts({ nowMs: NOW })).toBe(0);
    expect(await surviving()).toEqual(['WI-RUNNING-ANCIENT']);
  });

  it('honours the retention window boundary', async () => {
    await receipt('WI-JUST-INSIDE', 'completed', GOVERNOR_RECEIPT_RETENTION_HOURS - 0.5);
    await receipt('WI-JUST-OUTSIDE', 'completed', GOVERNOR_RECEIPT_RETENTION_HOURS + 0.5);

    expect(await gcGovernorReceipts({ nowMs: NOW })).toBe(1);
    expect(await surviving()).toEqual(['WI-JUST-INSIDE']);
  });

  it('retentionHours widens or narrows what is due', async () => {
    await receipt('WI-5H', 'completed', 5);
    expect(await gcGovernorReceipts({ nowMs: NOW, retentionHours: 24 })).toBe(0);
    expect(await gcGovernorReceipts({ nowMs: NOW, retentionHours: 1 })).toBe(1);
  });

  it('batchLimit bounds one run, oldest first, and successive runs converge', async () => {
    await receipt('WI-AGE-9', 'completed', 9);
    await receipt('WI-AGE-8', 'completed', 8);
    await receipt('WI-AGE-7', 'completed', 7);

    // Bounded: one run takes only the two OLDEST.
    expect(await gcGovernorReceipts({ nowMs: NOW, batchLimit: 2 })).toBe(2);
    expect(await surviving()).toEqual(['WI-AGE-7']);

    // Converging: the next run finishes the job rather than stalling.
    expect(await gcGovernorReceipts({ nowMs: NOW, batchLimit: 2 })).toBe(1);
    expect(await surviving()).toEqual([]);
  });

  it('is a no-op when nothing is due', async () => {
    await receipt('WI-FRESH', 'completed', 0);
    expect(await gcGovernorReceipts({ nowMs: NOW })).toBe(0);
  });
});
