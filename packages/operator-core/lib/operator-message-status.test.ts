import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const messageStatuses = new Map<string, string>();

vi.mock('./workspace-registry', () => ({ activeWorkspaceId: () => 'test-ws' }));

vi.mock('@papercusp/db-org', () => {
  function tagged(strings: TemplateStringsArray, ..._values: unknown[]): Promise<unknown[]> {
    const sqlText = strings.join('?');
    if (/SELECT id, status[\s\S]*FROM papercup_shared\.messages/.test(sqlText)) {
      // The IN clause's value is built via tx(arr), which emits its own
      // tagged query — values[0] here will be the arrayified value, not
      // the IDs directly. Just return everything we have; the caller
      // reconciles by id.
      return Promise.resolve([...messageStatuses.entries()].map(([id, status]) => ({ id, status })));
    }
    return Promise.resolve([]);
  }
  // tx(arr) helper: postgres-js returns a "fragment" object; we don't
  // care about its content for this mock — readMessageStatuses ignores it.
  (tagged as unknown as (arr: unknown[]) => unknown) = Object.assign(tagged, {});
  function fragmentArr(_arr: unknown[]) { return { _frag: true }; }
  return {
    withWorkspace: async (_ws: string, cb: (tx: typeof tagged & ((arr: unknown[]) => unknown)) => Promise<unknown>) => {
      const tx = Object.assign(tagged, fragmentArr) as typeof tagged & ((arr: unknown[]) => unknown);
      return cb(tx);
    },
  };
});

import { readMessageStatuses } from './operator-message-status';

beforeEach(() => messageStatuses.clear());
afterEach(() => messageStatuses.clear());

describe('readMessageStatuses', () => {
  it('returns empty for empty input (no DB round-trip)', async () => {
    const r = await readMessageStatuses([]);
    expect(r).toEqual([]);
  });

  it('maps pending → dispatched', async () => {
    messageStatuses.set('m1', 'pending');
    const r = await readMessageStatuses(['m1']);
    expect(r[0].receivingState).toBe('dispatched');
    expect(r[0].rawStatus).toBe('pending');
  });

  it('maps acknowledged / actioned / archived → consumed', async () => {
    messageStatuses.set('a', 'acknowledged');
    messageStatuses.set('b', 'actioned');
    messageStatuses.set('c', 'archived');
    const r = await readMessageStatuses(['a', 'b', 'c']);
    const byId = Object.fromEntries(r.map((x) => [x.messageId, x.receivingState]));
    expect(byId.a).toBe('consumed');
    expect(byId.b).toBe('consumed');
    expect(byId.c).toBe('consumed');
  });

  it('falls back to dispatched for unknown statuses', async () => {
    messageStatuses.set('x', 'some-future-status');
    const r = await readMessageStatuses(['x']);
    expect(r[0].receivingState).toBe('dispatched');
  });
});
