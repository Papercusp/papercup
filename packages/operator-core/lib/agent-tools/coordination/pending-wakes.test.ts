import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@papercusp/db-org', () => ({ getOrgPg: vi.fn() }));

import { getOrgPg } from '@papercusp/db-org';
import {
  stagePendingWake,
  listPendingWakes,
  listAllPendingWakes,
  countPendingWakes,
  releasePendingWake,
  clearPendingWakes,
} from './pending-wakes';

// A fake `sql` backing an in-memory pending_wakes table, routing by query text.
// Emulates the EI-312 dedupe upsert: identical (owner, source, summary, workspace)
// bumps count + last_seen_at and replaces the payload, like the partial-null-safe
// unique index (migration 224) + ON CONFLICT DO UPDATE.
function fakeStore() {
  const rows: Array<Record<string, unknown>> = [];
  let nextId = 1;
  let nowTick = 0;
  const sql = vi.fn((strings: TemplateStringsArray, ...vals: unknown[]) => {
    const q = strings.join('§');
    if (q.includes('INSERT INTO harness_shared.pending_wakes')) {
      const [owner, summary, payload, source, ws] = vals;
      const key = (r: Record<string, unknown>) =>
        `${r.owner_id}|${r.source ?? ''}|${r.summary ?? ''}|${r.workspace_id ?? ''}`;
      const incoming = { owner_id: owner, summary, source, workspace_id: ws };
      const existing = rows.find((r) => key(r) === key(incoming));
      if (existing) {
        existing.count = Number(existing.count) + 1;
        existing.last_seen_at = `2026-06-09T00:00:0${++nowTick}Z`;
        existing.payload = payload;
      } else {
        rows.push({
          id: nextId++,
          owner_id: owner,
          summary,
          payload,
          source,
          workspace_id: ws,
          created_at: '2026-06-09T00:00:00Z',
          count: 1,
          last_seen_at: '2026-06-09T00:00:00Z',
        });
      }
      return Promise.resolve([]);
    }
    if (q.includes('count(*)')) {
      return Promise.resolve([{ n: rows.filter((r) => r.owner_id === vals[0]).length }]);
    }
    if (q.includes('DELETE') && q.includes('owner_id')) {
      // clearPendingWakes: drop every row for the owner, RETURNING ids.
      const mine = rows.filter((r) => r.owner_id === vals[0]);
      for (const r of mine) rows.splice(rows.indexOf(r), 1);
      return Promise.resolve(mine.map((r) => ({ id: r.id })));
    }
    if (q.includes('DELETE')) {
      const i = rows.findIndex((r) => r.id === vals[0]);
      if (i >= 0) rows.splice(i, 1);
      return Promise.resolve([]);
    }
    // SELECT list — owner-filtered when a value is bound, the whole table
    // (list-all, owner-then-id order) when none is.
    if (vals.length === 0) {
      return Promise.resolve(
        [...rows].sort((a, b) =>
          a.owner_id === b.owner_id
            ? Number(a.id) - Number(b.id)
            : String(a.owner_id) < String(b.owner_id)
              ? -1
              : 1,
        ),
      );
    }
    return Promise.resolve(rows.filter((r) => r.owner_id === vals[0]));
  });
  return { sql, rows };
}

let store: ReturnType<typeof fakeStore>;
beforeEach(() => {
  store = fakeStore();
  vi.mocked(getOrgPg).mockReturnValue({ sql: store.sql } as never);
});
afterEach(() => vi.clearAllMocks());

describe('pending-wakes (P-007)', () => {
  it('stage → list → count → release round-trip, oldest-first', async () => {
    await stagePendingWake({ ownerId: 's-1', summary: 'a', source: 'x', workspaceId: 'ws' });
    await stagePendingWake({ ownerId: 's-1', summary: 'b', payload: { k: 1 } });
    await stagePendingWake({ ownerId: 's-2', summary: 'other' });

    expect(await countPendingWakes('s-1')).toBe(2);
    const list = await listPendingWakes('s-1');
    expect(list.map((w) => w.summary)).toEqual(['a', 'b']);
    expect(list[0].ownerId).toBe('s-1');

    await releasePendingWake(list[0].id);
    expect(await countPendingWakes('s-1')).toBe(1);
  });

  it('stringifies a payload to jsonb (null when absent)', async () => {
    await stagePendingWake({ ownerId: 's-1', payload: { hi: true } });
    expect(store.rows[0].payload).toBe(JSON.stringify({ hi: true }));
    await stagePendingWake({ ownerId: 's-1', summary: 'distinct' });
    expect(store.rows[1].payload).toBeNull();
  });
});

describe('pending-wakes staging coalescing (EI-312)', () => {
  it('an identical re-fire coalesces into ONE row: count bumps, no new insert', async () => {
    const boot = { ownerId: 's-1', summary: 'Watchdog wake (boot)', source: 'hive-watchdog:boot', workspaceId: 'ws' };
    for (let i = 0; i < 11; i++) await stagePendingWake({ ...boot, payload: { fire: i } });

    expect(await countPendingWakes('s-1')).toBe(1); // badge reads 1, not 11
    const [row] = await listPendingWakes('s-1');
    expect(row.count).toBe(11);
    expect(row.payload).toBe(JSON.stringify({ fire: 10 })); // newest fire is the headline
    expect(row.lastSeenAt > row.createdAt).toBe(true);
  });

  it('distinct summaries / sources / owners stay separate rows', async () => {
    await stagePendingWake({ ownerId: 's-1', summary: 'tick', source: 'cadence' });
    await stagePendingWake({ ownerId: 's-1', summary: 'tick', source: 'watchdog' }); // other source
    await stagePendingWake({ ownerId: 's-1', summary: 'placement WI-99', source: 'cadence' }); // other summary
    await stagePendingWake({ ownerId: 's-2', summary: 'tick', source: 'cadence' }); // other owner

    expect(await countPendingWakes('s-1')).toBe(3);
    expect(await countPendingWakes('s-2')).toBe(1);
    const list = await listPendingWakes('s-1');
    expect(list.every((w) => w.count === 1)).toBe(true);
  });

  it('listAllPendingWakes returns every owner, grouped owner-then-oldest (the wake board)', async () => {
    await stagePendingWake({ ownerId: 's-2', summary: 'theirs' });
    await stagePendingWake({ ownerId: 's-1', summary: 'a' });
    await stagePendingWake({ ownerId: 's-1', summary: 'b' });

    const all = await listAllPendingWakes();
    expect(all.map((w) => [w.ownerId, w.summary])).toEqual([
      ['s-1', 'a'],
      ['s-1', 'b'],
      ['s-2', 'theirs'],
    ]);
  });

  it('clearPendingWakes drains one owner only and reports rows dropped', async () => {
    await stagePendingWake({ ownerId: 's-1', summary: 'a' });
    await stagePendingWake({ ownerId: 's-1', summary: 'b' });
    await stagePendingWake({ ownerId: 's-2', summary: 'keep' });

    expect(await clearPendingWakes('s-1')).toBe(2);
    expect(await countPendingWakes('s-1')).toBe(0);
    expect(await countPendingWakes('s-2')).toBe(1);
  });
});
