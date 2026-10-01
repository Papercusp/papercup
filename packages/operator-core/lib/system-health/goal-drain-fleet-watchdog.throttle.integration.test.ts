/**
 * WI-10004626 — the steward's drain-worker throttle READER against a REAL Postgres.
 *
 * The unit suite injects `workerThrottled`; it cannot see the SQL that decides it. This file pins the one
 * contract that matters across the two halves: a mark written with the REAL fact writer (`assertFact`, the same
 * door `facts:assert` uses) is seen by `readLiveDrainWorkerThrottles`, and every way a fact stops being live
 * (retracted, expired, superseded) or never was (wrong scope, wrong key, another workspace's mark under the same
 * goal id) is NOT. The last test cross-checks the reader against the canonical fact fold (`listFacts`, what
 * `facts:list` shows) so a lifecycle column agent-facts learns about later cannot silently split the two.
 *
 * Schema: the real head schema via `createOrgTestDb()` — never inline DDL.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';

import { assertFact, listFacts, retractFact } from '../agent-facts/store';
import {
  DRAIN_WORKER_THROTTLE_FACT_KEY_PREFIX,
  drainWorkerThrottleFactKey,
  drainWorkerThrottleSetKey,
  readLiveDrainWorkerThrottles,
} from './goal-drain-fleet-watchdog';

const WS = 'ws-drain-throttle-wi10004626';
const WS_OTHER = 'ws-drain-throttle-other';
let db: OrgTestDb;
let sql: postgres.Sql;

const put = (key: string, over: { workspaceId?: string } = {}) =>
  assertFact(
    { ttlSec: 3600, scope: 'workspace', key, body: 'steward spend pacing', createdBy: 'su-int', workspaceId: WS, ...over },
    sql,
  );

beforeAll(async () => {
  db = await createOrgTestDb();
  sql = db.adminSql;

  // LIVE: the only marks that may count.
  await put(drainWorkerThrottleFactKey('g-live'));
  await put(drainWorkerThrottleFactKey('g-live'), { workspaceId: WS_OTHER }); // same goal id, another workspace
  await put(drainWorkerThrottleFactKey('g-reasserted'));
  await put(drainWorkerThrottleFactKey('g-reasserted')); // same-key correction appends a version; only the current one is live

  // NOT live: retracted.
  await put(drainWorkerThrottleFactKey('g-retracted'));
  await retractFact(
    { scope: 'workspace', key: drainWorkerThrottleFactKey('g-retracted'), workspaceId: WS, retractedBy: 'su-int', reason: 'lifted' },
    sql,
  );

  // NOT live: expired (the mark lapsing on its own is the whole point of building this on facts).
  await put(drainWorkerThrottleFactKey('g-expired'));
  await sql`UPDATE harness_shared.agent_facts SET expires_at = now() - interval '1 minute'
             WHERE workspace_id = ${WS} AND key = ${drainWorkerThrottleFactKey('g-expired')}`;

  // NOT live: a superseded row with no current version.
  await put(drainWorkerThrottleFactKey('g-superseded'));
  await sql`UPDATE harness_shared.agent_facts SET superseded_at = now()
             WHERE workspace_id = ${WS} AND key = ${drainWorkerThrottleFactKey('g-superseded')}`;

  // NOT a throttle: right key, wrong scope.
  await assertFact(
    {
      ttlSec: 3600,
      scope: 'owner',
      scopeRef: 'su-someone',
      key: drainWorkerThrottleFactKey('g-owner-scoped'),
      body: 'owner-scoped, not workspace-scoped',
      createdBy: 'su-int',
      workspaceId: WS,
    },
    sql,
  );
  // NOT a throttle: right scope, wrong key (a prefix lookalike with no colon, and an unrelated key).
  await put('drain-worker-throttle-g-nocolon');
  await put(`other:${'g-wrong-key'}`);
}, 120_000);

afterAll(async () => {
  await db?.cleanup();
}, 120_000);

describe('readLiveDrainWorkerThrottles over a real Postgres', () => {
  it('returns exactly the live workspace-scope marks, keyed by workspace + goal', async () => {
    const live = await readLiveDrainWorkerThrottles(sql);
    expect([...live].sort()).toEqual(
      [
        drainWorkerThrottleSetKey(WS, 'g-live'),
        drainWorkerThrottleSetKey(WS_OTHER, 'g-live'),
        drainWorkerThrottleSetKey(WS, 'g-reasserted'),
      ].sort(),
    );
  });

  it('a mark is per workspace: the same goal id throttled in one workspace is not throttled in a third', async () => {
    const live = await readLiveDrainWorkerThrottles(sql);
    expect(live.has(drainWorkerThrottleSetKey(WS, 'g-live'))).toBe(true);
    expect(live.has(drainWorkerThrottleSetKey('ws-never-throttled', 'g-live'))).toBe(false);
  });

  it('retracting the live mark lifts the hold (the steward lever), and re-asserting restores it', async () => {
    const key = drainWorkerThrottleFactKey('g-toggle');
    await put(key);
    expect((await readLiveDrainWorkerThrottles(sql)).has(drainWorkerThrottleSetKey(WS, 'g-toggle'))).toBe(true);
    await retractFact({ scope: 'workspace', key, workspaceId: WS, retractedBy: 'su-int', reason: 'lift' }, sql);
    expect((await readLiveDrainWorkerThrottles(sql)).has(drainWorkerThrottleSetKey(WS, 'g-toggle'))).toBe(false);
    await put(key);
    expect((await readLiveDrainWorkerThrottles(sql)).has(drainWorkerThrottleSetKey(WS, 'g-toggle'))).toBe(true);
  });

  it('DRIFT GUARD: agrees with the canonical fact fold (what facts:list shows) for the same workspace', async () => {
    const folded = await listFacts({ scope: 'workspace' }, { workspaceId: WS, limit: 500 }, sql);
    const canonical = folded
      .filter((f) => f.key.startsWith(DRAIN_WORKER_THROTTLE_FACT_KEY_PREFIX))
      .map((f) => drainWorkerThrottleSetKey(WS, f.key.slice(DRAIN_WORKER_THROTTLE_FACT_KEY_PREFIX.length)));
    // positive control: the fold is not vacuously empty, so equality below is a real comparison
    expect(canonical.length).toBeGreaterThanOrEqual(2);
    const mine = [...(await readLiveDrainWorkerThrottles(sql))].filter((k) => k.startsWith(`${WS}\u0000`));
    expect(mine.sort()).toEqual(canonical.sort());
  });
});
