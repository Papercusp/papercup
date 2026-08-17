/**
 * fleet-monitors-orphan-sweep.integration.test.ts — EI-20723522274831539.
 *
 * THE INCIDENT this guards against: `sweepOrphanedTakenBy` freed a LIVE,
 * actively-working holder's claim, and `scheduler:get_next` then handed the item
 * to a second agent while the first was still mid-flight on it. Reproduced twice
 * inside 25 minutes on 2026-08-17 (WI-39259, WI-39264), both freed 9.7s after the
 * hourly `coord-invariant-monitor` fired, in one bulk statement 6ms apart.
 *
 * ROOT CAUSE: the sweep had NO holder-liveness check whatsoever. Its only guard
 * was an unexpired `work_item_claims` lease row — and that table is empty on this
 * deployment (the lease is flag-gated and unpopulated), so the guard was
 * unconditionally satisfied and every claim older than the 5-minute row-write
 * grace was freed regardless of holder liveness. Because `updated_ts` is bumped
 * only by a WRITE to the row, a holder doing real work without checkpointing
 * crossed that threshold in normal operation — the predicate selected working
 * agents preferentially.
 *
 * WHY THE POSITIVE CONTROL MATTERS: every "must NOT be swept" assertion below
 * would also pass if the sweep were simply broken and swept nothing at all. The
 * dead-holder case is therefore not decoration — it is what makes the negative
 * cases falsifiable.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';
import { HARNESS_FEATURES_CONSOLIDATED_DDL, WORK_ITEM_DEPS_DDL } from '../../test/_work-items-schema';
import { sweepOrphanedTakenBy } from './fleet-monitors';

const PRESENCE_DDL = `
  CREATE TABLE IF NOT EXISTS harness_shared.coord_presence (
    owner_id text PRIMARY KEY,
    heartbeat_at timestamptz
  )`;
const SPAWNED_DDL = `
  CREATE TABLE IF NOT EXISTS harness_shared.spawned_agents (
    spawn_id text PRIMARY KEY,
    session_owner text,
    run_id text,
    status text NOT NULL,
    heartbeat_at timestamptz,
    finished_at timestamptz,
    cancelled_at timestamptz
  )`;
/** The claim-lease table the sweep's (retained, additional) lease guard reads. */
const WORK_ITEM_CLAIMS_DDL = `
  CREATE TABLE IF NOT EXISTS harness_shared.work_item_claims (
    workspace_id text NOT NULL DEFAULT 'default',
    harness_slug text NOT NULL,
    work_item_id text NOT NULL,
    holder_pubkey text,
    pot_slug text,
    expires_ts timestamptz,
    PRIMARY KEY (workspace_id, harness_slug, work_item_id)
  )`;
/** `activeTurnHolderFragment` (folded into liveHolderFragment) reads these. */
const AGENT_ACTIVITY_DDL = `
  CREATE TABLE IF NOT EXISTS harness_shared.agent_activity (
    id BIGSERIAL PRIMARY KEY,
    owner_id text NOT NULL,
    kind text NOT NULL,
    summary text,
    created_at timestamptz NOT NULL DEFAULT now()
  )`;
const TOOL_INVOCATIONS_DDL = `
  CREATE TABLE IF NOT EXISTS harness_shared.tool_invocations (
    id BIGSERIAL PRIMARY KEY,
    coord_owner_id text,
    invoked_at timestamptz NOT NULL DEFAULT now()
  )`;

let db: FreshPgDb;
let sql: postgres.Sql;
const WS = 'default';
const H = 'papercup';

/** Older than the 5-minute row-write grace, so every row below is a candidate on
 *  the `updated_ts` axis and only HOLDER LIVENESS decides the outcome. */
const STALE_WRITE_MS = Date.now() - 60 * 60_000;

async function seedClaim(featureId: string, holder: string, opts: { updatedTs?: number } = {}) {
  await sql`
    INSERT INTO harness_shared.work_items
      (workspace_id, harness_slug, feature_id, title, status, item_kind, taken_by, taken_at, updated_ts)
    VALUES (${WS}, ${H}, ${featureId}, ${'t ' + featureId}, 'wip', 'feature', ${holder},
            now() - interval '30 minutes', ${opts.updatedTs ?? STALE_WRITE_MS})`;
}

async function seedPresence(owner: string, heartbeatAgo: string) {
  await sql`
    INSERT INTO harness_shared.coord_presence (owner_id, heartbeat_at)
    VALUES (${owner}, now() - ${heartbeatAgo}::interval)
    ON CONFLICT (owner_id) DO UPDATE SET heartbeat_at = EXCLUDED.heartbeat_at`;
}

async function takenBy(featureId: string): Promise<string | null> {
  const [row] = await sql<{ taken_by: string | null }[]>`
    SELECT taken_by FROM harness_shared.work_items
     WHERE workspace_id = ${WS} AND harness_slug = ${H} AND feature_id = ${featureId}`;
  return row?.taken_by ?? null;
}

const sweep = () => sweepOrphanedTakenBy(sql, { workspaceId: WS, harness: H });

beforeAll(async () => {
  db = await createFreshPgDb();
  sql = db.sql;
  await sql.unsafe('CREATE SCHEMA IF NOT EXISTS harness_shared');
  await sql.unsafe(HARNESS_FEATURES_CONSOLIDATED_DDL);
  await sql.unsafe(WORK_ITEM_DEPS_DDL).simple();
  await sql.unsafe(PRESENCE_DDL);
  await sql.unsafe(SPAWNED_DDL);
  await sql.unsafe(WORK_ITEM_CLAIMS_DDL);
  await sql.unsafe(AGENT_ACTIVITY_DDL);
  await sql.unsafe(TOOL_INVOCATIONS_DDL);
}, 120_000);

afterAll(async () => {
  await db?.cleanup();
});

beforeEach(async () => {
  await sql`TRUNCATE harness_shared.work_items`;
  await sql`TRUNCATE harness_shared.coord_presence`;
  await sql`TRUNCATE harness_shared.spawned_agents`;
  await sql`TRUNCATE harness_shared.work_item_claims`;
});

describe('EI-20723522274831539 — sweepOrphanedTakenBy must not rob a live holder', () => {
  it('POSITIVE CONTROL: a genuinely DEAD known holder is still swept, and is ATTRIBUTED', async () => {
    // Without this case, every "not swept" assertion below would pass just as
    // happily against a sweep that no longer works at all.
    await seedClaim('F-DEAD', 'su-dead');
    await seedPresence('su-dead', '3 hours');

    const swept = await sweep();

    expect(swept.cleared).toHaveLength(1);
    expect(swept.cleared[0]).toMatchObject({ workItemId: 'F-DEAD', takenBy: 'su-dead' });
    expect(await takenBy('F-DEAD')).toBeNull();

    // The involuntary release names the reaper. Left blank (the pre-fix
    // behaviour) it was indistinguishable from "never released", which is why
    // the incident was first misdiagnosed as "the peers never claimed at all".
    const [row] = await sql<{ last_released_by: string | null }[]>`
      SELECT last_released_by FROM harness_shared.work_items WHERE feature_id = 'F-DEAD'`;
    expect(row?.last_released_by).toBe('reaper:orphan-sweep');
  });

  it('THE REGRESSION: a LIVE holder keeps its claim even when the row write is stale', async () => {
    // Exactly the incident shape: heartbeat fresh, row untouched for an hour
    // because the holder is working rather than writing to the item.
    await seedClaim('F-LIVE', 'su-live');
    await seedPresence('su-live', '30 seconds');

    const swept = await sweep();

    expect(swept.cleared).toEqual([]);
    expect(await takenBy('F-LIVE')).toBe('su-live');
  });

  it('a briefly-PARKED holder (beat inside the 30m parked window) keeps its claim', async () => {
    // The WI-2689 churn case: a member whose loop dropped is about to be
    // re-armed, not dead — reaping here produced claim→release→reclaim ping-pong.
    await seedClaim('F-PARKED', 'su-parked');
    await seedPresence('su-parked', '15 minutes');

    expect((await sweep()).cleared).toEqual([]);
    expect(await takenBy('F-PARKED')).toBe('su-parked');
  });

  it('a NEVER-SEEN-HERE holder is not presumed dead before the fallback horizon', async () => {
    // WI-1999/WI-1964: work_items federate but presence does not, so an unknown
    // holder may be a LIVE agent on another node. Reaping those was the shredder.
    await seedClaim('F-REMOTE', 'su-remote-unknown');

    expect((await sweep()).cleared).toEqual([]);
    expect(await takenBy('F-REMOTE')).toBe('su-remote-unknown');
  });

  it('...but an unknown holder IS freed once that horizon lapses (P-003 still works)', async () => {
    // The sweep's original purpose — reclaim after a peer SWARM dies without ever
    // having a local presence row — is preserved, just deferred rather than denied.
    await seedClaim('F-REMOTE-OLD', 'su-remote-unknown');

    const swept = await sweepOrphanedTakenBy(sql, {
      workspaceId: WS,
      harness: H,
      unknownHolderFallbackMs: 1_000,
    });

    expect(swept.cleared).toHaveLength(1);
    expect(swept.cleared[0]).toMatchObject({ workItemId: 'F-REMOTE-OLD' });
    expect(await takenBy('F-REMOTE-OLD')).toBeNull();
  });

  it('a live holder is protected even in a batch that also contains a dead one', async () => {
    // The incident was a BULK statement: both victims were freed by one UPDATE,
    // 6ms apart. A per-row guard must hold inside a multi-row sweep.
    await seedClaim('F-BATCH-LIVE', 'su-live');
    await seedClaim('F-BATCH-DEAD', 'su-dead');
    await seedPresence('su-live', '30 seconds');
    await seedPresence('su-dead', '3 hours');

    const swept = await sweep();

    expect(swept.cleared.map((c) => c.workItemId)).toEqual(['F-BATCH-DEAD']);
    expect(await takenBy('F-BATCH-LIVE')).toBe('su-live');
  });
});
