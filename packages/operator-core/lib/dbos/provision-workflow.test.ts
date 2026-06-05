/**
 * Unit tests for the provision DBOS workflow's PURE pieces + the dedup→conflict
 * mapping (plan dbos-durable-flows-adoption P-001 / P-009). The live DBOS dedup +
 * resume mechanics are proven separately in provision-workflow.integration.test.ts.
 *
 * The DBOS SDK is mocked (as in orchestrator-workflow.test.ts) so importing the
 * module doesn't require a launched DBOS: runStep runs its thunk, registerWorkflow
 * returns the impl, and startWorkflow is controllable to simulate a dedup reject.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const ctl = vi.hoisted(() => ({ throwDedup: false }));

vi.mock('@dbos-inc/dbos-sdk', () => {
  class WorkflowQueue {
    name: string;
    constructor(name: string) {
      this.name = name;
    }
  }
  return {
    WorkflowQueue,
    DBOS: {
      runStep: (fn: () => unknown) => fn(),
      registerWorkflow: (impl: unknown) => impl,
      startWorkflow:
        (wf: (args: unknown) => Promise<unknown>) =>
        (args: unknown) => {
          if (ctl.throwDedup) {
            return Promise.reject(Object.assign(new Error('dup queued'), { dbosErrorCode: 28 }));
          }
          return Promise.resolve({ getResult: () => wf(args) });
        },
    },
  };
});

import {
  provisionWorkflowKeys,
  isDedupConflict,
  conflictResult,
  startProvisionWorkflow,
  setProvisionExecutor,
} from './provision-workflow';
import type { ProvisionRunInputs, ProvisionRunResult } from '../provision/runner';

afterEach(() => {
  ctl.throwDedup = false;
  vi.restoreAllMocks();
});

describe('provisionWorkflowKeys', () => {
  const base = { workspaceId: 'ws-1', harness: 'sheets', plugin: 'pg', phase: 'setup' as const };

  it('deduplicationID is the (ws, harness, plugin, phase) target — the per-target mutex (nonce excluded)', () => {
    const a = provisionWorkflowKeys({ ...base, nonce: 'n1' });
    const b = provisionWorkflowKeys({ ...base, nonce: 'n2' });
    expect(a.deduplicationID).toBe('provision:ws-1:sheets:pg:setup');
    // Same target, different request → SAME dedup id (concurrent ones collide).
    expect(a.deduplicationID).toBe(b.deduplicationID);
  });

  it('workflowID includes the nonce — unique per request (resume key, fresh per re-provision)', () => {
    const a = provisionWorkflowKeys({ ...base, nonce: 'n1' });
    const b = provisionWorkflowKeys({ ...base, nonce: 'n2' });
    expect(a.workflowID).toBe('provision:ws-1:sheets:pg:setup:n1');
    expect(a.workflowID).not.toBe(b.workflowID);
  });

  it('distinct phase / plugin / workspace → distinct dedup target (no cross-mutex)', () => {
    const setup = provisionWorkflowKeys({ ...base, nonce: 'n' }).deduplicationID;
    const teardown = provisionWorkflowKeys({ ...base, phase: 'teardown', nonce: 'n' }).deduplicationID;
    const otherPlugin = provisionWorkflowKeys({ ...base, plugin: 'redis', nonce: 'n' }).deduplicationID;
    const otherWs = provisionWorkflowKeys({ ...base, workspaceId: 'ws-2', nonce: 'n' }).deduplicationID;
    expect(new Set([setup, teardown, otherPlugin, otherWs]).size).toBe(4);
  });
});

describe('isDedupConflict', () => {
  it('true only for the QueueDedupIDDuplicated code (28)', () => {
    expect(isDedupConflict(Object.assign(new Error('x'), { dbosErrorCode: 28 }))).toBe(true);
  });
  it('false for other errors / non-objects', () => {
    expect(isDedupConflict(new Error('boom'))).toBe(false);
    expect(isDedupConflict(Object.assign(new Error('x'), { dbosErrorCode: 7 }))).toBe(false);
    expect(isDedupConflict(null)).toBe(false);
    expect(isDedupConflict('nope')).toBe(false);
  });
});

describe('conflictResult', () => {
  it('mirrors the legacy claim-conflict shape (ok:false + claim-conflict error)', () => {
    const r = conflictResult('setup');
    expect(r.ok).toBe(false);
    expect(r.phase).toBe('setup');
    expect(r.error).toMatch(/claim conflict/i);
  });
});

describe('startProvisionWorkflow', () => {
  const inputs = {
    harness: 'sheets',
    plugin: 'pg',
    publisher: 'acme',
    pluginVersion: '1.0.0',
    pluginDir: '/x',
    config: {},
    provision: {},
    consentConfirmed: true,
  } as unknown as ProvisionRunInputs;

  it('awaits the workflow result on the happy path (synchronous route contract preserved)', async () => {
    const stub: ProvisionRunResult = { ok: true, phase: 'setup', decision: 'fresh', durationMs: 1 };
    setProvisionExecutor(async () => stub);
    const r = await startProvisionWorkflow('ws-1', 'setup', inputs, 'nonce-1');
    expect(r).toEqual(stub);
    setProvisionExecutor(null);
  });

  it('maps a concurrent dedup reject to a claim-conflict result (not a throw)', async () => {
    ctl.throwDedup = true;
    const r = await startProvisionWorkflow('ws-1', 'setup', inputs, 'nonce-2');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/claim conflict/i);
  });
});
