/**
 * locks:queue tool — metadata + the read-and-serialize handler contract.
 *
 * The store query (readQueue) is mocked; the tool's job is to call it with the
 * cross-domain diagnostic scope + filters and serialize the Date fields to ISO
 * strings inside the MCP text-content envelope.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const H = vi.hoisted(() => {
  const state: { queue: unknown } = { queue: { active_locks: [], waiting: [] } };
  return {
    state,
    ensureBootstrap: vi.fn(async () => {}),
    getTxPool: vi.fn(() => ({})),
    readQueue: vi.fn(async () => state.queue),
  };
});

vi.mock('../su-lock-store', () => ({
  ensureBootstrap: H.ensureBootstrap,
  getTxPool: H.getTxPool,
  readQueue: H.readQueue,
}));

import tool from '../queue';

const ctx = {} as never;
const payload = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text);

beforeEach(() => {
  H.readQueue.mockClear();
  H.state.queue = { active_locks: [], waiting: [] };
});

describe('locks:queue tool metadata', () => {
  it('has the expected name, capability, args, and guidance.when', () => {
    expect(tool.name).toBe('locks:queue');
    expect(tool.capability).toBe('locks:read');
    expect((tool as { skipWorkspaceTx?: boolean }).skipWorkspaceTx).toBe(true);
    expect((tool.guidance?.when ?? '').length).toBeGreaterThan(0);
    expect(tool.description).toContain('workspace-global diagnostic: omit harness');
    expect(tool.description).toContain('paths:[] matches nothing');
    expect(tool.guidance?.chaining).toContain('omit harness');
    expect(tool.guidance?.chaining).toContain('paths:[] is intentionally empty');
    expect(tool.args.safeParse({}).success).toBe(true);
    expect(tool.args.safeParse({ paths: ['a.ts'], owner: 'su-1', include_completed: true }).success).toBe(true);
    expect(tool.args.safeParse({ paths: 'a.ts' }).success).toBe(false);
  });

  it('keeps ptool JSON responses parseable when the queue snapshot exceeds the result door', () => {
    expect((tool as { skipResultDoor?: string }).skipResultDoor).toBe('programmatic-caller');
  });
});

describe('locks:queue handler', () => {
  it('uses the cross-domain diagnostic scope + passes filters to readQueue', async () => {
    await tool.handler({ paths: ['x.ts'], owner: 'su-9', include_completed: true }, ctx);
    expect(H.ensureBootstrap).toHaveBeenCalled();
    expect(H.readQueue).toHaveBeenCalledWith(expect.anything(), {
      // A serving operator can run from a different checkout than the path's
      // lock holder; diagnostics must not silently filter that holder out.
      coordinationDomain: null,
      paths: ['x.ts'],
      owner: 'su-9',
      includeCompleted: true,
    });
  });

  it('preserves an explicit empty paths filter for the store to fail closed', async () => {
    await tool.handler({ paths: [] }, ctx);
    expect(H.readQueue).toHaveBeenCalledWith(expect.anything(), {
      coordinationDomain: null,
      paths: [],
      owner: undefined,
      includeCompleted: undefined,
    });
  });

  it('serializes Date fields on active_locks + waiting to ISO strings', async () => {
    const acquired = new Date('2026-06-01T00:00:00.000Z');
    const expires = new Date('2026-06-01T00:20:00.000Z');
    const queued = new Date('2026-06-01T00:05:00.000Z');
    const waitUntil = new Date('2026-06-01T00:10:00.000Z');
    H.state.queue = {
      active_locks: [{ lock_id: 'l1', path: 'a.ts', acquired_ts: acquired, expires_ts: expires }],
      waiting: [{ waiter_id: 'w1', path: 'a.ts', queued_ts: queued, wait_until: waitUntil }],
    };
    const out = payload((await tool.handler({}, ctx)) as never);
    expect(out.active_locks[0]).toMatchObject({ lock_id: 'l1', acquired_ts: acquired.toISOString(), expires_ts: expires.toISOString() });
    expect(out.waiting[0]).toMatchObject({ waiter_id: 'w1', queued_ts: queued.toISOString(), wait_until: waitUntil.toISOString() });
  });

  it('serializes an empty completed list when terminal waiters were not requested', async () => {
    const out = payload((await tool.handler({}, ctx)) as never);
    expect(out).toMatchObject({ active_locks: [], waiting: [], completed: [] });
  });

  it('maps the optional completed list when present', async () => {
    const queued = new Date('2026-06-01T00:00:00.000Z');
    const waitUntil = new Date('2026-06-01T00:01:00.000Z');
    H.state.queue = {
      active_locks: [],
      waiting: [],
      completed: [{ waiter_id: 'c1', queued_ts: queued, wait_until: waitUntil }],
    };
    const out = payload((await tool.handler({ include_completed: true }, ctx)) as never);
    expect(out.completed[0]).toMatchObject({ waiter_id: 'c1', queued_ts: queued.toISOString(), wait_until: waitUntil.toISOString() });
  });

  it('EI-7454: a transient statement_timeout (57014) on readQueue is retried, not surfaced', async () => {
    let calls = 0;
    H.readQueue.mockImplementation(async () => {
      calls += 1;
      if (calls === 1) {
        const e = new Error('canceling statement due to statement timeout') as Error & { code: string };
        e.code = '57014';
        throw e;
      }
      return { active_locks: [], waiting: [] };
    });
    const out = payload((await tool.handler({}, ctx)) as never);
    expect(calls).toBe(2);
    expect(out).toMatchObject({ active_locks: [], waiting: [] });
  });

  it('a non-contention error is NOT retried — propagates immediately', async () => {
    let calls = 0;
    H.readQueue.mockImplementation(async () => {
      calls += 1;
      throw new Error('boom: unrelated failure');
    });
    await expect(tool.handler({}, ctx)).rejects.toThrow('boom: unrelated failure');
    expect(calls).toBe(1);
  });
});
