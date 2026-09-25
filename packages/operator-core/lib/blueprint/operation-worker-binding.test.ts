import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getWorkItem, readAcceptedBlueprintDirectWorkItem, getIdentitySource } = vi.hoisted(() => ({
  getWorkItem: vi.fn(),
  readAcceptedBlueprintDirectWorkItem: vi.fn(),
  getIdentitySource: vi.fn(),
}));
vi.mock('../work-items', () => ({ getWorkItem }));
vi.mock('./operation-admission', () => ({ readAcceptedBlueprintDirectWorkItem }));
vi.mock('../agent-identities/source', () => ({ getIdentitySource }));
vi.mock('../workspace-als', () => ({ runWithWorkspace: (_workspace: string, run: () => unknown) => run() }));

import { matchOperationWorkerClaim, resolveAcceptedOperationWorkerBinding } from './operation-worker-binding';

const HASH = 'a'.repeat(64);
const REVISION = 'b'.repeat(64);
const args = {
  sql: {} as never,
  workspaceId: 'ws-a',
  harnessSlug: 'harness-a',
  workItemId: 'WI-1',
  role: 'worker',
  repoDir: '/repo/harness-a',
};
const item = { id: 'WI-1', harness: 'harness-a', payload: { blueprintOperation: { kind: 'blueprint-operation' } } };
const pin = { operationId: 'run', specificationRevision: REVISION };
const operation = {
  execution: { kind: 'agent', role: 'worker' },
  policy: {
    identity: { kind: 'identity', ref: 'blueprint-operation-worker', revision: '0.1.0', contentHash: HASH },
    requiredTools: ['work_items:get', 'coord:orient', 'work_items:get'],
  },
};
const source = {
  ok: true,
  sourcePath: '/repo/blueprint-operation-worker/blueprint.yaml',
  identity: { id: 'blueprint-operation-worker', version: '0.1.0', slots: [{ slot: 'domain' }], grants: {} },
  contentHash: HASH,
};

beforeEach(() => {
  vi.resetAllMocks();
  getWorkItem.mockResolvedValue(item);
  readAcceptedBlueprintDirectWorkItem.mockResolvedValue({ pin, operation });
  getIdentitySource.mockResolvedValue(source);
});

describe('accepted blueprint operation worker binding', () => {
  it('derives the exact identity and tool set from the accepted item', async () => {
    const binding = await resolveAcceptedOperationWorkerBinding(args);
    expect(binding).toEqual({
      workItemId: 'WI-1', harnessSlug: 'harness-a', operationId: 'run', specificationRevision: REVISION,
      identity: { ref: 'blueprint-operation-worker', revision: '0.1.0', contentHash: HASH },
      stack: ['domain:blueprint-operation-worker'],
      requiredTools: ['coord:orient', 'work_items:get'],
    });
    expect(getIdentitySource).toHaveBeenCalledWith('blueprint-operation-worker', { repoDir: '/repo/harness-a' });
  });

  it('matches only the exact pinned item for an active worker', () => {
    const binding = {
      workItemId: 'WI-1', harnessSlug: 'harness-a', operationId: 'run', specificationRevision: REVISION,
      identity: { ref: 'blueprint-operation-worker', revision: '0.1.0', contentHash: HASH },
      stack: ['domain:blueprint-operation-worker'], requiredTools: ['work_items:get'],
    };
    const pinned = { id: 'WI-1', harness: 'harness-a', payload: { blueprintOperation: {
      kind: 'blueprint-operation', harnessSlug: 'harness-a', operationId: 'run', specificationRevision: REVISION,
    } } };
    const read = { status: 'bound' as const, binding, receipt: {
      sessionId: 1, workspaceId: 'ws-a', ownerId: 'worker-a',
      specificationRevision: HASH, stateRevision: 'state-a', acceptedOperation: {},
    } };
    expect(matchOperationWorkerClaim(read, pinned)).toEqual({ allowed: true });
    expect(matchOperationWorkerClaim(read, { ...pinned, id: 'WI-2' }).allowed).toBe(false);
    expect(matchOperationWorkerClaim(read, { ...pinned, harness: 'harness-b' }).allowed).toBe(false);
    expect(matchOperationWorkerClaim(read, { ...pinned, payload: {} }).allowed).toBe(false);
    expect(matchOperationWorkerClaim(read, { ...pinned, payload: {
      blueprintOperation: { ...pinned.payload.blueprintOperation, specificationRevision: 'c'.repeat(64) },
    } }).allowed).toBe(false);
    expect(matchOperationWorkerClaim({ status: 'none' }, pinned).allowed).toBe(false);
    expect(matchOperationWorkerClaim({ status: 'none' }, { ...pinned, payload: {} })).toEqual({ allowed: true });
    expect(matchOperationWorkerClaim({ status: 'unavailable', reason: 'ended' }, pinned).allowed).toBe(false);
    expect(matchOperationWorkerClaim({ status: 'unavailable', reason: 'ended' }, { ...pinned, payload: {} }).allowed).toBe(false);
  });

  it('leaves ordinary work items on their existing role launch path', async () => {
    getWorkItem.mockResolvedValue({ ...item, payload: {} });
    expect(await resolveAcceptedOperationWorkerBinding(args)).toBeNull();
    expect(readAcceptedBlueprintDirectWorkItem).not.toHaveBeenCalled();
  });

  it('refuses a different role or harness', async () => {
    await expect(resolveAcceptedOperationWorkerBinding({ ...args, role: 'reviewer' }))
      .rejects.toThrow('does not authorize this worker role');
    getWorkItem.mockResolvedValue({ ...item, harness: 'harness-b' });
    await expect(resolveAcceptedOperationWorkerBinding(args)).rejects.toThrow('in its harness');
  });

  it('refuses a moved identity source or a changed source version', async () => {
    getIdentitySource.mockResolvedValue({ ...source, contentHash: 'c'.repeat(64) });
    await expect(resolveAcceptedOperationWorkerBinding(args)).rejects.toThrow('differs from its pinned revision');
    getIdentitySource.mockResolvedValue({ ...source, identity: { ...source.identity, version: '0.2.0' } });
    await expect(resolveAcceptedOperationWorkerBinding(args)).rejects.toThrow('differs from its pinned revision');
  });

  it('refuses an unpinned identity or a multi-slot worker identity', async () => {
    readAcceptedBlueprintDirectWorkItem.mockResolvedValue({ pin, operation: {
      ...operation, policy: { ...operation.policy, identity: undefined },
    } });
    await expect(resolveAcceptedOperationWorkerBinding(args)).rejects.toThrow('no pinned worker identity');
    readAcceptedBlueprintDirectWorkItem.mockResolvedValue({ pin, operation });
    getIdentitySource.mockResolvedValue({ ...source, identity: {
      ...source.identity, slots: [{ slot: 'domain' }, { slot: 'practice' }],
    } });
    await expect(resolveAcceptedOperationWorkerBinding(args)).rejects.toThrow('exactly the domain slot');
    getIdentitySource.mockResolvedValue({ ...source, identity: { ...source.identity, grants: undefined } });
    await expect(resolveAcceptedOperationWorkerBinding(args)).rejects.toThrow('declare grants explicitly');
  });
});
