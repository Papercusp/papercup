/**
 * durable-spawn.test.ts — the reusable durable-spawn wrapper (P-010).
 *
 * DBOS is mocked: registerWorkflow returns the impl, WorkflowQueue is a real class
 * (it's `new`'d at import), startWorkflow is a spy we can make succeed or throw. We
 * assert the degrade-safe contract: `durableSpawnFire` returns true when it
 * enqueues a dedup-keyed durable workflow, and false (never throws) when DBOS is
 * off OR when the enqueue fails (e.g. called from inside another step) — so the
 * caller falls back to fire-and-forget.
 *
 * The spies + the DBOS-on flag live in `vi.hoisted` because the `vi.mock` factories
 * are hoisted above top-level declarations.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  startWorkflow: vi.fn((_wf: unknown, _opts: unknown) => (_input: unknown) => Promise.resolve()),
  loopbackFetch: vi.fn(async () => ({ ok: true, status: 200 })),
  state: { dbosOn: true },
}));

vi.mock('@dbos-inc/dbos-sdk', () => {
  class WorkflowQueue {
    constructor(public name: string, public opts?: unknown) {}
  }
  return {
    WorkflowQueue,
    DBOS: {
      runStep: (fn: () => unknown) => fn(),
      registerWorkflow: (impl: unknown) => impl,
      startWorkflow: h.startWorkflow,
    },
  };
});
vi.mock('./dbos-flags', () => ({ dbosOrchestratorActive: () => h.state.dbosOn }));
vi.mock('../loopback-fetch', () => ({ loopbackFetch: h.loopbackFetch }));

import { durableSpawnFire, startDurableSpawns } from './durable-spawn';

const INPUT = {
  url: 'http://x/api/harness/h/invoke?role=worker',
  body: { kickoff: 'go' },
  idempotencyKey: 'k1',
  label: 'h/worker',
};

beforeEach(() => {
  h.state.dbosOn = true;
  h.startWorkflow.mockReset();
  h.startWorkflow.mockImplementation((_wf, _opts) => (_input) => Promise.resolve());
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); });

describe('durableSpawnFire (P-010)', () => {
  it('returns false + does NOT enqueue when DBOS is off (caller fire-and-forgets)', async () => {
    h.state.dbosOn = false;
    const r = await durableSpawnFire(INPUT);
    expect(r).toBe(false);
    expect(h.startWorkflow).not.toHaveBeenCalled();
  });

  it('enqueues a dedup-keyed durable workflow + returns true when DBOS is on', async () => {
    const r = await durableSpawnFire(INPUT);
    expect(r).toBe(true);
    expect(h.startWorkflow).toHaveBeenCalledTimes(1);
    const opts = h.startWorkflow.mock.calls[0][1] as {
      workflowID: string;
      enqueueOptions: { deduplicationID: string };
    };
    expect(opts.workflowID).toBe('durable-spawn:k1');
    expect(opts.enqueueOptions.deduplicationID).toBe('durable-spawn:k1');
  });

  it('returns false (never throws) when the enqueue fails — e.g. called from inside a step', async () => {
    h.startWorkflow.mockImplementation(() => {
      throw new Error('cannot start a child workflow from inside a step');
    });
    await expect(durableSpawnFire(INPUT)).resolves.toBe(false);
  });
});

describe('startDurableSpawns (EI-403-A — the workflow-layer drain seam)', () => {
  const REQ2 = { url: 'http://x/api/harness/h/invoke?role=worker', body: { kickoff: 'b' }, idempotencyKey: 'k2', label: 'h/worker' };

  it('no-ops (0/0, no enqueue) on undefined or empty', async () => {
    expect(await startDurableSpawns(undefined)).toEqual({ enqueued: 0, total: 0 });
    expect(await startDurableSpawns([])).toEqual({ enqueued: 0, total: 0 });
    expect(h.startWorkflow).not.toHaveBeenCalled();
  });

  it('enqueues every request once and reports enqueued===total when DBOS is on', async () => {
    const res = await startDurableSpawns([INPUT, REQ2]);
    expect(res).toEqual({ enqueued: 2, total: 2 });
    expect(h.startWorkflow).toHaveBeenCalledTimes(2);
    const ids = h.startWorkflow.mock.calls.map((c) => (c[1] as { workflowID: string }).workflowID);
    expect(ids).toEqual(['durable-spawn:k1', 'durable-spawn:k2']);
  });

  it('tolerates declined fires (DBOS off ⇒ enqueued 0, total N, never throws)', async () => {
    h.state.dbosOn = false;
    const res = await startDurableSpawns([INPUT, REQ2]);
    expect(res).toEqual({ enqueued: 0, total: 2 });
    expect(h.startWorkflow).not.toHaveBeenCalled();
  });

  it('a single failed enqueue does not block the rest (partial enqueue count)', async () => {
    h.startWorkflow
      .mockImplementationOnce(() => {
        throw new Error('enqueue blip');
      })
      .mockImplementation((_wf, _opts) => (_input) => Promise.resolve());
    const res = await startDurableSpawns([INPUT, REQ2]);
    expect(res).toEqual({ enqueued: 1, total: 2 });
    expect(h.startWorkflow).toHaveBeenCalledTimes(2);
  });
});
