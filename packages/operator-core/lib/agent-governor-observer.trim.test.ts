/**
 * Gap 9 — surfacePause trims the toast ring-buffer to TOAST_RING_BUFFER (2000)
 * (agent-governor-observer.ts:70-73). After inserting the new toast it selects everything
 * PAST the 2000th newest row (`offset(2000)`, newest-first) and deletes those stale ids.
 *
 * Unit via a drizzle mock: we capture the `offset(...)` argument and feed back a couple of
 * "stale" rows, then assert the delete fired with exactly those ids. The governor registry
 * emitter is real; coord/SSE are mocked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  sendMessage: vi.fn(async () => ({})),
  notifySyncInvalidate: vi.fn(async () => {}),
  insertValues: vi.fn(async () => {}),
  offsetSpy: vi.fn(),
  deleteWhere: vi.fn(async () => {}),
  // The rows the trim-select returns (the stale tail past the ring buffer).
  staleRows: [{ id: 101 }, { id: 102 }] as { id: number }[],
  // Captured arg the delete's where() built — we record the id list directly.
  capturedDeleteIds: [] as number[],
}));

vi.mock('./agent-tools/coordination/messages', () => ({ sendMessage: h.sendMessage }));
vi.mock('./sync-sse', () => ({ notifySyncInvalidate: h.notifySyncInvalidate }));
vi.mock('drizzle-orm', () => ({
  desc: (c: unknown) => c,
  // inArray records the ids it was handed so the test can assert them without a real query builder.
  inArray: (_col: unknown, ids: number[]) => {
    h.capturedDeleteIds = ids;
    return { ids };
  },
}));
vi.mock('@papercusp/db-org', () => ({
  getOrgPg: () => ({
    db: {
      insert: () => ({ values: h.insertValues }),
      select: () => ({
        from: () => ({
          orderBy: () => ({
            offset: (n: number) => {
              h.offsetSpy(n);
              return Promise.resolve(h.staleRows);
            },
          }),
        }),
      }),
      delete: () => ({ where: h.deleteWhere }),
    },
  }),
  generated: { toastLogInHarnessShared: { id: 'id', createdAt: 'createdAt' } },
}));

import { initAgentGovernorObserver, _resetAgentGovernorObserver } from './agent-governor-observer';
import { getGovernor, resetGovernorRegistry } from '@papercusp/papercup-shared/agent';

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

beforeEach(() => {
  vi.clearAllMocks();
  h.capturedDeleteIds = [];
  resetGovernorRegistry();
  _resetAgentGovernorObserver();
});

describe('agent-governor-observer toast trim (Gap 9)', () => {
  it('selects past offset(2000) newest-first and deletes the stale tail', async () => {
    initAgentGovernorObserver();
    getGovernor('anthropic', 'opus').penalize({ retryAfterMs: 60_000 });
    await flush();
    await flush(); // the trim runs in a detached async IIFE — give it a second tick.

    // The new toast was inserted, then the ring-buffer trim ran at offset 2000.
    expect(h.insertValues).toHaveBeenCalledTimes(1);
    expect(h.offsetSpy).toHaveBeenCalledWith(2000);
    // The stale ids the select returned are exactly what got deleted.
    expect(h.deleteWhere).toHaveBeenCalledTimes(1);
    expect(h.capturedDeleteIds).toEqual([101, 102]);
  });

  it('skips the delete when nothing is past the ring buffer (offset returns [])', async () => {
    h.staleRows = [];
    initAgentGovernorObserver();
    getGovernor('openai', 'default').penalize({ retryAfterMs: 60_000 });
    await flush();
    await flush();

    expect(h.offsetSpy).toHaveBeenCalledWith(2000);
    expect(h.deleteWhere).not.toHaveBeenCalled();
    // restore for any later test ordering
    h.staleRows = [{ id: 101 }, { id: 102 }];
  });
});
