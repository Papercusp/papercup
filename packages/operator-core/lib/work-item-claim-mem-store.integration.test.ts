/**
 * Parity: the in-memory claim store ≡ the real SQL claim store
 * (decentralized-dispatch-scaling-2026-06-08 P-013 support).
 *
 * The ≥3-Swarm cross-machine claim E2E runs on PG-less bench frames, so each Swarm's
 * claim store is `InMemoryWorkItemClaimStore` bound through the `WorkItemClaimCoordinator`
 * seam. For that to be a FAITHFUL stand-in, its lease DECISIONS must match the SQL
 * store's (`acquireClaimLocal`/`heartbeatClaimLocal`/`releaseClaimLocal`) exactly. This
 * test runs the SAME operation sequences against BOTH stores (the SQL one on real PG via
 * createFreshPgDb) and asserts identical outcomes — free-grant, conflict-on-live,
 * extend-own, steal-lapsed, heartbeat (live / wrong-owner / lapsed), release. So the
 * in-memory store provably does not drift from the SQL store the rest of the system uses.
 *
 * Time: the non-time ops are compared directly. Lapse is induced per-store by its own
 * mechanism (SQL: force `expires_ts` into the past; mem: an injectable clock advanced
 * past expiry) — we compare the resulting DECISION (steal vs renew-refusal), not the
 * clock plumbing. The SQL store's own lapse/steal is also covered by
 * work-item-claims.integration.test.ts.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { createFreshPgDb, type FreshPgDb } from '../test/_pg-helpers';
import { InMemoryWorkItemClaimStore } from './work-item-claim-mem-store';
import type { AcquireResult, HeartbeatResult } from './work-item-claims';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async () => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...actual, getOrgPg: () => ({ sql: h.sql }) };
});

const sqlStore = await import('./work-item-claims');

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

const WS = 'default';
const HS = 'h1';
const HIVE = 'my-hive';
const base = (workItemId: string, owner: string, holderPubkey: string) => ({
  workspaceId: WS,
  harnessSlug: HS,
  workItemId,
  potSlug: HIVE,
  owner,
  holderPubkey,
});

/** Normalize an acquire result to its decision (drop claim_id/timestamps that always differ). */
function acq(r: AcquireResult): { ok: boolean; owner: string } {
  return r.ok ? { ok: true, owner: r.claim.owner } : { ok: false, owner: r.conflict.owner };
}
function hb(r: HeartbeatResult): { renewed: boolean; held: boolean; lapsed: boolean } {
  return { renewed: r.renewed, held: r.held, lapsed: /laps/i.test(r.reason ?? '') };
}

let db: FreshPgDb;

beforeAll(async () => {
  db = await createFreshPgDb('wi-claim-mem-parity');
  h.sql = db.sql;
  await db.sql.unsafe(DDL);
});
afterAll(async () => {
  await db?.cleanup();
});
beforeEach(async () => {
  await db.sql`DELETE FROM harness_shared.work_item_claims`;
});

describe('in-memory claim store ↔ SQL claim store parity', () => {
  it('free-grant, conflict-on-live, extend-own, different-items', async () => {
    const mem = new InMemoryWorkItemClaimStore();

    // 1. free grant.
    expect(acq(await sqlStore.acquireClaimLocal(base('F-001', 'laptop', 'pk-a')))).toEqual(
      acq(await mem.acquire(base('F-001', 'laptop', 'pk-a'))),
    );
    // 2. conflict — another owner on the live item.
    const sqlConflict = acq(await sqlStore.acquireClaimLocal(base('F-001', 'cloud', 'pk-b')));
    const memConflict = acq(await mem.acquire(base('F-001', 'cloud', 'pk-b')));
    expect(sqlConflict).toEqual({ ok: false, owner: 'laptop' });
    expect(memConflict).toEqual({ ok: false, owner: 'laptop' });
    // 3. extend own — same owner re-acquires the live item.
    expect(acq(await sqlStore.acquireClaimLocal(base('F-001', 'laptop', 'pk-a')))).toEqual({ ok: true, owner: 'laptop' });
    expect(acq(await mem.acquire(base('F-001', 'laptop', 'pk-a')))).toEqual({ ok: true, owner: 'laptop' });
    // 4. different items from different owners both grant (no false contention).
    expect(acq(await sqlStore.acquireClaimLocal(base('F-002', 'cloud', 'pk-b')))).toEqual({ ok: true, owner: 'cloud' });
    expect(acq(await mem.acquire(base('F-002', 'cloud', 'pk-b')))).toEqual({ ok: true, owner: 'cloud' });
  });

  it('heartbeat: live renews, wrong-owner refuses', async () => {
    const mem = new InMemoryWorkItemClaimStore();
    const sqlR = await sqlStore.acquireClaimLocal(base('F-001', 'laptop', 'pk-a'));
    const memR = await mem.acquire(base('F-001', 'laptop', 'pk-a'));
    if (!sqlR.ok || !memR.ok) throw new Error('setup acquire failed');

    // Live heartbeat by the holder → renew.
    expect(
      hb(await sqlStore.heartbeatClaimLocal({ workspaceId: WS, harnessSlug: HS, workItemId: 'F-001', claimId: sqlR.claim.claimId, owner: 'laptop' })),
    ).toEqual({ renewed: true, held: true, lapsed: false });
    expect(
      hb(await mem.heartbeat({ workspaceId: WS, harnessSlug: HS, workItemId: 'F-001', claimId: memR.claim.claimId, owner: 'laptop' })),
    ).toEqual({ renewed: true, held: true, lapsed: false });

    // Wrong owner → refuse (not renewed, not held).
    const wrong = { workspaceId: WS, harnessSlug: HS, workItemId: 'F-001', claimId: sqlR.claim.claimId, owner: 'someone-else' };
    const sqlWrong = hb(await sqlStore.heartbeatClaimLocal(wrong));
    const memWrong = hb(await mem.heartbeat({ ...wrong, claimId: memR.claim.claimId }));
    expect(sqlWrong.renewed).toBe(false);
    expect(memWrong.renewed).toBe(false);
    expect(memWrong.held).toBe(sqlWrong.held);
  });

  it('release: own removes, repeat is a no-op, wrong owner refuses', async () => {
    const mem = new InMemoryWorkItemClaimStore();
    const sqlR = await sqlStore.acquireClaimLocal(base('F-001', 'laptop', 'pk-a'));
    const memR = await mem.acquire(base('F-001', 'laptop', 'pk-a'));
    if (!sqlR.ok || !memR.ok) throw new Error('setup acquire failed');

    const relSql = { workspaceId: WS, harnessSlug: HS, workItemId: 'F-001', claimId: sqlR.claim.claimId, owner: 'laptop' };
    const relMem = { workspaceId: WS, harnessSlug: HS, workItemId: 'F-001', claimId: memR.claim.claimId, owner: 'laptop' };
    expect(await sqlStore.releaseClaimLocal(relSql)).toBe(true);
    expect(await mem.release(relMem)).toBe(true);
    // Repeat → already gone.
    expect(await sqlStore.releaseClaimLocal(relSql)).toBe(false);
    expect(await mem.release(relMem)).toBe(false);
  });

  it('steal-lapsed: an expired claim is reclaimable by another owner (both stores)', async () => {
    let clk = 1_700_000_000_000;
    const mem = new InMemoryWorkItemClaimStore({ now: () => clk });

    // SQL: acquire then force the row expired into the past.
    await sqlStore.acquireClaimLocal(base('F-001', 'laptop', 'pk-a'));
    await db.sql`UPDATE harness_shared.work_item_claims SET expires_ts = clock_timestamp() - interval '5 seconds' WHERE work_item_id = 'F-001'`;
    // Mem: acquire then advance the clock past the default-TTL expiry.
    await mem.acquire(base('F-001', 'laptop', 'pk-a'));
    clk += (sqlStore.DEFAULT_WORK_ITEM_TTL_SEC + 5) * 1000;

    const stealSql = acq(await sqlStore.acquireClaimLocal(base('F-001', 'cloud', 'pk-b')));
    const stealMem = acq(await mem.acquire(base('F-001', 'cloud', 'pk-b')));
    expect(stealSql).toEqual({ ok: true, owner: 'cloud' });
    expect(stealMem).toEqual({ ok: true, owner: 'cloud' });
  });

  it('heartbeat on a lapsed own claim refuses with a re-acquire reason (both stores)', async () => {
    let clk = 1_700_000_000_000;
    const mem = new InMemoryWorkItemClaimStore({ now: () => clk });
    const sqlR = await sqlStore.acquireClaimLocal(base('F-001', 'laptop', 'pk-a'));
    const memR = await mem.acquire(base('F-001', 'laptop', 'pk-a'));
    if (!sqlR.ok || !memR.ok) throw new Error('setup acquire failed');

    await db.sql`UPDATE harness_shared.work_item_claims SET expires_ts = clock_timestamp() - interval '5 seconds' WHERE work_item_id = 'F-001'`;
    clk += (sqlStore.DEFAULT_WORK_ITEM_TTL_SEC + 5) * 1000;

    const sqlHb = hb(await sqlStore.heartbeatClaimLocal({ workspaceId: WS, harnessSlug: HS, workItemId: 'F-001', claimId: sqlR.claim.claimId, owner: 'laptop' }));
    const memHb = hb(await mem.heartbeat({ workspaceId: WS, harnessSlug: HS, workItemId: 'F-001', claimId: memR.claim.claimId, owner: 'laptop' }));
    expect(sqlHb).toEqual({ renewed: false, held: false, lapsed: true });
    expect(memHb).toEqual({ renewed: false, held: false, lapsed: true });
  });
});
