import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@papercusp/db-org', () => ({ getOrgPg: vi.fn() }));

import { getOrgPg } from '@papercusp/db-org';
import {
  stagePendingWake,
  listPendingWakes,
  countPendingWakes,
  releasePendingWake,
} from './pending-wakes';

// A fake `sql` backing an in-memory pending_wakes table, routing by query text.
function fakeStore() {
  const rows: Array<Record<string, unknown>> = [];
  let nextId = 1;
  const sql = vi.fn((strings: TemplateStringsArray, ...vals: unknown[]) => {
    const q = strings.join('§');
    if (q.includes('INSERT INTO harness_shared.pending_wakes')) {
      rows.push({
        id: nextId++,
        owner_id: vals[0],
        summary: vals[1],
        payload: vals[2],
        source: vals[3],
        workspace_id: vals[4],
        created_at: '2026-06-09T00:00:00Z',
      });
      return Promise.resolve([]);
    }
    if (q.includes('count(*)')) {
      return Promise.resolve([{ n: rows.filter((r) => r.owner_id === vals[0]).length }]);
    }
    if (q.includes('DELETE')) {
      const i = rows.findIndex((r) => r.id === vals[0]);
      if (i >= 0) rows.splice(i, 1);
      return Promise.resolve([]);
    }
    return Promise.resolve(rows.filter((r) => r.owner_id === vals[0])); // SELECT list
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
    await stagePendingWake({ ownerId: 's-1' });
    expect(store.rows[1].payload).toBeNull();
  });
});
