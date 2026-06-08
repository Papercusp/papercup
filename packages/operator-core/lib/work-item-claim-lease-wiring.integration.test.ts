/**
 * work-item-claim-lease-wiring.integration.test.ts — the flag-gated P-004 claim→lease
 * wiring (decentralized-dispatch-scaling-2026-06-08, D-007 hybrid).
 *
 * Covers the owner ratification switch + the lease helper against real PG (default
 * LocalWorkItemClaimAuthority — single-box authority-is-self). The cross-Swarm
 * serialization + rollback-on-conflict is the P-013 cross-machine E2E (multiple PGs);
 * on one PG the local SKIP-LOCKED already serializes, so here we prove the helper
 * records the Hive lease + reports a conflict when the same item is already leased.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { createFreshPgDb, type FreshPgDb } from '../test/_pg-helpers';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async () => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...actual, getOrgPg: () => ({ sql: h.sql }) };
});
vi.mock('./workspace-registry', async () => {
  const actual = await vi.importActual<typeof import('./workspace-registry')>('./workspace-registry');
  return { ...actual, activeWorkspaceId: () => 'default' };
});
// Isolate the wiring from the federation registry/PG reads — the helper's Hive
// resolution is the federation team's tested surface; here we exercise the lease path
// with a non-Hive (harness-scoped) fallback.
vi.mock('./hive-federation', () => ({ hiveHomeSlugForHarness: async () => null }));

const { workItemClaimLeaseEnabled, leaseClaimedWorkItem } = await import('./work-item-claim-lease-wiring');
const { getClaim } = await import('./work-item-claims');
const { resetWorkItemClaimAuthority } = await import('./work-item-claim-authority');

const WORK_ITEM_CLAIMS_DDL = `
  CREATE TABLE IF NOT EXISTS harness_shared.work_item_claims (
    workspace_id text NOT NULL, harness_slug text NOT NULL, work_item_id text NOT NULL,
    hive_slug text, claim_id uuid DEFAULT gen_random_uuid() NOT NULL,
    owner text NOT NULL, owner_label text, holder_pubkey text,
    intent text DEFAULT ''::text NOT NULL, ttl_sec integer DEFAULT 1800 NOT NULL,
    acquired_ts timestamptz DEFAULT clock_timestamp() NOT NULL,
    expires_ts timestamptz NOT NULL,
    last_activity_ts timestamptz DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT work_item_claims_pkey PRIMARY KEY (workspace_id, harness_slug, work_item_id))`;

let db: FreshPgDb;

beforeAll(async () => {
  db = await createFreshPgDb('wi-claim-lease-wiring');
  h.sql = db.sql;
  await db.sql.unsafe(WORK_ITEM_CLAIMS_DDL);
});
afterAll(async () => { await db?.end?.(); });
beforeEach(async () => {
  resetWorkItemClaimAuthority();
  await db.sql`DELETE FROM harness_shared.work_item_claims`;
  delete process.env.PAPERCUSP_WORKITEM_CLAIM_LEASE;
});
afterEach(() => { delete process.env.PAPERCUSP_WORKITEM_CLAIM_LEASE; });

describe('workItemClaimLeaseEnabled (owner ratification switch)', () => {
  it('defaults OFF; ON only for exactly "1"', () => {
    expect(workItemClaimLeaseEnabled()).toBe(false);
    process.env.PAPERCUSP_WORKITEM_CLAIM_LEASE = '0';
    expect(workItemClaimLeaseEnabled()).toBe(false);
    process.env.PAPERCUSP_WORKITEM_CLAIM_LEASE = 'true';
    expect(workItemClaimLeaseEnabled()).toBe(false);
    process.env.PAPERCUSP_WORKITEM_CLAIM_LEASE = '1';
    expect(workItemClaimLeaseEnabled()).toBe(true);
  });
});

describe('leaseClaimedWorkItem (real PG, default Local Hive authority)', () => {
  it('records the Hive lease for the claimer and returns true', async () => {
    const ok = await leaseClaimedWorkItem({ harness: 'h1', workItemId: 'F-001', owner: 'su-a' });
    expect(ok).toBe(true);
    const claim = await getClaim('default', 'h1', 'F-001');
    expect(claim?.owner).toBe('su-a');
    expect(claim?.expired).toBe(false);
  });

  it('reports a conflict (false) when another owner already holds the live lease', async () => {
    expect(await leaseClaimedWorkItem({ harness: 'h1', workItemId: 'F-002', owner: 'su-a' })).toBe(true);
    expect(await leaseClaimedWorkItem({ harness: 'h1', workItemId: 'F-002', owner: 'su-b' })).toBe(false);
    const claim = await getClaim('default', 'h1', 'F-002');
    expect(claim?.owner).toBe('su-a'); // su-a keeps it
  });

  it('the same owner re-leasing its own item stays true (idempotent extend)', async () => {
    expect(await leaseClaimedWorkItem({ harness: 'h1', workItemId: 'F-003', owner: 'su-a' })).toBe(true);
    expect(await leaseClaimedWorkItem({ harness: 'h1', workItemId: 'F-003', owner: 'su-a' })).toBe(true);
  });
});
