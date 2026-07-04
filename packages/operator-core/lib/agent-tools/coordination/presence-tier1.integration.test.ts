/**
 * presence-tier1.integration.test.ts — exercises the REAL batch SQL in
 * fetchPresenceTier1 against live PG (presence-v2 P-003). The pure merge is
 * unit-tested in presence-tier1.test.ts; this proves the column names + the
 * `= ANY(${ids}::text[])` idiom + DISTINCT ON / array_agg against the schema.
 *
 * Isolated on the shared table by a unique owner id + self-cleanup (the
 * presence-conformance pattern). Soft-skips if PG is unreachable.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { getOrgPg } from '@papercusp/db-org';
import { fetchPresenceTier1 } from './presence-tier1';
import { getDefaultWakeMode, setWakeMode } from './wake-mode';

const OWNER = `tier1-it-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const WS = 'default';

let ready = true;

async function cleanup(): Promise<void> {
  const { sql } = getOrgPg();
  await sql`DELETE FROM harness_shared.plan_item_claims WHERE owner = ${OWNER}`.catch(() => {});
  await sql`DELETE FROM harness_shared.event_awaits WHERE subscriber_id = ${OWNER}`.catch(() => {});
  await sql`DELETE FROM harness_shared.operator_settings WHERE key = ${`wake_mode:agent:${OWNER}`}`.catch(
    () => {},
  );
}

describe('fetchPresenceTier1 (live PG)', () => {
  beforeAll(async () => {
    try {
      await getOrgPg().sql`SELECT 1`;
    } catch {
      ready = false;
    }
  });
  afterEach(cleanup);

  it('joins claims + active await + wake-mode by ownerId; model null with no spawn', async () => {
    if (!ready) return;
    const { sql } = getOrgPg();
    await sql`
      INSERT INTO harness_shared.plan_item_claims
        (workspace_id, harness_slug, plan_slug, item_id, owner, expires_ts)
      VALUES
        (${WS}, 'papercup', 'presence-v2-2026-06-14', 'P-777', ${OWNER}, now() + interval '1 hour'),
        (${WS}, 'papercup', 'presence-v2-2026-06-14', 'P-778', ${OWNER}, now() + interval '1 hour')
    `;
    await sql`
      INSERT INTO harness_shared.event_awaits (workspace_id, subscriber_id, event_key, note)
      VALUES (${WS}, ${OWNER}, 'plan-run:finished:42', 'blocked on the run')
    `;
    await setWakeMode(OWNER, 'manual');

    const map = await fetchPresenceTier1([OWNER]);
    const e = map.get(OWNER);
    expect(e).toBeDefined();
    expect(e!.claimedItems).toEqual(['P-777', 'P-778']); // array_agg ORDER BY item_id
    expect(e!.awaitingEvent).toBe(true);
    expect(e!.awaitingEventKey).toBe('plan-run:finished:42');
    expect(e!.awaitingNote).toBe('blocked on the run');
    expect(e!.wakeMode).toBe('manual');
    expect(e!.model).toBeNull(); // no running spawned_agents row for this owner
  });

  it('an unclaimed owner gets empty defaults (no rows, inherits the global default wake mode)', async () => {
    if (!ready) return;
    const map = await fetchPresenceTier1([OWNER]); // nothing seeded for OWNER this case
    const e = map.get(OWNER);
    expect(e).toBeDefined();
    expect(e!.claimedItems).toEqual([]);
    expect(e!.awaitingEvent).toBe(false);
    expect(e!.model).toBeNull();
    // The semantic under test: NO per-owner override → falls through to the GLOBAL default.
    // Assert against the live global default, NOT the factory 'auto' — this runs against the
    // shared PG, and the owner can (deliberately) set the global default to 'manual' at any
    // time (as on 2026-07-03, which red-pinned the gate on the old hardcoded expectation).
    expect(e!.wakeMode).toBe(await getDefaultWakeMode());
  });

  it('empty ownerIds short-circuits to an empty map', async () => {
    if (!ready) return;
    expect((await fetchPresenceTier1([])).size).toBe(0);
  });
});
