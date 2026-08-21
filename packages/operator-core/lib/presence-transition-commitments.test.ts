/**
 * Unit tests for the IO half of the P-039 presence emitter
 * (context-injection-audit-2026-07-28, D-012).
 *
 * Two things are worth testing here and they are not the SQL results: the
 * FAIL-SOFT contract (a sweep must degrade to silence, never throw) and the
 * SCOPE TRAP that would silently empty the awaiting-held-item leg.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

/** Captures the SQL text of each tagged-template call so the query SHAPE can be
 *  asserted without a database. */
const queries: string[] = [];
let sqlImpl: (text: string) => unknown = () => [];

vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await orig<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({
    sql: Object.assign((strings: TemplateStringsArray, ..._v: unknown[]) => {
      const text = strings.join('?');
      queries.push(text);
      return sqlImpl(text);
    }, { begin: vi.fn() }),
  }),
}));

const fetchUnansweredDirected = vi.fn();
vi.mock('./agent-tools/coordination/unanswered-directed', () => ({
  fetchUnansweredDirected: (...a: unknown[]) => fetchUnansweredDirected(...a),
  UNANSWERED_LOOKBACK_MS: 3 * 24 * 3600 * 1000,
}));

const readQueue = vi.fn();
vi.mock('./agent-tools/locks/su-lock-store', () => ({
  ensureBootstrap: async () => {},
  getTxPool: () => ({}),
  readQueue: (...a: unknown[]) => readQueue(...a),
}));

const { gatherCommitmentsOn } = await import('./presence-transition-commitments');

beforeEach(() => {
  queries.length = 0;
  sqlImpl = () => [];
  fetchUnansweredDirected.mockReset().mockResolvedValue(new Map());
  readQueue.mockReset().mockResolvedValue({ active_locks: [], waiting: [] });
});

describe('gatherCommitmentsOn — the awaiting-reply leg', () => {
  it('inverts fetchUnansweredDirected: the asks the DEAD agent owes become its senders commitments', async () => {
    // The module is keyed BY RECIPIENT, so asking it about the dying agent
    // yields exactly the correspondents left hanging.
    fetchUnansweredDirected.mockResolvedValue(
      new Map([
        [
          'peer',
          {
            count: 2,
            oldestAgeMs: 1000,
            newest: [
              { msgId: 'm1', from: 'r1', summary: 'can you confirm?', ageMs: 10 },
              { msgId: 'm2', from: 'r2', ageMs: 20 },
            ],
          },
        ],
      ]),
    );
    const out = await gatherCommitmentsOn(['peer']);
    expect(out).toEqual([
      { receiverId: 'r1', subjectId: 'peer', kind: 'awaiting-reply', detail: 'can you confirm?' },
      { receiverId: 'r2', subjectId: 'peer', kind: 'awaiting-reply', detail: 'm2' },
    ]);
  });

  it('fails soft when the aggregate throws', async () => {
    fetchUnansweredDirected.mockRejectedValue(new Error('pg down'));
    await expect(gatherCommitmentsOn(['peer'])).resolves.toEqual([]);
  });
});

describe('gatherCommitmentsOn — the awaiting-held-item leg', () => {
  it('does NOT scope event_awaits on workspace_id — the trap that returns a silent zero', async () => {
    // MEASURED 2026-08-02: event_awaits.workspace_id is 'default' for 100% of
    // its 32,152 rows, NOT the workspace slug. The dev:pg_query tenant advisory
    // recommends adding `workspace_id = 'papercusp-workspace'` here, and doing
    // so returns ZERO rows — a false "nobody is awaiting anything" that reads
    // exactly like a healthy empty result. The taken_by join is the scope.
    await gatherCommitmentsOn(['peer']);
    const q = queries.find((t) => t.includes('event_awaits'));
    expect(q).toBeDefined();
    expect(q).not.toMatch(/workspace_id/);
    expect(q).toMatch(/taken_by/);
  });

  it('only counts ARMED awaits — fired, cancelled and expired ones are not commitments', async () => {
    await gatherCommitmentsOn(['peer']);
    const q = queries.find((t) => t.includes('event_awaits')) ?? '';
    expect(q).toMatch(/fired_at IS NULL/);
    expect(q).toMatch(/cancelled_at IS NULL/);
    expect(q).toMatch(/expires_ts/);
  });

  it('maps a held-item await to its awaiting agent', async () => {
    sqlImpl = (text) =>
      text.includes('event_awaits')
        ? [{ subscriber_id: 'r1', taken_by: 'peer', item_id: 'WI-1', title: 'fix the thing' }]
        : [];
    const out = await gatherCommitmentsOn(['peer']);
    expect(out).toEqual([
      { receiverId: 'r1', subjectId: 'peer', kind: 'awaiting-held-item', detail: 'WI-1 (fix the thing)' },
    ]);
  });

  it('fails soft when the query throws', async () => {
    sqlImpl = () => {
      throw new Error('relation does not exist');
    };
    await expect(gatherCommitmentsOn(['peer'])).resolves.toEqual([]);
  });
});

describe('gatherCommitmentsOn — the blocked-on-lock leg', () => {
  it('matches a waiter to the subject holding a path it waits for', async () => {
    readQueue.mockResolvedValue({
      active_locks: [{ path: 'src/a.ts', owner: 'peer' }],
      waiting: [{ owner: 'r1', paths: ['src/a.ts'], status: 'waiting' }],
    });
    const out = await gatherCommitmentsOn(['peer']);
    expect(out).toEqual([
      { receiverId: 'r1', subjectId: 'peer', kind: 'blocked-on-lock', detail: 'src/a.ts' },
    ]);
  });

  it('ignores a lock held by someone who did NOT transition', async () => {
    readQueue.mockResolvedValue({
      active_locks: [{ path: 'src/a.ts', owner: 'somebody-else' }],
      waiting: [{ owner: 'r1', paths: ['src/a.ts'], status: 'waiting' }],
    });
    await expect(gatherCommitmentsOn(['peer'])).resolves.toEqual([]);
  });

  it('ignores a non-waiting queue row', async () => {
    readQueue.mockResolvedValue({
      active_locks: [{ path: 'src/a.ts', owner: 'peer' }],
      waiting: [{ owner: 'r1', paths: ['src/a.ts'], status: 'granted' }],
    });
    await expect(gatherCommitmentsOn(['peer'])).resolves.toEqual([]);
  });

  it('reads EVERY coordination domain — a sweep is host-wide and has none of its own', async () => {
    await gatherCommitmentsOn(['peer']);
    expect(readQueue).toHaveBeenCalledWith(expect.anything(), { coordinationDomain: null });
  });

  it('fails soft when the SEPARATE locks database is unreachable', async () => {
    readQueue.mockRejectedValue(new Error('locks db down'));
    await expect(gatherCommitmentsOn(['peer'])).resolves.toEqual([]);
  });
});

describe('gatherCommitmentsOn — leg independence', () => {
  it('a failing leg silences only itself, never the dominant awaiting-reply class', async () => {
    fetchUnansweredDirected.mockResolvedValue(
      new Map([['peer', { count: 1, oldestAgeMs: 1, newest: [{ msgId: 'm1', from: 'r1', ageMs: 1 }] }]]),
    );
    readQueue.mockRejectedValue(new Error('locks db down'));
    sqlImpl = () => {
      throw new Error('pg down');
    };
    const out = await gatherCommitmentsOn(['peer']);
    expect(out).toEqual([{ receiverId: 'r1', subjectId: 'peer', kind: 'awaiting-reply', detail: 'm1' }]);
  });

  it('is a no-op with no subjects — the quiet path costs nothing', async () => {
    expect(await gatherCommitmentsOn([])).toEqual([]);
    expect(fetchUnansweredDirected).not.toHaveBeenCalled();
    expect(readQueue).not.toHaveBeenCalled();
    expect(queries).toEqual([]);
  });
});
