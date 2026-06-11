/**
 * work-item-replica-authority-ops.test.ts — the AUTHORITY (receiving) side of the
 * redundancy-replica RPC (EI-266). Proves that an inbound op envelope for each
 * replica kind dispatches to the matching `*Local` store fn on THIS (the
 * authority's) machine — which is what makes the N cross-swarm replicas land in
 * ONE store and the judge see them all.
 *
 * The `*Local` store fns are mocked (they are unit-tested for real against PG in
 * work-item-redundancy.integration.test.ts); here we lock the kind→fn WIRING + the
 * payload coercion, with no PG.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./work-item-redundancy', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./work-item-redundancy')>();
  return {
    ...actual, // keep WORK_ITEM_REPLICA_OP_KINDS + the enums
    claimReplicaSlotLocal: vi.fn(async () => ({ ok: true, reused: false, replica: { replicaIndex: 0 } })),
    heartbeatReplicaLocal: vi.fn(async () => ({ renewed: true, held: true, expiresTs: 't' })),
    releaseReplicaLocal: vi.fn(async () => true),
    recordReplicaResultLocal: vi.fn(async () => ({ status: 'complete' })),
    listReplicasLocal: vi.fn(async () => [{ replicaIndex: 0 }, { replicaIndex: 1 }]),
    judgeRedundancyGroupLocal: vi.fn(async () => ({ ok: true, winner: { replicaIndex: 1 } })),
  };
});

const redundancy = await import('./work-item-redundancy');
const { handleAuthorityRpc, __resetAuthorityOpsForTests, registeredAuthorityOpKinds } = await import(
  './authority/authority-op-registry'
);
const { registerWorkItemReplicaAuthorityOps } = await import('./work-item-replica-authority-ops');
const K = redundancy.WORK_ITEM_REPLICA_OP_KINDS;

const fakeJudge = vi.fn(async () => ({ text: '{}', costUsd: 0, inputTokens: 0, outputTokens: 0 }));

beforeEach(() => {
  __resetAuthorityOpsForTests();
  vi.clearAllMocks();
  registerWorkItemReplicaAuthorityOps({ judgeLlmCall: fakeJudge as never });
});
afterEach(() => __resetAuthorityOpsForTests());

const baseScope = { workspaceId: 'ws', harnessSlug: 'h', hiveSlug: 'hive-a', workItemId: 'WI-1', owner: 'swarm-a' };

describe('registerWorkItemReplicaAuthorityOps', () => {
  it('registers all six replica op kinds (idempotent — a second call is a no-op)', () => {
    const kinds = registeredAuthorityOpKinds();
    for (const k of Object.values(K)) expect(kinds).toContain(k);
    expect(() => registerWorkItemReplicaAuthorityOps()).not.toThrow();
  });

  it('claim-slot dispatches to claimReplicaSlotLocal with the coerced payload', async () => {
    const res = await handleAuthorityRpc({ harnessSlug: 'h', kind: K.claimSlot, payload: { ...baseScope, ttlSec: 60 } });
    expect(res.ok).toBe(true);
    expect(redundancy.claimReplicaSlotLocal).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 'ws', harnessSlug: 'h', hiveSlug: 'hive-a', workItemId: 'WI-1', owner: 'swarm-a', ttlSec: 60 }),
    );
  });

  it('heartbeat + release dispatch to their Local fns with the lease params', async () => {
    const lease = { ...baseScope, replicaIndex: 0, claimId: 'cid' };
    await handleAuthorityRpc({ harnessSlug: 'h', kind: K.heartbeat, payload: lease });
    await handleAuthorityRpc({ harnessSlug: 'h', kind: K.release, payload: lease });
    expect(redundancy.heartbeatReplicaLocal).toHaveBeenCalledWith(expect.objectContaining({ replicaIndex: 0, claimId: 'cid' }));
    expect(redundancy.releaseReplicaLocal).toHaveBeenCalledWith(expect.objectContaining({ replicaIndex: 0, claimId: 'cid' }));
  });

  it('record-result dispatches with the result payload', async () => {
    const res = await handleAuthorityRpc({
      harnessSlug: 'h',
      kind: K.recordResult,
      payload: { ...baseScope, replicaIndex: 1, result: { text: 'done' } },
    });
    expect(res.ok).toBe(true);
    expect(redundancy.recordReplicaResultLocal).toHaveBeenCalledWith(
      expect.objectContaining({ replicaIndex: 1, result: { text: 'done' } }),
    );
  });

  it('list dispatches to listReplicasLocal(workItemId, opts)', async () => {
    const res = await handleAuthorityRpc({ harnessSlug: 'h', kind: K.list, payload: { workItemId: 'WI-1', harness: 'h', workspaceId: 'ws', hiveSlug: 'hive-a' } });
    expect(res.ok).toBe(true);
    expect(res.result).toHaveLength(2);
    expect(redundancy.listReplicasLocal).toHaveBeenCalledWith('WI-1', expect.objectContaining({ harness: 'h', workspaceId: 'ws' }));
  });

  it('judge dispatches to judgeRedundancyGroupLocal with the AUTHORITY grader (not the caller’s)', async () => {
    const res = await handleAuthorityRpc({ harnessSlug: 'h', kind: K.judge, payload: { workItemId: 'WI-1', harness: 'h', workspaceId: 'ws', hiveSlug: 'hive-a' } });
    expect(res.ok).toBe(true);
    expect(redundancy.judgeRedundancyGroupLocal).toHaveBeenCalledWith(
      expect.objectContaining({ workItemId: 'WI-1', harness: 'h' }),
      expect.objectContaining({ llmCall: fakeJudge }), // the authority's grader, supplied by the op registration
    );
  });

  it('rejects a malformed payload with handler_error (validation), never throws', async () => {
    const res = await handleAuthorityRpc({ harnessSlug: 'h', kind: K.claimSlot, payload: { harnessSlug: 'h' } }); // missing workItemId/owner
    expect(res.ok).toBe(false);
    expect(res.error).toBe('handler_error');
    expect(res.message).toMatch(/workItemId|owner/);
  });
});
