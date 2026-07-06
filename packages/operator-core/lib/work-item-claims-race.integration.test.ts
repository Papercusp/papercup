/**
 * Race condition test: Two agents in the retry path simultaneously
 * (work-item-claims-race.integration.test.ts)
 *
 * Tests the specific race condition where:
 * 1. An item is claimed and then released
 * 2. Two agents simultaneously try to claim it
 * 3. Both agents hit the getClaim() null case (the claim was just released)
 * 4. Both agents enter the retry path
 * 5. BOTH agents' retry INSERTs succeed before the other checks the state
 *
 * This tests the fix for the duplicate assignment race condition.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { createFreshPgDb, type FreshPgDb } from '../test/_pg-helpers';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async () => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...actual, getOrgPg: () => ({ sql: h.sql }) };
});

const { acquireClaimLocal } = await import('./work-item-claims');

const WORK_ITEM_CLAIMS_DDL = `
  CREATE TABLE IF NOT EXISTS harness_shared.work_item_claims (
    workspace_id text NOT NULL, harness_slug text NOT NULL, work_item_id text NOT NULL,
    pot_slug text, claim_id uuid DEFAULT gen_random_uuid() NOT NULL,
    owner text NOT NULL, owner_label text, holder_pubkey text,
    intent text DEFAULT ''::text NOT NULL, ttl_sec integer DEFAULT 1800 NOT NULL,
    acquired_ts timestamptz DEFAULT clock_timestamp() NOT NULL,
    expires_ts timestamptz NOT NULL,
    last_activity_ts timestamptz DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT work_item_claims_pkey PRIMARY KEY (workspace_id, harness_slug, work_item_id))`;

let db: FreshPgDb;

beforeAll(async () => {
  db = await createFreshPgDb('wi-claims-race');
  h.sql = db.sql;
  await db.sql.unsafe(WORK_ITEM_CLAIMS_DDL);
});

afterAll(async () => {
  await db?.cleanup();
});

afterEach(async () => {
  await db.sql`DELETE FROM harness_shared.work_item_claims`;
});

describe('Race condition: two agents in retry path for freed item', () => {
  it('demonstrates the race condition where two agents both succeed claiming the same freed item', async () => {
    const WS = 'default';
    const H = 'h1';
    const ITEM = 'F-race-test';

    // Setup: Agent A claims the item
    const initialClaim = await acquireClaimLocal({
      workspaceId: WS,
      harnessSlug: H,
      workItemId: ITEM,
      owner: 'agent-setup',
    });
    expect(initialClaim.ok).toBe(true);
    const firstClaimId = initialClaim.ok ? initialClaim.claim.claimId : '';

    // Release the claim
    await db.sql`DELETE FROM harness_shared.work_item_claims WHERE work_item_id = ${ITEM}`;

    // Now simulate two agents racing to claim the freed item simultaneously.
    // They will both:
    // 1. First INSERT fails (gets 0 rows from the UPDATE part of ON CONFLICT)
    // 2. getClaim() returns null (item is freed)
    // 3. Both enter the retry path
    // 4. Both retry INSERTs try to insert at the same time

    const [resultA, resultB] = await Promise.all([
      acquireClaimLocal({
        workspaceId: WS,
        harnessSlug: H,
        workItemId: ITEM,
        owner: 'agent-A',
      }),
      acquireClaimLocal({
        workspaceId: WS,
        harnessSlug: H,
        workItemId: ITEM,
        owner: 'agent-B',
      }),
    ]);

    // EXPECTED: Exactly one should succeed
    // BUG: Both might succeed if the race condition exists
    const successCount = (resultA.ok ? 1 : 0) + (resultB.ok ? 1 : 0);

    console.log('Result A:', resultA);
    console.log('Result B:', resultB);
    console.log('Success count:', successCount);

    expect(successCount).toBe(1, 'Exactly one agent should win the claim');

    // Verify database has exactly one claim
    const [{ count }] = await db.sql<{ count: number }[]>`
      SELECT count(*)::int as count FROM harness_shared.work_item_claims
      WHERE workspace_id = ${WS} AND harness_slug = ${H} AND work_item_id = ${ITEM}`;
    expect(count).toBe(1, 'Database should have exactly one claim for the item');

    // Verify the claim belongs to exactly one of the agents
    const owners = [resultA, resultB]
      .filter((r) => r.ok)
      .map((r) => (r.ok ? r.claim.owner : null));
    expect(owners).toHaveLength(1);
    expect(['agent-A', 'agent-B']).toContain(owners[0]);
  });
});
