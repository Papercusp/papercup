/**
 * REGRESSION GUARD — `getWorkItemThreadWindow` must dispatch issue-family reads to
 * issues-engineer's store, not to work-items.ts's own (P-006 /
 * `gate-ownership-condition-singleton-2026-08-03`).
 *
 * ── WHY THIS FILE EXISTS ──────────────────────────────────────────────────────
 * The two modules hold what look like interchangeable coord stores. They are not:
 * issues-engineer's resolves the workspace DYNAMICALLY, while work-items.ts's is
 * pinned to `DEFAULT_COORD_WORKSPACE` ('default'). Live thread rows split along
 * exactly that line — measured 2026-08-03: 5,208 `issue` threads in
 * `papercusp-workspace` vs 457 `feature` threads in `default`. So each store is
 * correct for ONE family and silently wrong for the other.
 *
 * What makes it worth a dedicated guard is the FAILURE SHAPE. Reading an issue
 * thread through the wrong store does not throw and does not return an error — it
 * matches zero rows, and because an absent thread legitimately means "nobody has
 * commented", the caller receives a confident, well-formed `total: 0`. The first
 * version of this code did exactly that: WI-6857, which has TEN posts, read back
 * as 0/0 and every unit test still passed. Only an unmocked live run caught it.
 *
 * A type checker cannot see this (both stores share a type), and a fixture cannot
 * see it (a fixture supplies its own rows). Only the dispatch itself can be
 * pinned, so that is what this asserts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getWorkItemThreadWindow } from './work-items';

const issueWindow = vi.fn(async () => ({
  posts: [{ id: 1, thread_id: 't', author_id: 'su-a', body: 'hi', created_ts: '2026-08-03T00:00:00.000Z' }],
  total: 10,
  topics: ['gate'],
  createdAt: '2026-08-02T04:23:32.237Z',
}));

const item = (family: string) =>
  vi.fn(async () => ({ id: 'WI-6857', family, harness: 'papercusp', createdAt: '2026-08-02T04:23:32.237Z' }));

describe('getWorkItemThreadWindow family dispatch', () => {
  beforeEach(() => issueWindow.mockClear());

  it('routes an ISSUE-family item to the issues-engineer window reader', async () => {
    const win = await getWorkItemThreadWindow('WI-6857', 3, undefined, {
      getWorkItem: item('issue') as never,
      getIssueThreadWindow: issueWindow as never,
    });

    // The dispatch happened...
    expect(issueWindow).toHaveBeenCalledWith('WI-6857', 3);
    // ...and the caller got the REAL counts rather than the silent `total: 0` the
    // wrong store produces for exactly this input.
    expect(win?.total).toBe(10);
    expect(win?.posts).toHaveLength(1);
    expect(win?.total).not.toBe(0);
  });

  it('does NOT route a feature-family item to the issue reader', async () => {
    // The mirror case: feature threads really do live in the `default` coord
    // workspace (457 of them, measured), so this module's own store is correct
    // for them. Dispatching BOTH families to issues-engineer would swap which
    // family is silently wrong rather than fix anything.
    await getWorkItemThreadWindow('WI-1', 3, undefined, {
      getWorkItem: item('feature') as never,
      getIssueThreadWindow: issueWindow as never,
    }).catch(() => undefined);
    expect(issueWindow).not.toHaveBeenCalled();
  });

  it('returns null for an item that does not exist, without consulting a thread store', async () => {
    const win = await getWorkItemThreadWindow('WI-99999999', 3, undefined, {
      getWorkItem: (async () => null) as never,
      getIssueThreadWindow: issueWindow as never,
    });
    expect(win).toBeNull();
    expect(issueWindow).not.toHaveBeenCalled();
  });
});
