import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetAuthorityOpsForTests,
  handleAuthorityRpc,
  registeredAuthorityOpKinds,
} from './authority/authority-op-registry';
import {
  registerWorkItemClaimAuthorityOps,
  type WorkItemClaimCoordinator,
} from './work-item-claim-authority-ops';
import { WORK_ITEM_CLAIM_OP_KINDS, type WorkItemClaim, type AcquireResult, type HeartbeatResult } from './work-item-claims';

function fakeClaim(over: Partial<WorkItemClaim> = {}): WorkItemClaim {
  return {
    workspaceId: 'ws', harnessSlug: 'h', workItemId: 'F-001', hiveSlug: 'hive-a',
    claimId: 'cid-1', owner: 'su-a', ownerLabel: null, holderPubkey: 'pk-a', intent: '',
    ttlSec: 1800, acquiredTs: '2026-06-08T12:00:00.000Z', expiresTs: '2026-06-08T12:30:00.000Z',
    lastActivityTs: '2026-06-08T12:00:00.000Z', expired: false, ...over,
  };
}

function makeFake(): { coord: WorkItemClaimCoordinator; calls: Record<string, unknown[]> } {
  const calls: Record<string, unknown[]> = { acquire: [], heartbeat: [], release: [] };
  const coord: WorkItemClaimCoordinator = {
    acquire: vi.fn(async (opts): Promise<AcquireResult> => { calls.acquire.push(opts); return { ok: true, claim: fakeClaim() }; }),
    heartbeat: vi.fn(async (p): Promise<HeartbeatResult> => { calls.heartbeat.push(p); return { renewed: true, held: true, expiresTs: '2026-06-08T12:30:00.000Z' }; }),
    release: vi.fn(async (p): Promise<boolean> => { calls.release.push(p); return true; }),
  };
  return { coord, calls };
}

describe('registerWorkItemClaimAuthorityOps', () => {
  beforeEach(() => __resetAuthorityOpsForTests());
  afterEach(() => __resetAuthorityOpsForTests());

  it('registers the three work-item claim op kinds', () => {
    registerWorkItemClaimAuthorityOps(makeFake().coord);
    expect(registeredAuthorityOpKinds()).toEqual(
      [WORK_ITEM_CLAIM_OP_KINDS.acquire, WORK_ITEM_CLAIM_OP_KINDS.heartbeat, WORK_ITEM_CLAIM_OP_KINDS.release].sort(),
    );
  });

  it('is idempotent — a second register is a no-op (no duplicate-kind throw)', () => {
    const { coord } = makeFake();
    registerWorkItemClaimAuthorityOps(coord);
    expect(() => registerWorkItemClaimAuthorityOps(coord)).not.toThrow();
    expect(registeredAuthorityOpKinds()).toHaveLength(3);
  });

  it('routes a valid acquire envelope to the coordinator + returns its result', async () => {
    const { coord, calls } = makeFake();
    registerWorkItemClaimAuthorityOps(coord);
    const payload = { workspaceId: 'ws', harnessSlug: 'h', workItemId: 'F-001', owner: 'su-a', hiveSlug: 'hive-a', holderPubkey: 'pk-a' };
    const res = await handleAuthorityRpc({ harnessSlug: 'hive-a', kind: WORK_ITEM_CLAIM_OP_KINDS.acquire, payload });
    expect(res.ok).toBe(true);
    expect((res.result as { ok: boolean }).ok).toBe(true);
    expect(calls.acquire).toHaveLength(1);
    expect(calls.acquire[0]).toMatchObject({ workItemId: 'F-001', owner: 'su-a' });
  });

  it('routes heartbeat + release envelopes', async () => {
    const { coord, calls } = makeFake();
    registerWorkItemClaimAuthorityOps(coord);
    const base = { workspaceId: 'ws', harnessSlug: 'h', workItemId: 'F-001', claimId: 'cid-1', owner: 'su-a' };
    const hb = await handleAuthorityRpc({ harnessSlug: 'hive-a', kind: WORK_ITEM_CLAIM_OP_KINDS.heartbeat, payload: base });
    expect(hb.ok).toBe(true);
    expect((hb.result as { renewed: boolean }).renewed).toBe(true);
    const rel = await handleAuthorityRpc({ harnessSlug: 'hive-a', kind: WORK_ITEM_CLAIM_OP_KINDS.release, payload: base });
    expect(rel.ok).toBe(true);
    expect(rel.result).toBe(true);
    expect(calls.heartbeat).toHaveLength(1);
    expect(calls.release).toHaveLength(1);
  });

  it('rejects an invalid payload as a handler_error (missing required fields)', async () => {
    registerWorkItemClaimAuthorityOps(makeFake().coord);
    const res = await handleAuthorityRpc({ harnessSlug: 'hive-a', kind: WORK_ITEM_CLAIM_OP_KINDS.acquire, payload: { workspaceId: 'ws' } });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('handler_error');
    expect(res.message).toMatch(/invalid payload/);
  });

  it('an unknown kind returns unknown_kind (not registered here)', async () => {
    registerWorkItemClaimAuthorityOps(makeFake().coord);
    const res = await handleAuthorityRpc({ harnessSlug: 'hive-a', kind: 'work-item.claim.bogus', payload: {} });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('unknown_kind');
  });
});

describe('caller-standing gate (EI-284)', () => {
  beforeEach(() => __resetAuthorityOpsForTests());
  afterEach(() => __resetAuthorityOpsForTests());

  const payload = {
    workspaceId: 'ws', harnessSlug: 'h', workItemId: 'F-001', owner: 'su-b',
    hiveSlug: 'hive-a', holderPubkey: 'pk-revoked',
  };

  it('REFUSES a revoked caller’s acquire with refused:caller_revoked — coordinator never runs', async () => {
    const { coord, calls } = makeFake();
    registerWorkItemClaimAuthorityOps(coord, { isCallerRevoked: async (pk) => pk === 'pk-revoked' });
    const res = await handleAuthorityRpc({ harnessSlug: 'hive-a', kind: WORK_ITEM_CLAIM_OP_KINDS.acquire, payload });
    expect(res.ok).toBe(true); // the RPC dispatched — the REFUSAL is the result
    const out = res.result as AcquireResult & { refused?: string };
    expect(out.ok).toBe(false);
    expect(out.refused).toBe('caller_revoked');
    expect(calls.acquire).toHaveLength(0);
  });

  it('REFUSES a revoked caller’s heartbeat (reason caller_revoked) — a zombie cannot extend its lease', async () => {
    const { coord, calls } = makeFake();
    registerWorkItemClaimAuthorityOps(coord, { isCallerRevoked: async (pk) => pk === 'pk-revoked' });
    const res = await handleAuthorityRpc({
      harnessSlug: 'hive-a',
      kind: WORK_ITEM_CLAIM_OP_KINDS.heartbeat,
      payload: { ...payload, claimId: 'cid-9' },
    });
    const out = res.result as HeartbeatResult;
    expect(out).toMatchObject({ renewed: false, held: false, reason: 'caller_revoked' });
    expect(calls.heartbeat).toHaveLength(0);
  });

  it('release is NOT gated — a revoked holder relinquishing its lease is allowed', async () => {
    const { coord, calls } = makeFake();
    registerWorkItemClaimAuthorityOps(coord, { isCallerRevoked: async () => true });
    const res = await handleAuthorityRpc({
      harnessSlug: 'hive-a',
      kind: WORK_ITEM_CLAIM_OP_KINDS.release,
      payload: { ...payload, claimId: 'cid-9' },
    });
    expect(res.result).toBe(true);
    expect(calls.release).toHaveLength(1);
  });

  it('a payload WITHOUT a holderPubkey skips the check (no identity to judge — fail-open)', async () => {
    const { coord, calls } = makeFake();
    const seen: string[] = [];
    registerWorkItemClaimAuthorityOps(coord, {
      isCallerRevoked: async (pk) => { seen.push(pk); return true; },
    });
    const { holderPubkey: _hp, ...noPubkey } = payload;
    const res = await handleAuthorityRpc({ harnessSlug: 'hive-a', kind: WORK_ITEM_CLAIM_OP_KINDS.acquire, payload: noPubkey });
    expect((res.result as AcquireResult).ok).toBe(true);
    expect(seen).toEqual([]);
    expect(calls.acquire).toHaveLength(1);
  });

  it('a THROWING standing check fails open at the default layer contract (gate errors never wedge claims)', async () => {
    // The default check catches internally; a custom checker that throws surfaces
    // as handler_error rather than a silent grant — pin BOTH behaviors.
    const { coord } = makeFake();
    registerWorkItemClaimAuthorityOps(coord, {
      isCallerRevoked: async () => { throw new Error('standing store down'); },
    });
    const res = await handleAuthorityRpc({ harnessSlug: 'hive-a', kind: WORK_ITEM_CLAIM_OP_KINDS.acquire, payload });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('handler_error');
  });

  it('a clean caller passes through to the coordinator untouched', async () => {
    const { coord, calls } = makeFake();
    registerWorkItemClaimAuthorityOps(coord, { isCallerRevoked: async (pk) => pk === 'someone-else' });
    const res = await handleAuthorityRpc({ harnessSlug: 'hive-a', kind: WORK_ITEM_CLAIM_OP_KINDS.acquire, payload });
    expect((res.result as AcquireResult).ok).toBe(true);
    expect(calls.acquire).toHaveLength(1);
  });
});
