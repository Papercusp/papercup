import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getWorkItem, readAcceptedBlueprintDirectWorkItem, getIdentitySource, sqlMock } = vi.hoisted(() => ({
  getWorkItem: vi.fn(),
  readAcceptedBlueprintDirectWorkItem: vi.fn(),
  getIdentitySource: vi.fn(),
  sqlMock: vi.fn(),
}));
vi.mock('@papercusp/db-org', () => ({ getOrgPg: () => ({ sql: sqlMock }) }));
vi.mock('../work-items', () => ({ getWorkItem }));
vi.mock('./operation-admission', () => ({ readAcceptedBlueprintDirectWorkItem }));
vi.mock('../agent-identities/source', () => ({ getIdentitySource }));
vi.mock('../workspace-als', () => ({ runWithWorkspace: (_workspace: string, run: () => unknown) => run() }));

import { matchOperationWorkerClaim, readActiveOperationModelPolicy, resolveAcceptedOperationWorkerBinding, selectAcceptedOperationWorkerModel } from './operation-worker-binding';

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
const pin = { kind: 'blueprint-operation' as const, harnessSlug: 'harness-a',
  operationId: 'run', specificationRevision: REVISION, operationVersion: '1.0.0', input: {} };
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
      pin,
      identity: { ref: 'blueprint-operation-worker', revision: '0.1.0', contentHash: HASH },
      stack: ['domain:blueprint-operation-worker'],
      requiredTools: ['coord:orient', 'work_items:get'],
    });
    expect(getIdentitySource).toHaveBeenCalledWith('blueprint-operation-worker', { repoDir: '/repo/harness-a' });
  });

  it('matches only the exact pinned item for an active worker', () => {
    const binding = {
      workItemId: 'WI-1', harnessSlug: 'harness-a', operationId: 'run', specificationRevision: REVISION,
      pin,
      identity: { ref: 'blueprint-operation-worker', revision: '0.1.0', contentHash: HASH },
      stack: ['domain:blueprint-operation-worker'], requiredTools: ['work_items:get'],
    };
    const pinned = { id: 'WI-1', harness: 'harness-a', payload: { blueprintOperation: pin } };
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
    expect(matchOperationWorkerClaim(read, { ...pinned, payload: {
      blueprintOperation: { ...pin, input: { changed: true } },
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

  it('pins an accepted exact model and refuses an incompatible launch selector', async () => {
    readAcceptedBlueprintDirectWorkItem.mockResolvedValue({ pin, operation: {
      ...operation, policy: { ...operation.policy,
        model: { mode: 'exact', models: ['anthropic/claude-opus-4-8'], onUnavailable: 'fail' },
      },
    } });
    const binding = await resolveAcceptedOperationWorkerBinding(args);
    expect(binding?.modelPolicy).toEqual({
      mode: 'exact', models: ['anthropic/claude-opus-4-8'], onUnavailable: 'fail',
    });
    expect(selectAcceptedOperationWorkerModel(binding, 'claude-opus-4-8', 'claude')).toEqual({
      model: 'claude-opus-4-8', requestedModel: 'claude-opus-4-8',
      backend: 'claude', source: 'operation-policy',
    });
    expect(() => selectAcceptedOperationWorkerModel(binding, 'claude-sonnet-4-6', 'claude'))
      .toThrow('outside the accepted exact model policy');
    expect(() => selectAcceptedOperationWorkerModel(binding, 'openai-codex/claude-opus-4-8', 'claude'))
      .toThrow('outside the accepted exact model policy');
  });

  it('selects only listed allowed/preferred models and preserves required effort', () => {
    const binding = {
      workItemId: 'WI-1', harnessSlug: 'harness-a', operationId: 'run', specificationRevision: REVISION,
      pin, identity: { ref: 'blueprint-operation-worker', revision: '0.1.0', contentHash: HASH },
      stack: ['domain:blueprint-operation-worker'], requiredTools: [],
      modelPolicy: { mode: 'allowed' as const, models: ['gpt-5.6-terra', 'gpt-5.6-sol'],
        effort: 'high', onUnavailable: 'wait' as const },
    };
    expect(selectAcceptedOperationWorkerModel(binding, null, 'codex')?.model).toBe('gpt-5.6-terra:high');
    expect(selectAcceptedOperationWorkerModel(binding, 'sol:high', 'codex')?.model).toBe('gpt-5.6-sol:high');
    expect(() => selectAcceptedOperationWorkerModel(binding, 'gpt-5.6-luna:high', 'codex'))
      .toThrow('outside the accepted allowed model policy');
    expect(() => selectAcceptedOperationWorkerModel(binding, 'sol:low', 'codex'))
      .toThrow('reasoning effort differs');
    expect(selectAcceptedOperationWorkerModel({ ...binding,
      modelPolicy: { ...binding.modelPolicy, mode: 'preferred' },
    }, null, 'codex')?.model).toBe('gpt-5.6-terra:high');
    expect(selectAcceptedOperationWorkerModel({ ...binding, modelPolicy: undefined }, 'gpt-5.6-luna', 'codex')).toBeNull();
  });

  it('checks the active launch receipt against the immutable accepted model policy', async () => {
    const modelPolicy = { mode: 'exact' as const, models: ['claude-opus-4'], onUnavailable: 'fail' as const };
    const modelSelection = { model: 'claude-opus-4', requestedModel: null,
      backend: 'claude' as const, source: 'operation-policy' as const };
    const accepted = {
      kind: 'blueprint-operation-worker', workItemId: 'WI-1', operationId: 'run',
      specificationRevision: REVISION, pin,
      identity: { ref: 'blueprint-operation-worker', revision: '0.1.0', contentHash: HASH },
      requiredTools: ['work_items:get'], modelPolicy, modelSelection,
    };
    const revision = { specificationRevision: HASH, stateRevision: 'state-a' };
    const row = {
      accepted_operation: accepted, launch_workspace_id: 'ws-a', launch_harness_slug: 'harness-a',
      launch_role: 'worker', specification_revision: HASH, state_revision: 'state-a',
      grants_kind: 'object', activation: {
        schemaVersion: 1, status: 'applied', attribution: {
          actorId: 'worker-a', principalId: 'system:superuser', sessionId: 'worker-a',
        }, desired: revision, prepared: null, applied: revision,
      },
    };
    sqlMock.mockImplementation((strings: TemplateStringsArray) =>
      strings.join('').includes('SELECT id, role') ? [{ id: 7, role: 'worker' }] : [row]);
    readAcceptedBlueprintDirectWorkItem.mockResolvedValue({ pin, operation: {
      ...operation, id: 'run', policy: { ...operation.policy, model: modelPolicy },
    } });
    expect(await readActiveOperationModelPolicy('ws-a', 'worker-a')).toEqual({ status: 'bound', policy: modelPolicy });

    row.accepted_operation = { ...accepted, modelPolicy: { ...modelPolicy, models: ['claude-sonnet-4-6'] } };
    expect(await readActiveOperationModelPolicy('ws-a', 'worker-a')).toEqual({
      status: 'unavailable', reason: 'accepted operation model policy differs from its launch receipt',
    });
    row.accepted_operation = accepted;
    readAcceptedBlueprintDirectWorkItem.mockResolvedValueOnce({ pin: { ...pin, input: { changed: true } },
      operation: { ...operation, id: 'run', policy: { ...operation.policy, model: modelPolicy } } });
    expect(await readActiveOperationModelPolicy('ws-a', 'worker-a')).toEqual({
      status: 'unavailable', reason: 'accepted operation model pin changed',
    });
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
