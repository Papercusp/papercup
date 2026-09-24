import { describe, expect, it, vi } from 'vitest';
import {
  BlueprintOperationClient,
  type BlueprintOperationPort,
  type TypedBlueprintOperationHandle,
} from './operation-client';

type ConsumerOperations = {
  extract: {
    input: { value: string };
    output: { answer: string };
    signals: { note: { text: string } };
  };
};

const handle: TypedBlueprintOperationHandle<'extract'> = {
  workspaceId: 'consumer-a', harnessSlug: 'neutral-harness',
  receiptId: 7, operationId: 'extract', specificationRevision: 'b'.repeat(64),
  target: { kind: 'work-item', id: 'WI-7' },
};

function port(): BlueprintOperationPort {
  return {
    submit: vi.fn(async () => handle),
    status: vi.fn(async (ref) => ({
      handle: ref, phase: 'accepted' as const, outcome: null, items: [],
      planRun: null, cancellationRequested: false, wait: null,
    })),
    result: vi.fn(async (ref) => ({
      state: 'pending' as const,
      status: { handle: ref, phase: 'accepted' as const, outcome: null, items: [],
        planRun: null, cancellationRequested: false, wait: null },
    })),
    events: vi.fn(async (ref) => ({
      status: { handle: ref, phase: 'accepted' as const, outcome: null, items: [],
        planRun: null, cancellationRequested: false, wait: null },
      events: [], cursor: '0', hasMore: false,
    })),
    cancel: vi.fn(async () => ({ eventId: '1', replayed: false, accepted: true as const,
      wakeQueued: false, handled: false as const, effected: false })),
    signal: vi.fn(async () => ({ eventId: '2', replayed: false, accepted: true as const,
      wakeQueued: false, handled: false as const })),
    resume: vi.fn(async () => ({ eventId: '3', replayed: false, accepted: true as const,
      wakeQueued: false, handled: false as const })),
  };
}

describe('BlueprintOperationClient', () => {
  it('binds typed input and signals to one principal and actual returned handle', async () => {
    const backend = port();
    const client = new BlueprintOperationClient<ConsumerOperations>(backend, {
      workspaceId: 'consumer-a', harnessSlug: 'neutral-harness', callerId: 'principal-a',
    });
    const ref = await client.submit({ operationId: 'extract', input: { value: 'one' }, requestKey: 'one' });
    expect(backend.submit).toHaveBeenCalledWith({
      workspaceId: 'consumer-a', harnessSlug: 'neutral-harness', callerId: 'principal-a',
      operationId: 'extract', input: { value: 'one' }, requestKey: 'one',
    });
    expect((await client.status(ref)).phase).toBe('accepted');
    expect(backend.status).toHaveBeenCalledWith(ref, 'principal-a');
    expect(await client.signal(ref, { channel: 'note', payload: { text: 'continue' }, requestKey: 'note-one' }))
      .toMatchObject({ accepted: true, handled: false });
  });

  it('refuses cross-workspace and cross-harness handles before dispatch', async () => {
    const backend = port();
    const client = new BlueprintOperationClient<ConsumerOperations>(backend, {
      workspaceId: 'consumer-b', harnessSlug: 'neutral-harness', callerId: 'principal-b',
    });
    expect(() => client.status(handle)).toThrow('outside this client scope');
    expect(backend.status).not.toHaveBeenCalled();
    const wrongHarness = { ...handle, workspaceId: 'consumer-b', harnessSlug: 'other-harness' };
    await expect(client.result(wrongHarness)).rejects.toThrow('outside this client scope');
    expect(backend.result).not.toHaveBeenCalled();
  });
});
