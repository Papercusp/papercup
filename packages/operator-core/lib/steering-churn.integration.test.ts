/**
 * steering-churn.integration.test.ts — the multi-Queen steering tripwire against
 * real Postgres (hive-network-surface-2026-06-11 P-010 / Brief B-12; D-004).
 *
 * Proves end-to-end:
 *   • the migration-232 AFTER trigger records ONE ledger row per actual
 *     feature_order change, deriving the WRITER from the federation provenance:
 *     origin='local' → '__local__'; origin='remote' → author_pubkey. A no-op
 *     (same order) and a null-order insert record NOTHING.
 *   • detect+escalate: two writers ping-ponging the same item (>= threshold flips)
 *     trips and raises one escalation; a single writer (the N=1 reality today)
 *     never does — "zero churn at N=1".
 *   • the debounce: at most one escalation per item per cooldown, then again once
 *     the cooldown elapses.
 *   • the periodic sweep finds the churned item and escalates it, leaving
 *     single-writer items alone.
 *
 * Two writers are SIMULATED by driving the provenance columns the production paths
 * set: a local steer (setWorkItemPriority + mig-214 → origin='local') and a remote
 * Queen's steer (the harness-features projection → origin='remote' + author_pubkey).
 * This DB has neither trigger, so the test sets those columns explicitly.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFreshPgDb, type FreshPgDb } from '../test/_pg-helpers';
import { HARNESS_FEATURES_CONSOLIDATED_DDL } from '../test/_work-items-schema';
import {
  checkAndEscalateSteeringChurn,
  pruneSteeringChurnEvents,
  sweepSteeringChurn,
  type SteeringChurnEscalator,
} from './steering-churn';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SQL_DIR = resolve(__dirname, '../../../libs/papercusp/libs/db/sql');

const H = 'papercup';
const WS = 'default';
const PEER_B = 'aGVsbG9wZWVyQg=='; // a base64-ish remote author_pubkey stand-in
const PEER_C = 'aGVsbG9wZWVyQw==';
let db: FreshPgDb;

beforeAll(async () => {
  db = await createFreshPgDb('steering-churn');
  // Create the runtime roles the migration GRANTs to (cluster-global on the shared
  // testcontainer → idempotent) so we apply the migration UNFILTERED — RLS policies
  // and grants included. This validates the WHOLE file applies cleanly the way
  // boot-apply will, not just the table+trigger subset.
  await db.sql.unsafe(`
    DO $$ BEGIN CREATE ROLE harness_app;  EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN CREATE ROLE harness_zero; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  `).simple();
  await db.sql.unsafe(HARNESS_FEATURES_CONSOLIDATED_DDL);
  await db.sql.unsafe(readFileSync(resolve(SQL_DIR, '232-steering-churn.sql'), 'utf8')).simple();
});

afterAll(async () => {
  await db?.cleanup();
});

beforeEach(async () => {
  await db.sql`DELETE FROM harness_shared.harness_features_consolidated`;
  await db.sql`DELETE FROM harness_shared.steering_churn_events`;
  await db.sql`DELETE FROM harness_shared.steering_churn_escalations`;
});

/** Seed a feature with NO priority (a null-order insert records no steer). */
async function seedFeature(id: string) {
  await db.sql`
    INSERT INTO harness_shared.harness_features_consolidated
      (harness_slug, feature_id, item_kind, status, workspace_id, feature_order, origin, created_ts, updated_ts)
    VALUES (${H}, ${id}, 'feature', 'todo', ${WS}, NULL, 'local', 0, 0)`;
}

/**
 * Simulate a steer at ledger-ts `ts` by writer `writer` ('local' → a local steer;
 * any other string → a remote Queen's author_pubkey). Drives origin/author_pubkey/
 * fed_ts the way the production write paths would (this DB lacks mig-214's stamp).
 */
async function steer(id: string, order: number | null, writer: 'local' | string, ts: number) {
  const origin = writer === 'local' ? 'local' : 'remote';
  const pubkey = writer === 'local' ? null : writer;
  await db.sql`
    UPDATE harness_shared.harness_features_consolidated
       SET feature_order = ${order}, origin = ${origin}, author_pubkey = ${pubkey},
           fed_ts = ${ts}, updated_ts = ${ts}
     WHERE harness_slug = ${H} AND feature_id = ${id}`;
}

async function ledgerRows(id: string) {
  return db.sql<{ writer: string; feature_order: number | null; ts: number }[]>`
    SELECT writer, feature_order, ts
      FROM harness_shared.steering_churn_events
     WHERE feature_id = ${id}
     ORDER BY ts ASC, id ASC`;
}

describe('the migration-232 ledger trigger', () => {
  it('records one row per feature_order change, deriving the writer from provenance', async () => {
    await seedFeature('F-1');
    expect(await ledgerRows('F-1')).toHaveLength(0); // null-order insert → no steer

    await steer('F-1', 10, 'local', 1000);
    await steer('F-1', 11, PEER_B, 2000);
    await steer('F-1', 11, PEER_B, 3000); // no-op (same order) → records nothing

    const rows = await ledgerRows('F-1');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ writer: '__local__', feature_order: 10, ts: 1000 });
    expect(rows[1]).toMatchObject({ writer: PEER_B, feature_order: 11, ts: 2000 });
  });

  it('records a clear (feature_order → null) as a steer', async () => {
    await seedFeature('F-2');
    await steer('F-2', 5, 'local', 1000);
    await steer('F-2', null, PEER_C, 2000);
    const rows = await ledgerRows('F-2');
    expect(rows.map((r) => [r.writer, r.feature_order])).toEqual([
      ['__local__', 5],
      [PEER_C, null],
    ]);
  });
});

describe('checkAndEscalateSteeringChurn', () => {
  it('a single writer (N=1 today) never trips — zero churn', async () => {
    await seedFeature('F-3');
    await steer('F-3', 1, 'local', 1000);
    await steer('F-3', 2, 'local', 2000);
    await steer('F-3', 3, 'local', 3000);

    let called = 0;
    const escalate: SteeringChurnEscalator = async () => {
      called += 1;
    };
    const { result, escalated } = await checkAndEscalateSteeringChurn({
      workspaceId: WS,
      harnessSlug: H,
      featureId: 'F-3',
      now: 4000,
      windowMs: 1_000_000,
      sql: db.sql,
      escalate,
    });
    expect(result).toMatchObject({ distinctWriters: 1, churnCount: 0, trip: false });
    expect(escalated).toBe(false);
    expect(called).toBe(0);
  });

  it('two Queens ping-ponging an item trips, escalates once per cooldown, then again', async () => {
    await seedFeature('F-4');
    await steer('F-4', 10, 'local', 1000);
    await steer('F-4', 11, PEER_B, 2000);
    await steer('F-4', 12, 'local', 3000);
    await steer('F-4', 13, PEER_B, 4000);

    let called = 0;
    const escalate: SteeringChurnEscalator = async () => {
      called += 1;
    };
    const base = {
      workspaceId: WS,
      harnessSlug: H,
      featureId: 'F-4',
      windowMs: 1_000_000,
      cooldownMs: 100_000,
      sql: db.sql,
      escalate,
    };

    const first = await checkAndEscalateSteeringChurn({ ...base, now: 5000 });
    expect(first.result).toMatchObject({ distinctWriters: 2, churnCount: 3, trip: true });
    expect(first.escalated).toBe(true);
    expect(called).toBe(1);

    // Within the cooldown → debounced (no second alert for the same thrash).
    const second = await checkAndEscalateSteeringChurn({ ...base, now: 5500 });
    expect(second.result.trip).toBe(true);
    expect(second.escalated).toBe(false);
    expect(called).toBe(1);

    // After the cooldown elapses → escalates again.
    const third = await checkAndEscalateSteeringChurn({ ...base, now: 5000 + 100_001 });
    expect(third.escalated).toBe(true);
    expect(called).toBe(2);
  });

  it('only steers within the window count', async () => {
    await seedFeature('F-5');
    await steer('F-5', 10, 'local', 1000);
    await steer('F-5', 11, PEER_B, 2000);
    await steer('F-5', 12, 'local', 3000);
    await steer('F-5', 13, PEER_B, 4000);

    let called = 0;
    // now=4500, window=1000 → since=3500 → only the ts=4000 event is in-window.
    const { result, escalated } = await checkAndEscalateSteeringChurn({
      workspaceId: WS,
      harnessSlug: H,
      featureId: 'F-5',
      now: 4500,
      windowMs: 1000,
      sql: db.sql,
      escalate: async () => {
        called += 1;
      },
    });
    expect(result.steerCount).toBe(1);
    expect(result.trip).toBe(false);
    expect(escalated).toBe(false);
    expect(called).toBe(0);
  });
});

describe('sweepSteeringChurn', () => {
  it('finds and escalates churned items, leaving single-writer items alone', async () => {
    // F-6: ping-pong between two writers (a churn candidate).
    await seedFeature('F-6');
    await steer('F-6', 10, 'local', 1000);
    await steer('F-6', 11, PEER_B, 2000);
    await steer('F-6', 12, 'local', 3000);
    await steer('F-6', 13, PEER_B, 4000);
    // F-7: only one writer — never even a candidate.
    await seedFeature('F-7');
    await steer('F-7', 1, 'local', 1000);
    await steer('F-7', 2, 'local', 2000);

    const escalatedIds: string[] = [];
    const r = await sweepSteeringChurn({
      now: 5000,
      windowMs: 1_000_000,
      cooldownMs: 100_000,
      sql: db.sql,
      escalate: async (i) => {
        escalatedIds.push(i.featureId);
      },
    });
    expect(r.checked).toBe(1); // only F-6 has >= 2 distinct writers
    expect(r.escalated).toBe(1);
    expect(escalatedIds).toEqual(['F-6']);
  });
});

describe('pruneSteeringChurnEvents', () => {
  it('drops ledger rows older than the retention horizon, keeping recent ones', async () => {
    await seedFeature('F-8');
    // ts here are epoch-ms; "now" is the real wall clock, so 1000/2000 are ancient.
    await steer('F-8', 1, 'local', 1000);
    await steer('F-8', 2, 'local', 2000);
    const recentTs = Date.now();
    await steer('F-8', 3, 'local', recentTs);

    const deleted = await pruneSteeringChurnEvents({ retentionMs: 60_000, sql: db.sql });
    expect(deleted).toBe(2);
    const rows = await ledgerRows('F-8');
    expect(rows).toHaveLength(1);
    expect(rows[0].feature_order).toBe(3);
  });
});
