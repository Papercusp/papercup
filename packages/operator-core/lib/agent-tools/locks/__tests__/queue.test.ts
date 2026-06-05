/**
 * locks:queue tool — metadata + the read-and-serialize handler contract.
 *
 * The store query (readQueue) is mocked; the tool's job is to call it with the
 * caller's coordination domain + filters and serialize the Date fields to ISO
 * strings inside the MCP text-content envelope.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const H = vi.hoisted(() => {
  const state: { queue: unknown } = { queue: { active_locks: [], waiting: [] } };
  return {
    state,
    readIdentity: vi.fn(() => ({ coordinationDomain: 'cd-1' })),
    ensureBootstrap: vi.fn(async () => {}),
    getTxPool: vi.fn(() => ({})),
    readQueue: vi.fn(async () => state.queue),
  };
});

vi.mock('../identity', () => ({ readIdentity: H.readIdentity }));
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
    expect((tool.guidance?.when ?? '').length).toBeGreaterThan(0);
    expect(tool.args.safeParse({}).success).toBe(true);
    expect(tool.args.safeParse({ paths: ['a.ts'], owner: 'su-1', include_completed: true }).success).toBe(true);
    expect(tool.args.safeParse({ paths: 'a.ts' }).success).toBe(false);
  });
});

describe('locks:queue handler', () => {
  it('passes the coordination domain + filters to readQueue', async () => {
    await tool.handler({ paths: ['x.ts'], owner: 'su-9', include_completed: true }, ctx);
    expect(H.ensureBootstrap).toHaveBeenCalled();
    expect(H.readQueue).toHaveBeenCalledWith(expect.anything(), {
      coordinationDomain: 'cd-1',
      paths: ['x.ts'],
      owner: 'su-9',
      includeCompleted: true,
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
});
