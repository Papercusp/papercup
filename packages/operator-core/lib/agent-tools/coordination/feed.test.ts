/**
 * feed.test.ts — readCoordFeed, the cross-channel coordination firehose read.
 *
 * Pure/seamable: the only dependency is the `coordLog` seam (mocked here), so the
 * union → tag → filter → histogram → sort → page pipeline is exercised deterministically
 * with no PG. Each describe pins one behavior of the read.
 *
 * Surface→reader mapping under test (feed.ts, WI-3869): messages/plan-events ⇒
 * coordLog.readLinesBounded; escalations/handoffs ⇒ coordLog.readEventsBounded — the
 * BOUNDED (ORDER BY id DESC LIMIT n) methods, not the unbounded full-scan readLines/
 * readEvents (WI-3869 replaced those call sites precisely because the unbounded scan
 * degraded coord:presence/fleet:status/coord:orient as the log grows).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CoordEnvelope, CoordKind } from '@papercusp/coordination/core';

// Mock the coordLog seam — also keeps the real ./log (and its getOrgPg/PG import) out of the test.
vi.mock('./log', () => ({
  coordLog: { readLinesBounded: vi.fn(), readEventsBounded: vi.fn() },
}));

import { readCoordFeed, type CoordSurface, DEFAULT_FEED_LIMIT, MAX_FEED_LIMIT } from './feed';
import { coordLog } from './log';

const mockLog = coordLog as unknown as {
  readLinesBounded: ReturnType<typeof vi.fn>;
  readEventsBounded: ReturnType<typeof vi.fn>;
};

/** Configure the four surfaces' contents. messages/plan-events resolve via
 *  readLinesBounded, escalations/handoffs via readEventsBounded — a single
 *  per-surface map drives both (the mock ignores the bound options, same as
 *  the old unbounded double did — the pipeline behavior under test is
 *  identical, only the underlying seam call changed per WI-3869). */
function setSurfaces(data: Partial<Record<CoordSurface, CoordEnvelope[]>>): void {
  mockLog.readLinesBounded.mockImplementation(async (s: CoordSurface) => data[s] ?? []);
  mockLog.readEventsBounded.mockImplementation(async (s: CoordSurface) => data[s] ?? []);
}

function env(p: Partial<CoordEnvelope> = {}): CoordEnvelope {
  return { ts: '2026-06-23T12:00:00.000Z', msg_id: 'm0', from: 'alice', to: ['bob'], kind: 'message', ...p };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('union + surface tagging + broadcast flag', () => {
  it('tags each row with its origin surface and reads from the right seam method', async () => {
    setSurfaces({
      messages: [env({ msg_id: 'a', kind: 'message' })],
      'plan-events': [env({ msg_id: 'b', kind: 'plan_event' })],
      escalations: [env({ msg_id: 'c', kind: 'escalation' })],
      handoffs: [env({ msg_id: 'd', kind: 'handoff' })],
    });
    const { rows, total } = await readCoordFeed();
    expect(total).toBe(4);
    const bySurface = Object.fromEntries(rows.map((r) => [r.msg_id, r.surface]));
    expect(bySurface).toEqual({ a: 'messages', b: 'plan-events', c: 'escalations', d: 'handoffs' });
    // line surfaces went through readLinesBounded; event surfaces through readEventsBounded
    expect(mockLog.readLinesBounded.mock.calls.map((c) => c[0]).sort()).toEqual(['messages', 'plan-events']);
    expect(mockLog.readEventsBounded.mock.calls.map((c) => c[0]).sort()).toEqual(['escalations', 'handoffs']);
  });

  it('WI-3869: every raw per-surface read is BOUNDED (never the unbounded full-scan) and pushes down kinds/since_ts/plan_slug', async () => {
    setSurfaces({
      messages: [env({ msg_id: 'a' })],
      'plan-events': [env({ msg_id: 'b', kind: 'plan_event' })],
      escalations: [env({ msg_id: 'c', kind: 'escalation' })],
      handoffs: [env({ msg_id: 'd', kind: 'handoff' })],
    });
    await readCoordFeed({
      kinds: ['message', 'escalation'] as CoordKind[],
      since_ts: '2026-06-23T00:00:00.000Z',
      plan_slug: 'plan-a',
    });
    // Every bounded call carries a numeric, non-unbounded limit — this is the
    // regression guard: a caller that reverts to coordLog.readLines/readEvents
    // (no `limit` arg at all) fails this assertion immediately.
    for (const call of [...mockLog.readLinesBounded.mock.calls, ...mockLog.readEventsBounded.mock.calls]) {
      const [, opts] = call as [CoordSurface, { limit?: number }];
      expect(typeof opts?.limit).toBe('number');
      expect(opts!.limit!).toBeGreaterThan(0);
    }
    // Line reads push down kinds + sinceTs + planSlug (readLinesBounded supports all three).
    const lineCall = mockLog.readLinesBounded.mock.calls.find((c) => c[0] === 'messages')!;
    expect(lineCall[1]).toMatchObject({
      kinds: ['message', 'escalation'],
      sinceTs: '2026-06-23T00:00:00.000Z',
      planSlug: 'plan-a',
    });
    // Event reads push down kinds only (readEventsBounded has no sinceTs/planSlug param).
    const eventCall = mockLog.readEventsBounded.mock.calls.find((c) => c[0] === 'escalations')!;
    expect(eventCall[1]).toMatchObject({ kinds: ['message', 'escalation'] });
    expect(eventCall[1]).not.toHaveProperty('sinceTs');
    expect(eventCall[1]).not.toHaveProperty('planSlug');
  });

  it('derives broadcast from a ["*"] recipient', async () => {
    setSurfaces({
      messages: [
        env({ msg_id: 'bc', to: ['*'] }),
        env({ msg_id: 'dm', to: ['bob'] }),
      ],
    });
    const { rows } = await readCoordFeed();
    expect(rows.find((r) => r.msg_id === 'bc')!.broadcast).toBe(true);
    expect(rows.find((r) => r.msg_id === 'dm')!.broadcast).toBe(false);
  });
});

describe('newest-first ordering (compareByTsThenId reversed)', () => {
  it('orders by ts descending', async () => {
    setSurfaces({
      messages: [
        env({ msg_id: 'old', ts: '2026-06-23T10:00:00.000Z' }),
        env({ msg_id: 'new', ts: '2026-06-23T12:00:00.000Z' }),
        env({ msg_id: 'mid', ts: '2026-06-23T11:00:00.000Z' }),
      ],
    });
    const { rows } = await readCoordFeed();
    expect(rows.map((r) => r.msg_id)).toEqual(['new', 'mid', 'old']);
  });

  it('breaks ts ties by msg_id descending', async () => {
    const ts = '2026-06-23T12:00:00.000Z';
    setSurfaces({ messages: [env({ msg_id: 'm1', ts }), env({ msg_id: 'm3', ts }), env({ msg_id: 'm2', ts })] });
    const { rows } = await readCoordFeed();
    expect(rows.map((r) => r.msg_id)).toEqual(['m3', 'm2', 'm1']);
  });
});

describe('limit clamp + nextCursor', () => {
  const five = Array.from({ length: 5 }, (_, i) =>
    env({ msg_id: `m${i}`, ts: `2026-06-23T12:00:0${i}.000Z` }),
  );

  it('defaults to DEFAULT_FEED_LIMIT and returns null cursor when not capped', async () => {
    setSurfaces({ messages: five });
    const { rows, nextCursor, total } = await readCoordFeed();
    expect(DEFAULT_FEED_LIMIT).toBe(100);
    expect(rows).toHaveLength(5);
    expect(total).toBe(5);
    expect(nextCursor).toBeNull();
  });

  it('caps to the requested limit and returns the oldest-of-page ts as the cursor', async () => {
    setSurfaces({ messages: five });
    const { rows, nextCursor, total } = await readCoordFeed({ limit: 2 });
    expect(rows.map((r) => r.msg_id)).toEqual(['m4', 'm3']); // newest two
    expect(total).toBe(5); // total counts the WHOLE filtered set, not the page
    expect(nextCursor).toBe('2026-06-23T12:00:03.000Z'); // ts of m3 (oldest on the page)
  });

  it('clamps a 0/negative limit up to 1', async () => {
    setSurfaces({ messages: five });
    expect((await readCoordFeed({ limit: 0 })).rows).toHaveLength(1);
    expect((await readCoordFeed({ limit: -7 })).rows).toHaveLength(1);
  });

  it('clamps an over-max limit down to MAX_FEED_LIMIT', async () => {
    expect(MAX_FEED_LIMIT).toBe(500);
    const many = Array.from({ length: 600 }, (_, i) =>
      env({ msg_id: `m${String(i).padStart(3, '0')}`, ts: `2026-06-23T12:00:00.${String(i).padStart(3, '0')}Z` }),
    );
    setSurfaces({ messages: many });
    const { rows, nextCursor, total } = await readCoordFeed({ limit: 9999 });
    expect(rows).toHaveLength(500);
    expect(total).toBe(600);
    expect(nextCursor).not.toBeNull(); // capped → more remain
  });
});

describe('filters', () => {
  it('kind filter keeps only the requested kinds', async () => {
    setSurfaces({
      messages: [env({ msg_id: 'msg', kind: 'message' }), env({ msg_id: 'ack', kind: 'ack' })],
      escalations: [env({ msg_id: 'esc', kind: 'escalation' })],
    });
    const { rows } = await readCoordFeed({ kinds: ['escalation', 'ack'] as CoordKind[] });
    expect(rows.map((r) => r.msg_id).sort()).toEqual(['ack', 'esc']);
  });

  it('owner filter matches from, an addressed recipient, OR a broadcast', async () => {
    setSurfaces({
      messages: [
        env({ msg_id: 'fromZoe', from: 'zoe', to: ['x'] }),
        env({ msg_id: 'toZoe', from: 'x', to: ['zoe'] }),
        env({ msg_id: 'bcast', from: 'x', to: ['*'] }),
        env({ msg_id: 'other', from: 'x', to: ['y'] }),
      ],
    });
    const { rows } = await readCoordFeed({ owner: 'zoe' });
    expect(rows.map((r) => r.msg_id).sort()).toEqual(['bcast', 'fromZoe', 'toZoe']);
  });

  it('from filter is STRICT sender-only — matches from===this, NOT recipients or broadcasts-by-others (EI-7018)', async () => {
    setSurfaces({
      messages: [
        env({ msg_id: 'fromZoe', from: 'zoe', to: ['x'] }), // zoe SENT it → included
        env({ msg_id: 'toZoe', from: 'x', to: ['zoe'] }), // zoe is a RECIPIENT → excluded (unlike owner)
        env({ msg_id: 'bcastX', from: 'x', to: ['*'] }), // broadcast by someone else → excluded (unlike owner)
        env({ msg_id: 'zoeBcast', from: 'zoe', to: ['*'] }), // zoe's OWN broadcast → included
      ],
    });
    const { rows, total } = await readCoordFeed({ from: 'zoe' });
    expect(rows.map((r) => r.msg_id).sort()).toEqual(['fromZoe', 'zoeBcast']);
    expect(total).toBe(2); // the summary/histogram is scoped to the filter, not the raw stream
  });

  it('from + owner compose (AND) — sender is zoe AND the envelope involves bob', async () => {
    setSurfaces({
      messages: [
        env({ msg_id: 'zoe_to_bob', from: 'zoe', to: ['bob'] }), // from zoe, involves bob → kept
        env({ msg_id: 'zoe_to_cat', from: 'zoe', to: ['cat'] }), // from zoe, not bob → dropped by owner
        env({ msg_id: 'ann_to_bob', from: 'ann', to: ['bob'] }), // involves bob, not from zoe → dropped by from
      ],
    });
    const { rows } = await readCoordFeed({ from: 'zoe', owner: 'bob' });
    expect(rows.map((r) => r.msg_id)).toEqual(['zoe_to_bob']);
  });

  it('plan_slug filter is exact-match', async () => {
    setSurfaces({
      messages: [
        env({ msg_id: 'p1', plan_slug: 'plan-a' }),
        env({ msg_id: 'p2', plan_slug: 'plan-b' }),
        env({ msg_id: 'p3' }),
      ],
    });
    const { rows } = await readCoordFeed({ plan_slug: 'plan-a' });
    expect(rows.map((r) => r.msg_id)).toEqual(['p1']);
  });

  it('q is a case-insensitive substring over summary/body/from/to/plan_slug/event/detail', async () => {
    setSurfaces({
      messages: [
        env({ msg_id: 'sum', summary: 'Deploy FAILED on staging' }),
        env({ msg_id: 'bod', body: 'see the failed run' }),
        env({ msg_id: 'fro', from: 'failed-bot' }),
        env({ msg_id: 'det', detail: 'root cause: FAILED migration' }),
        env({ msg_id: 'no', summary: 'all green' }),
      ],
    });
    const { rows } = await readCoordFeed({ q: 'failed' });
    expect(rows.map((r) => r.msg_id).sort()).toEqual(['bod', 'det', 'fro', 'sum']);
  });

  it('since_ts is strictly-later and before_ts strictly-earlier (boundaries excluded)', async () => {
    setSurfaces({
      messages: [
        env({ msg_id: 't09', ts: '2026-06-23T09:00:00.000Z' }),
        env({ msg_id: 't10', ts: '2026-06-23T10:00:00.000Z' }),
        env({ msg_id: 't11', ts: '2026-06-23T11:00:00.000Z' }),
        env({ msg_id: 't12', ts: '2026-06-23T12:00:00.000Z' }),
      ],
    });
    const { rows } = await readCoordFeed({
      since_ts: '2026-06-23T10:00:00.000Z', // excludes t10
      before_ts: '2026-06-23T12:00:00.000Z', // excludes t12
    });
    expect(rows.map((r) => r.msg_id)).toEqual(['t11']);
  });
});

describe('byKind histogram', () => {
  it('counts the WHOLE filtered set before the page cap', async () => {
    setSurfaces({
      messages: [
        env({ msg_id: 'a', kind: 'message', ts: '2026-06-23T12:00:00.000Z' }),
        env({ msg_id: 'b', kind: 'message', ts: '2026-06-23T12:00:01.000Z' }),
        env({ msg_id: 'c', kind: 'ack', ts: '2026-06-23T12:00:02.000Z' }),
      ],
    });
    const { rows, byKind, total } = await readCoordFeed({ limit: 1 });
    expect(rows).toHaveLength(1); // page capped
    expect(total).toBe(3);
    expect(byKind).toEqual({ message: 2, ack: 1 }); // histogram unaffected by the cap
  });
});

describe('empty', () => {
  it('returns an empty page + null cursor when no surface has rows', async () => {
    setSurfaces({});
    const { rows, nextCursor, total, byKind } = await readCoordFeed();
    expect(rows).toEqual([]);
    expect(nextCursor).toBeNull();
    expect(total).toBe(0);
    expect(byKind).toEqual({});
  });
});
