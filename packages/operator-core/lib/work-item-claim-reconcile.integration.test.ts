/**
 * Fail-open → reconcile END-TO-END (decentralized-dispatch-scaling-2026-06-08 P-005 +
 * P-013's partition leg) — the D-007 HYBRID's correctness-under-partition guarantee.
 *
 * The pure resolver is unit-tested (work-item-claim-reconcile.test.ts) and the
 * authority serialization is proven (work-item-claims-two-instance.integration.test.ts).
 * This proves the COMPOSITION the hybrid actually relies on when the Hive authority is
 * unreachable: two partitioned Swarms each FAIL OPEN to a local advisory lease (the
 * `acquireClaimLocal` leg `routeToAuthorityForHive` runs on fail-open) — so BOTH "win"
 * locally in their OWN store (the tolerated double-claim) — and then `reconcileClaims`
 * over the two real store-produced advisory claims deterministically picks ONE winner
 * (earliest-claim → lowest-pubkey), so the loser drops. Real PG on both sides; the
 * claims fed to the resolver are produced by the real store, not hand-built.
 *
 * Two fresh schemas = two independent Swarm stores (a single schema's PK would block the
 * second acquire, which is exactly what the authority PREVENTS when reachable; the
 * partition is when it can't, and each store accepts its own local lease).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { createFreshPgDb, type FreshPgDb } from '../test/_pg-helpers';
import type { AdvisoryClaim } from './work-item-claim-reconcile';
import type { WorkItemClaim } from './work-item-claims';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async () => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...actual, getOrgPg: () => ({ sql: h.sql }) };
});

const { acquireClaimLocal } = await import('./work-item-claims');
const { reconcileClaims } = await import('./work-item-claim-reconcile');

const DDL = `
  CREATE TABLE IF NOT EXISTS harness_shared.work_item_claims (
    workspace_id text NOT NULL, harness_slug text NOT NULL, work_item_id text NOT NULL,
    pot_slug text, claim_id uuid DEFAULT gen_random_uuid() NOT NULL,
    owner text NOT NULL, owner_label text, holder_pubkey text,
    intent text DEFAULT ''::text NOT NULL, ttl_sec integer DEFAULT 1800 NOT NULL,
    acquired_ts timestamptz DEFAULT clock_timestamp() NOT NULL,
    expires_ts timestamptz NOT NULL,
    last_activity_ts timestamptz DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT work_item_claims_pkey PRIMARY KEY (workspace_id, harness_slug, work_item_id))`;

let peerA: FreshPgDb;
let peerB: FreshPgDb;

/** Run an op against a specific peer's store by pointing the org-pg mock at its sql. */
async function onPeer<T>(db: FreshPgDb, fn: () => Promise<T>): Promise<T> {
  h.sql = db.sql;
  return fn();
}

function toAdvisory(c: WorkItemClaim): AdvisoryClaim {
  return { workItemId: c.workItemId, holderPubkey: c.holderPubkey ?? '', owner: c.owner, claimId: c.claimId, acquiredTs: c.acquiredTs };
}

beforeAll(async () => {
  peerA = await createFreshPgDb('wi-reconcile-peerA');
  peerB = await createFreshPgDb('wi-reconcile-peerB');
  await peerA.sql.unsafe(DDL);
  await peerB.sql.unsafe(DDL);
});

afterAll(async () => {
  await peerA?.cleanup();
  await peerB?.cleanup();
});

describe('fail-open → reconcile end-to-end (partitioned Hive authority)', () => {
  it('both partitioned Swarms locally win the same item; reconcile picks the deterministic winner', async () => {
    // Authority unreachable ⇒ each Swarm's acquire fails OPEN to acquireClaimLocal on
    // its OWN store. Peer A acquires first (earlier acquired_ts), then peer B.
    const resA = await onPeer(peerA, () =>
      acquireClaimLocal({ workspaceId: 'default', harnessSlug: 'h1', workItemId: 'F-001', hiveSlug: 'my-hive', owner: 'su-a', holderPubkey: 'pk-aaa' }),
    );
    const resB = await onPeer(peerB, () =>
      acquireClaimLocal({ workspaceId: 'default', harnessSlug: 'h1', workItemId: 'F-001', hiveSlug: 'my-hive', owner: 'su-b', holderPubkey: 'pk-zzz' }),
    );

    // The tolerated double-claim: BOTH succeeded locally (the partition reality).
    expect(resA.ok).toBe(true);
    expect(resB.ok).toBe(true);
    if (!resA.ok || !resB.ok) return;

    // Reconcile the two REAL store-produced advisory claims.
    const resolution = reconcileClaims([toAdvisory(resB.claim), toAdvisory(resA.claim)]);
    expect(resolution).not.toBeNull();
    // Peer A acquired first → earliest-claim wins; peer B is the loser that must drop.
    expect(resolution!.winner.owner).toBe('su-a');
    expect(resolution!.losers.map((l) => l.owner)).toEqual(['su-b']);
  });

  it('same-instant double-claim → lowest holder pubkey wins (deterministic tiebreak)', async () => {
    // Force identical acquired_ts so the pubkey tiebreak decides (the authority would
    // have elected the same lowest-pubkey Swarm — keeps fail-open consistent with strong).
    const resA = await onPeer(peerA, () =>
      acquireClaimLocal({ workspaceId: 'default', harnessSlug: 'h1', workItemId: 'F-002', hiveSlug: 'my-hive', owner: 'su-a', holderPubkey: 'pk-zzz' }),
    );
    const resB = await onPeer(peerB, () =>
      acquireClaimLocal({ workspaceId: 'default', harnessSlug: 'h1', workItemId: 'F-002', hiveSlug: 'my-hive', owner: 'su-b', holderPubkey: 'pk-aaa' }),
    );
    if (!resA.ok || !resB.ok) return;
    const ts = '2026-06-08T12:00:00.000Z';
    const a = { ...toAdvisory(resA.claim), acquiredTs: ts };
    const b = { ...toAdvisory(resB.claim), acquiredTs: ts };
    const resolution = reconcileClaims([a, b]);
    // pk-aaa (su-b) < pk-zzz (su-a) → su-b wins on the pubkey tiebreak.
    expect(resolution!.winner.owner).toBe('su-b');
  });
});
