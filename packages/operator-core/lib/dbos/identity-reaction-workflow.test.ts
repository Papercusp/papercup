/**
 * identity-reaction-workflow.test.ts — the identity reaction's durable executor
 * and its enqueue (P-018; D-027 §5, D-029 §5/§6).
 *
 * DBOS is mocked as in durable-spawn.test.ts: registerWorkflow returns the impl,
 * runStep runs its body, startWorkflow is a spy. We assert: the in-process
 * start where DBOS runs, the DBOSClient enqueue where it does not (the request
 * workers), receipt-keyed workflow and dedup ids, `unavailable` only when no
 * enqueue was attempted, and fail-closed on an uncertain enqueue. The workflow
 * body records `failed` / authorization-unavailable when its step exhausts its
 * retries, and records nothing on success.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  startWorkflow: vi.fn((_wf: unknown, _opts: unknown) => (_input: unknown) => Promise.resolve()),
  isInStep: vi.fn(() => false),
  runStep: vi.fn((fn: () => unknown, _opts?: unknown) => fn()),
  execute: vi.fn(async (_payload: unknown) => ({ status: 'fired', tool: 't' }) as unknown),
  settle: vi.fn(async (..._args: unknown[]) => true),
  state: { dbosOn: true, dbosStarted: true },
}));

vi.mock('@dbos-inc/dbos-sdk', () => {
  class WorkflowQueue {
    constructor(public name: string, public opts?: unknown) {}
  }
  return {
    WorkflowQueue,
    DBOS: {
      runStep: h.runStep,
      registerWorkflow: (impl: unknown) => impl,
      startWorkflow: h.startWorkflow,
      isInStep: h.isInStep,
    },
  };
});
vi.mock('./dbos-flags', () => ({ dbosOrchestratorActive: () => h.state.dbosOn }));
vi.mock('./bootstrap', () => ({ dbosStarted: () => h.state.dbosStarted }));
vi.mock('./primary-dbos-client', () => ({
  primaryDbosAppVersion: () => 'bg-host-v1',
  getPrimaryDbosClient: () => Promise.reject(new Error('no primary in unit tests')),
}));
vi.mock('../events/identity-reaction', () => ({
  executeIdentityReaction: h.execute,
  settleIdentityReceipt: h.settle,
}));
vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await orig<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: 'the-sql' }),
}));

import type { IdentityReactionPayload } from '../events/identity-reaction';
import {
  enqueueIdentityReaction,
  IDENTITY_REACTION_WORKFLOW_NAME,
  IdentityReactionEnqueueUncertainError,
  identityReactionWorkflow,
  type IdentityReactionRemoteClient,
} from './identity-reaction-workflow';

const PAYLOAD: IdentityReactionPayload = {
  receiptId: 'identity-reaction:demo.fired@1#1:su-1:aaaaaaaaaaaaaaaa:file-task',
  workspaceId: 'ws-1', ownerId: 'su-1', revisionTag: 'a'.repeat(16), pinRef: 'file-task',
  subscriberId: 'identity-rule:su-1@aaaaaaaaaaaaaaaa:file-task', eventKey: 'demo.fired',
  fireId: 'demo.fired@1#1', eventPayload: { kind: 'bug' },
};

function remote(over: Partial<IdentityReactionRemoteClient> = {}) {
  const client = {
    enqueue: vi.fn(async (_opts: unknown, _input: unknown): Promise<unknown> => ({})),
    getWorkflow: vi.fn(async (_id: string): Promise<unknown | undefined> => undefined),
    ...over,
  };
  return { client, remoteClient: async () => client as IdentityReactionRemoteClient };
}

beforeEach(() => {
  h.state.dbosOn = true;
  h.state.dbosStarted = true;
  h.isInStep.mockReset().mockReturnValue(false);
  h.startWorkflow.mockReset().mockImplementation((_wf, _opts) => (_input) => Promise.resolve());
  h.runStep.mockReset().mockImplementation((fn: () => unknown) => fn());
  h.execute.mockReset().mockResolvedValue({ status: 'fired', tool: 't' });
  h.settle.mockReset().mockResolvedValue(true);
});

describe('enqueueIdentityReaction', () => {
  it('is unavailable, with nothing attempted, when the DBOS orchestrator is off', async () => {
    h.state.dbosOn = false;
    const { client, remoteClient } = remote();
    await expect(enqueueIdentityReaction(PAYLOAD, { remoteClient })).resolves.toBe('unavailable');
    expect(h.startWorkflow).not.toHaveBeenCalled();
    expect(client.enqueue).not.toHaveBeenCalled();
  });

  it('starts the workflow in-process where DBOS runs, keyed and deduplicated by the receipt id', async () => {
    const { client, remoteClient } = remote();
    await expect(enqueueIdentityReaction(PAYLOAD, { remoteClient })).resolves.toBe('enqueued');
    expect(h.startWorkflow).toHaveBeenCalledTimes(1);
    expect(h.startWorkflow.mock.calls[0]![1]).toEqual({
      workflowID: PAYLOAD.receiptId,
      queueName: 'identity-reactions',
      enqueueOptions: { deduplicationID: PAYLOAD.receiptId },
      duplicationPolicy: 'return-existing',
    });
    expect(client.enqueue).not.toHaveBeenCalled();
  });

  it('enqueues through the primary DBOSClient from a host that does not run DBOS (the request workers)', async () => {
    h.state.dbosStarted = false;
    const { client, remoteClient } = remote();
    await expect(enqueueIdentityReaction(PAYLOAD, { remoteClient })).resolves.toBe('enqueued');
    expect(h.startWorkflow).not.toHaveBeenCalled();
    expect(client.enqueue).toHaveBeenCalledWith({
      queueName: 'identity-reactions',
      workflowName: IDENTITY_REACTION_WORKFLOW_NAME,
      workflowID: PAYLOAD.receiptId,
      deduplicationID: PAYLOAD.receiptId,
      duplicationPolicy: 'return-existing',
      appVersion: 'bg-host-v1',
    }, PAYLOAD);
  });

  it('uses the client inside a DBOS step, where startWorkflow is not allowed', async () => {
    h.isInStep.mockReturnValue(true);
    const { client, remoteClient } = remote();
    await expect(enqueueIdentityReaction(PAYLOAD, { remoteClient })).resolves.toBe('enqueued');
    expect(h.startWorkflow).not.toHaveBeenCalled();
    expect(client.enqueue).toHaveBeenCalledTimes(1);
  });

  it('is unavailable when no client can be created (no enqueue was attempted)', async () => {
    h.state.dbosStarted = false;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(enqueueIdentityReaction(PAYLOAD, {
      remoteClient: () => Promise.reject(new Error('system db unreachable')),
    })).resolves.toBe('unavailable');
    warn.mockRestore();
  });

  it('confirms a client enqueue whose response was lost by reading the workflow back', async () => {
    h.state.dbosStarted = false;
    const { remoteClient } = remote({
      enqueue: vi.fn(async () => { throw new Error('socket hang up'); }),
      getWorkflow: vi.fn(async () => ({ workflowID: PAYLOAD.receiptId })),
    });
    await expect(enqueueIdentityReaction(PAYLOAD, { remoteClient })).resolves.toBe('enqueued');
  });

  it('throws, never reports unavailable, when an attempted client enqueue cannot be confirmed', async () => {
    h.state.dbosStarted = false;
    const { remoteClient } = remote({ enqueue: vi.fn(async () => { throw new Error('socket hang up'); }) });
    await expect(enqueueIdentityReaction(PAYLOAD, { remoteClient })).rejects.toBeInstanceOf(IdentityReactionEnqueueUncertainError);
  });

  it('throws when an in-process start fails and the workflow cannot be read back', async () => {
    h.startWorkflow.mockImplementation(() => { throw new Error('queue write failed'); });
    const { remoteClient } = remote();
    await expect(enqueueIdentityReaction(PAYLOAD, { remoteClient })).rejects.toBeInstanceOf(IdentityReactionEnqueueUncertainError);
  });

  it('confirms an in-process start that threw after the row committed', async () => {
    h.startWorkflow.mockImplementation(() => { throw new Error('lost ack'); });
    const { remoteClient } = remote({ getWorkflow: vi.fn(async () => ({ workflowID: PAYLOAD.receiptId })) });
    await expect(enqueueIdentityReaction(PAYLOAD, { remoteClient })).resolves.toBe('enqueued');
  });
});

describe('identityReaction workflow', () => {
  const run = identityReactionWorkflow as unknown as (payload: IdentityReactionPayload) => Promise<void>;

  it('runs the reaction in one retried step and records nothing else on success', async () => {
    await run(PAYLOAD);
    expect(h.execute).toHaveBeenCalledWith(PAYLOAD);
    expect(h.runStep).toHaveBeenCalledTimes(1);
    expect(h.runStep.mock.calls[0]![1]).toMatchObject({ retriesAllowed: true, maxAttempts: 3 });
    expect(h.settle).not.toHaveBeenCalled();
  });

  it('records failed / authorization-unavailable once the step exhausts its retries — never a grant', async () => {
    h.execute.mockRejectedValue(new Error('connection reset'));
    await run(PAYLOAD);
    expect(h.settle).toHaveBeenCalledWith('the-sql', PAYLOAD.receiptId, {
      status: 'failed', error: 'authorization-unavailable: connection reset',
    });
  });
});
