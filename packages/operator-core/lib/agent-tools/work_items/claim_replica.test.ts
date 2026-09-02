/**
 * claim_replica.test.ts — the work_items:claim_replica HANDLER reason mapping +
 * result projection (claimReplicaSlot, the slot-lease core, is mocked). This pins the
 * handler's 3-way reason→message mapping a caller reads:
 *   • item-not-found → "<id> not found in harness <h>"
 *   • not-redundant  → "not high-stakes (redundancy=N) — use work_items:claim_next"
 *   • else           → "all N replica slots are held by other Swarms"
 * plus the success projection (reused flag + the replica fields needed to heartbeat /
 * record). A regression that mis-routes a reason or drops a projected field is what
 * this catches.
 *
 * In-tree (operator-core, tab-visible).
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/work_items/claim_replica.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../coordination/identity', () => ({
  resolveAgentIdentity: vi.fn(() => ({ ownerId: 'me', ownerLabel: 'Me' })),
  resolveSelfLiteral: (value: string | undefined, callerOwnerId: string) => (value === 'self' ? callerOwnerId : value),
}));
vi.mock('../../work-item-redundancy', () => ({
  claimReplicaSlot: vi.fn(),
  resolveReplicaPotSlug: vi.fn(async () => 'hive-x'),
}));
vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: vi.fn(() => 'default') }));

import { claimReplicaSlot } from '../../work-item-redundancy';
import type { WorkItemReplica } from '../../work-item-redundancy';
const claimM = vi.mocked(claimReplicaSlot);

/**
 * A complete, TYPED `WorkItemReplica`. These fixtures used to be cast `as never`, which
 * defeats the whole point of `vi.mocked()` — a newly-required field on `WorkItemReplica`
 * became invisible to tsc and failed at runtime in an unrelated peer's checkpoint run
 * (EI-19282401068515102). Overriding only what a test asserts keeps that check live in
 * exactly one place.
 */
const replica = (over: Partial<WorkItemReplica> = {}): WorkItemReplica => ({
  workspaceId: 'default',
  harnessSlug: 'web',
  workItemId: 'F-1',
  replicaIndex: 0,
  redundancy: 2,
  claimId: 'c1',
  owner: 'me',
  ownerLabel: null,
  holderPubkey: null,
  ttlSec: 900,
  acquiredTs: 't0',
  expiresTs: 't1',
  lastActivityTs: 't0',
  status: 'claimed',
  result: null,
  judgeComposite: null,
  judgeRationale: null,
  judgeModel: null,
  rubricHash: null,
  judgeCostUsd: null,
  judgedTs: null,
  expired: false,
  ...over,
});
const tool = (await import('./claim_replica')).default;

type Out = { data: unknown };
const call = () => tool.handler({ id: 'F-1', harness: 'web' } as never, {} as never) as Promise<Out>;
const body = (o: Out) => o.data as any;

beforeEach(() => vi.clearAllMocks());

describe('work_items:claim_replica reason mapping', () => {
  it('item-not-found', async () => {
    claimM.mockResolvedValue({ ok: false, reason: 'item-not-found' } as never);
    const b = body(await call());
    expect(b).toMatchObject({ ok: false, reason: 'item-not-found' });
    expect(String(b.error)).toMatch(/F-1.*not found/i);
  });

  it('not-redundant points to claim_next', async () => {
    claimM.mockResolvedValue({ ok: false, reason: 'not-redundant', redundancy: 1 } as never);
    const b = body(await call());
    expect(String(b.error)).toMatch(/not high-stakes|claim_next/i);
  });

  it('all slots held names the slot count', async () => {
    claimM.mockResolvedValue({ ok: false, reason: 'all-held', redundancy: 3 } as never);
    const b = body(await call());
    expect(String(b.error)).toMatch(/all 3 replica slots/i);
  });
});

describe('work_items:claim_replica success', () => {
  it('resolves owner self to the calling owner id', async () => {
    claimM.mockResolvedValue({ ok: true, reused: false, replica: replica() });
    await tool.handler({ id: 'F-1', harness: 'web', owner: 'self' } as never, {} as never);
    expect((claimM.mock.calls[0]![0] as unknown as Record<string, unknown>).owner).toBe('me');
  });

  it('projects the claimed slot fields', async () => {
    claimM.mockResolvedValue({ ok: true, reused: false, replica: replica() });
    const b = body(await call());
    expect(b).toMatchObject({
      ok: true, reused: false,
      replica: { workItemId: 'F-1', harness: 'web', replicaIndex: 0, redundancy: 2, claimId: 'c1', owner: 'me' },
    });
  });
});
