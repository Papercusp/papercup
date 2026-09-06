/**
 * scan-outbox-health.integration.test.ts — real testcontainer PG.
 *
 * Isolated regression coverage for `scanOutboxHealth` (fleet-monitors.ts,
 * P-013) against a MINIMAL hand-rolled `substrate_outbox` table — decoupled
 * from `composition-rig.ts`'s large hand-copied schema fixture (which, as of
 * this writing, is independently stale against migration 853's `plan_items`
 * claim-floor check and fails every `fleet-monitors.integration.test.ts` case
 * before it ever reaches the outbox-health assertions; see EI-21009625512310918
 * follow-up filing). Mirrors the minimal-DDL pattern
 * `substrate-outbox-backstop-gc.integration.test.ts` already uses for the same
 * table.
 *
 * EI-21009625512310918: `scanOutboxHealth`'s own query was missing the
 * `quarantined_at IS NULL` exclusion that `load-drain-stats.ts`'s
 * `loadSubstrateDrainStats` already applies (mig 645, WI-3896 follow-up) over
 * the SAME table for the SAME "undrained" concept. A row the WI-3896 poison-row
 * quarantine deliberately leaves undrained forever therefore kept inflating
 * this scan's depth/age SLO without bound — the exact perpetual-false-positive
 * class outbox-drain-quarantine-runbook.md documents, reached through this
 * monitor's independent query instead of `loadSubstrateDrainStats`'s.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';
import { scanOutboxHealth } from './fleet-monitors';

const WORKSPACE = 'ws-outbox-health';
const HARNESS = 'papercusp';

async function seed(
  sql: postgres.Sql,
  fields: { key: string; ts: number; drainedAt?: number | null; quarantinedAt?: number | null },
): Promise<void> {
  await sql`
    INSERT INTO harness_shared.substrate_outbox
      (workspace_id, harness_slug, table_name, op, key, row, ts, drained_at, quarantined_at)
    VALUES
      (${WORKSPACE}, ${HARNESS}, 'harness_features', 'put', ${fields.key}, ${sql.json({})},
       ${fields.ts}, ${fields.drainedAt ?? null}, ${fields.quarantinedAt ?? null})`;
}

describe('scanOutboxHealth — quarantined-row exclusion (EI-21009625512310918)', () => {
  let db: FreshPgDb;
  let sql: postgres.Sql;

  beforeAll(async () => {
    db = await createFreshPgDb('outbox_health');
    sql = db.sql;
    // Minimal DDL mirroring substrate-outbox-backstop-gc.integration.test.ts,
    // plus mig 645's `quarantined_at` column (the column under test here).
    await sql.unsafe(`
      CREATE TABLE harness_shared.substrate_outbox (
        id             BIGSERIAL PRIMARY KEY,
        workspace_id   TEXT   NOT NULL,
        harness_slug   TEXT   NOT NULL,
        table_name     TEXT   NOT NULL,
        op             TEXT   NOT NULL CHECK (op IN ('put', 'del')),
        key            TEXT   NOT NULL,
        row            JSONB,
        ts             BIGINT NOT NULL,
        enqueued_at_ms BIGINT NOT NULL DEFAULT ((EXTRACT(epoch FROM now()) * 1000)::bigint),
        drained_at     BIGINT,
        drained_log_key TEXT,
        quarantined_at BIGINT
      );
    `);
  }, 60_000);
  afterAll(async () => {
    await db?.cleanup();
  });
  beforeEach(async () => {
    await sql`DELETE FROM harness_shared.substrate_outbox`;
  });

  it('a QUARANTINED row is excluded from depth + age, even though it would otherwise breach both SLOs', async () => {
    const now = 1_800_000_000_000;
    // ~57 days undrained — matches the live EI-21009625512310918 forensics shape
    // (oldest undrained row age 4917013740ms) — and quarantined a while ago.
    await seed(sql, { key: 'poison-1', ts: now - 4_917_013_740, drainedAt: null, quarantinedAt: now - 30 * 60_000 });

    const tight = await scanOutboxHealth(sql, {
      maxDepth: 0,
      maxAgeMs: 1,
      nowMs: now,
      workspaceId: WORKSPACE,
      harness: HARNESS,
    });

    expect(tight.undrainedDepth).toBe(0);
    expect(tight.oldestUndrainedAgeMs).toBeNull();
    expect(tight.breaches).toEqual([]);
  });

  it('a REAL (non-quarantined) undrained row still counts toward depth + age and breaches the SLO', async () => {
    const now = 1_800_000_000_000;
    await seed(sql, { key: 'real-1', ts: now - 3_600_000, drainedAt: null, quarantinedAt: null });

    const result = await scanOutboxHealth(sql, {
      maxDepth: 0,
      maxAgeMs: 1,
      nowMs: now,
      workspaceId: WORKSPACE,
      harness: HARNESS,
    });

    expect(result.undrainedDepth).toBe(1);
    expect(result.oldestUndrainedAgeMs).toBe(3_600_000);
    expect(result.breaches).toEqual(['outbox depth 1 > SLO 0', 'oldest undrained row age 3600000ms > SLO 1ms']);
  });

  it('mixed backlog: only the non-quarantined row is counted, and it alone drives the reported oldest age', async () => {
    const now = 1_800_000_000_000;
    // The OLDEST row is quarantined (would otherwise dominate MIN(ts)); the
    // real, actionable backlog is younger and must be what's reported.
    await seed(sql, { key: 'poison-old', ts: now - 10 * 24 * 60 * 60_000, drainedAt: null, quarantinedAt: now - 60_000 });
    await seed(sql, { key: 'real-recent', ts: now - 5_000, drainedAt: null, quarantinedAt: null });

    const result = await scanOutboxHealth(sql, {
      maxDepth: 10_000,
      maxAgeMs: 30 * 60_000,
      nowMs: now,
      workspaceId: WORKSPACE,
      harness: HARNESS,
    });

    expect(result.undrainedDepth).toBe(1);
    expect(result.oldestUndrainedAgeMs).toBe(5_000);
    expect(result.breaches).toEqual([]);
  });

  it('a RETRIED row (quarantined_at cleared back to NULL) is counted again', async () => {
    const now = 1_800_000_000_000;
    await seed(sql, { key: 'retried', ts: now - 3_600_000, drainedAt: null, quarantinedAt: now - 60_000 });
    await sql`UPDATE harness_shared.substrate_outbox SET quarantined_at = NULL WHERE key = 'retried'`;

    const result = await scanOutboxHealth(sql, {
      maxDepth: 0,
      maxAgeMs: 1,
      nowMs: now,
      workspaceId: WORKSPACE,
      harness: HARNESS,
    });

    expect(result.undrainedDepth).toBe(1);
    expect(result.oldestUndrainedAgeMs).toBe(3_600_000);
  });
});

describe('scanOutboxHealth — residentInProcess dormancy exception (EI-21096375006041139)', () => {
  let db: FreshPgDb;
  let sql: postgres.Sql;

  beforeAll(async () => {
    db = await createFreshPgDb('outbox_health_resident');
    sql = db.sql;
    await sql.unsafe(`
      CREATE TABLE harness_shared.substrate_outbox (
        id             BIGSERIAL PRIMARY KEY,
        workspace_id   TEXT   NOT NULL,
        harness_slug   TEXT   NOT NULL,
        table_name     TEXT   NOT NULL,
        op             TEXT   NOT NULL CHECK (op IN ('put', 'del')),
        key            TEXT   NOT NULL,
        row            JSONB,
        ts             BIGINT NOT NULL,
        enqueued_at_ms BIGINT NOT NULL DEFAULT ((EXTRACT(epoch FROM now()) * 1000)::bigint),
        drained_at     BIGINT,
        drained_log_key TEXT,
        quarantined_at BIGINT
      );
    `);
  }, 60_000);
  afterAll(async () => {
    await db?.cleanup();
  });
  beforeEach(async () => {
    await sql`DELETE FROM harness_shared.substrate_outbox`;
  });

  it('residentInProcess:false withholds the AGE breach on a small, merely-aged backlog — the live hotel-reservations shape (406 rows, ~3h, no booted drain loop)', async () => {
    const now = 1_800_000_000_000;
    // ~3h old, well under any real depth SLO — mirrors the live forensics
    // (undrainedDepth:371, oldestUndrainedAgeMs:11292679) that drained
    // completely in ~10s once the harness next booted.
    await seed(sql, { key: 'dormant-1', ts: now - 3 * 60 * 60_000, drainedAt: null, quarantinedAt: null });

    const result = await scanOutboxHealth(sql, {
      maxDepth: 10_000,
      maxAgeMs: 30 * 60_000,
      nowMs: now,
      workspaceId: WORKSPACE,
      harness: HARNESS,
      residentInProcess: false,
    });

    expect(result.undrainedDepth).toBe(1);
    expect(result.oldestUndrainedAgeMs).toBe(3 * 60 * 60_000);
    expect(result.breaches).toEqual([]);
    expect(result.ageBreachSuppressedDormant).toBe(true);
  });

  it('residentInProcess:false does NOT suppress the DEPTH leg — unbounded growth is real regardless of why nothing is draining it', async () => {
    const now = 1_800_000_000_000;
    await seed(sql, { key: 'dormant-2', ts: now - 3 * 60 * 60_000, drainedAt: null, quarantinedAt: null });

    const result = await scanOutboxHealth(sql, {
      maxDepth: 0,
      maxAgeMs: 30 * 60_000,
      nowMs: now,
      workspaceId: WORKSPACE,
      harness: HARNESS,
      residentInProcess: false,
    });

    expect(result.breaches).toEqual(['outbox depth 1 > SLO 0']);
    expect(result.ageBreachSuppressedDormant).toBe(true);
  });

  it('residentInProcess omitted (unknown) or true preserves the unconditional pre-existing behavior — a real drain-loop failure still alarms', async () => {
    const now = 1_800_000_000_000;
    await seed(sql, { key: 'live-1', ts: now - 3 * 60 * 60_000, drainedAt: null, quarantinedAt: null });

    const omitted = await scanOutboxHealth(sql, {
      maxDepth: 10_000,
      maxAgeMs: 30 * 60_000,
      nowMs: now,
      workspaceId: WORKSPACE,
      harness: HARNESS,
    });
    expect(omitted.breaches).toEqual(['oldest undrained row age 10800000ms > SLO 1800000ms']);
    expect(omitted.ageBreachSuppressedDormant).toBe(false);

    const resident = await scanOutboxHealth(sql, {
      maxDepth: 10_000,
      maxAgeMs: 30 * 60_000,
      nowMs: now,
      workspaceId: WORKSPACE,
      harness: HARNESS,
      residentInProcess: true,
    });
    expect(resident.breaches).toEqual(['oldest undrained row age 10800000ms > SLO 1800000ms']);
    expect(resident.ageBreachSuppressedDormant).toBe(false);
  });
});
