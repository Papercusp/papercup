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
}));
vi.mock('../../work-item-redundancy', () => ({
  claimReplicaSlot: vi.fn(),
  resolveReplicaHiveSlug: vi.fn(async () => 'hive-x'),
}));
vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: vi.fn(() => 'default') }));

import { claimReplicaSlot } from '../../work-item-redundancy';
const claimM = vi.mocked(claimReplicaSlot);
const tool = (await import('./claim_replica')).default;

type Out = { content: { text: string }[] };
const call = () => tool.handler({ id: 'F-1', harness: 'web' } as never, {} as never) as Promise<Out>;
const body = (o: Out) => JSON.parse(o.content[0]!.text);

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
  it('projects the claimed slot fields', async () => {
    claimM.mockResolvedValue({
      ok: true, reused: false,
      replica: { workItemId: 'F-1', harnessSlug: 'web', replicaIndex: 0, redundancy: 2, claimId: 'c1', owner: 'me', expiresTs: 't1' },
    } as never);
    const b = body(await call());
    expect(b).toMatchObject({
      ok: true, reused: false,
      replica: { workItemId: 'F-1', harness: 'web', replicaIndex: 0, redundancy: 2, claimId: 'c1', owner: 'me' },
    });
  });
});
