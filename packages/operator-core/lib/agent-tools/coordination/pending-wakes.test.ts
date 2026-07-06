import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@papercusp/db-org', () => ({ getOrgPg: vi.fn() }));
// Mock workspace-registry so the workspace-isolation tests can assert that
// listAllPendingWakes / countAllPendingWakes scope to the active workspace
// (F-C3/EI-1426).  Default: 'ws-active'.
vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: vi.fn(() => 'ws-active') }));

import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../workspace-registry';
import {
  stagePendingWake,
  listPendingWakes,
  listAllPendingWakes,
  countPendingWakes,
  countAllPendingWakes,
  releasePendingWake,
  clearPendingWakes,
  hasPendingWakeFromSource,
  sweepStalePendingWakes,
  BOARD_READ_LIMIT,
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
    // Faithful to postgres-js: binding `undefined` throws this EXACT error
    // (`UNDEFINED_VALUE: Undefined values are not allowed`). The real driver
    // rejects it at serialization; the previous forgiving fake stored it
    // silently, which is exactly why an `undefined`-binding regression
    // (EI-943) could ship unseen. Reproduce the strictness here.
    for (const v of vals) {
      if (v === undefined) throw new Error('UNDEFINED_VALUE: Undefined values are not allowed');
    }
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
    if (q.includes('SELECT owner_id, count(*)')) {
      // countAllPendingWakes: workspace-filtered GROUP BY (F-C3/EI-1426).
      const ws = vals[0];
      const filtered = rows.filter((r) => r.workspace_id === ws);
      const counts = new Map<string, number>();
      for (const r of filtered) {
        const oid = String(r.owner_id);
        counts.set(oid, (counts.get(oid) ?? 0) + 1);
      }
      return Promise.resolve(
        [...counts.entries()].map(([owner_id, n]) => ({ owner_id, n })),
      );
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
    // hasPendingWakeFromSource: owner + source-prefix LIKE existence probe.
    if (q.includes('LIKE')) {
      const prefix = String(vals[1]).replace(/%$/, '');
      const hit = rows.some(
        (r) => r.owner_id === vals[0] && String(r.source ?? '').startsWith(prefix),
      );
      return Promise.resolve(hit ? [{ '?column?': 1 }] : []);
    }
    // Per-owner SELECT list (listPendingWakes): owner-filtered, id order.
    if (q.includes('WHERE owner_id')) {
      return Promise.resolve(rows.filter((r) => r.owner_id === vals[0]));
    }
    // Fleet-wide board (listAllPendingWakes): workspace-filtered (F-C3/EI-1426),
    // owner-then-id order, bounded by BOARD_READ_LIMIT.
    // vals = [workspaceId, BOARD_READ_LIMIT] (matching the real query).
    if (q.includes('WHERE workspace_id')) {
      const ws = vals[0];
      const limit = typeof vals[vals.length - 1] === 'number' ? Number(vals[vals.length - 1]) : rows.length;
      return Promise.resolve(
        [...rows]
          .filter((r) => r.workspace_id === ws)
          .sort((a, b) =>
            a.owner_id === b.owner_id
              ? Number(a.id) - Number(b.id)
              : String(a.owner_id) < String(b.owner_id)
                ? -1
                : 1,
          )
          .slice(0, limit),
      );
    }
    // Fallback: unfiltered board (should not normally be reached).
    const limit = typeof vals[vals.length - 1] === 'number' ? Number(vals[vals.length - 1]) : rows.length;
    return Promise.resolve(
      [...rows]
        .sort((a, b) =>
          a.owner_id === b.owner_id
            ? Number(a.id) - Number(b.id)
            : String(a.owner_id) < String(b.owner_id)
              ? -1
              : 1,
        )
        .slice(0, limit),
    );
  });
  return { sql, rows };
}

let store: ReturnType<typeof fakeStore>;
beforeEach(() => {
  store = fakeStore();
  vi.mocked(getOrgPg).mockReturnValue({ sql: store.sql } as never);
  vi.mocked(activeWorkspaceId).mockReturnValue('ws-active');
});
afterEach(() => vi.clearAllMocks());

describe('pending-wakes (P-007)', () => {
  it('stage → list → count → release round-trip, oldest-first', async () => {
    await stagePendingWake({ ownerId: 's-1', summary: 'a', source: 'x', workspaceId: 'ws-active' });
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
    const boot = { ownerId: 's-1', summary: 'Watchdog wake (boot)', source: 'hive-watchdog:boot', workspaceId: 'ws-active' };
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
    await stagePendingWake({ ownerId: 's-2', summary: 'theirs', workspaceId: 'ws-active' });
    await stagePendingWake({ ownerId: 's-1', summary: 'a', workspaceId: 'ws-active' });
    await stagePendingWake({ ownerId: 's-1', summary: 'b', workspaceId: 'ws-active' });

    const all = await listAllPendingWakes();
    expect(all.map((w) => [w.ownerId, w.summary])).toEqual([
      ['s-1', 'a'],
      ['s-1', 'b'],
      ['s-2', 'theirs'],
    ]);
  });

  it('hasPendingWakeFromSource matches owner + source prefix only (the watchdog idempotence probe, EI-312)', async () => {
    await stagePendingWake({ ownerId: 's-1', summary: 'boot', source: 'hive-watchdog:boot' });
    await stagePendingWake({ ownerId: 's-2', summary: 'tick', source: 'system:wake-brain' });

    expect(await hasPendingWakeFromSource('s-1', 'hive-watchdog:')).toBe(true);
    expect(await hasPendingWakeFromSource('s-2', 'hive-watchdog:')).toBe(false); // other source
    expect(await hasPendingWakeFromSource('s-3', 'hive-watchdog:')).toBe(false); // other owner
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

// EI-943: coord:wake-queue returned `UNDEFINED_VALUE: Undefined values are not
// allowed` — a postgres-js error thrown when `undefined` reaches a query binding —
// AND timed out (60s) on the agent-less board read (`{action:list}`) against a
// bloated table. The fake `sql` above is now strict (throws the exact driver error
// on any `undefined` bind), so these assert the binding-safety + bounded-read
// invariants the mock-heavy wake-queue.test.ts cannot see.
describe('pending-wakes binding safety + bounded board read (EI-943)', () => {
  it('the agent-less board read binds no undefined and is bounded to BOARD_READ_LIMIT', async () => {
    // More owners than the board cap — the read must not return the whole table.
    for (let i = 0; i < BOARD_READ_LIMIT + 25; i++) {
      await stagePendingWake({ ownerId: `s-${String(i).padStart(4, '0')}`, summary: 'x', workspaceId: 'ws-active' });
    }
    const all = await listAllPendingWakes();
    expect(all.length).toBe(BOARD_READ_LIMIT); // not BOARD_READ_LIMIT + 25 — the scan is bounded
    // A bound `undefined` would have thrown UNDEFINED_VALUE inside the fake; reaching
    // here proves the board query binds only the (numeric) LIMIT.
  });

  it('a full stage → list → release round-trip binds zero undefined values', async () => {
    // Sparse input (no summary / source / payload / workspace) is the historical
    // trigger: every absent field must coalesce to NULL at the binding, never undefined.
    await expect(stagePendingWake({ ownerId: 's-sparse' })).resolves.toBeUndefined();
    const list = await listPendingWakes('s-sparse');
    expect(list).toHaveLength(1);
    expect(list[0].summary).toBeNull();
    expect(list[0].source).toBeNull();
    await expect(releasePendingWake(list[0].id)).resolves.toBeUndefined();
    await expect(countPendingWakes('s-sparse')).resolves.toBe(0);
    // sparse row has no workspaceId so it doesn't appear in the active-workspace board
    await expect(listAllPendingWakes()).resolves.toEqual([]);
  });

  it('a missing owner id fails fast and clearly, never as an opaque postgres bind error', async () => {
    // The real failure mode: a caller hands `undefined` where an owner id is required.
    // It must throw a self-attributing error naming the function — NOT the cryptic
    // `UNDEFINED_VALUE` the watchdog could only see.
    const bad = undefined as unknown as string;
    await expect(listPendingWakes(bad)).rejects.toThrow(/listPendingWakes: ownerId is required/);
    await expect(clearPendingWakes(bad)).rejects.toThrow(/clearPendingWakes: ownerId is required/);
    await expect(countPendingWakes(bad)).rejects.toThrow(/countPendingWakes: ownerId is required/);
    await expect(stagePendingWake({ ownerId: bad })).rejects.toThrow(
      /stagePendingWake: ownerId is required/,
    );
    await expect(hasPendingWakeFromSource(bad, 'x:')).rejects.toThrow(
      /hasPendingWakeFromSource: ownerId is required/,
    );
    await expect(releasePendingWake(undefined as unknown as number)).rejects.toThrow(
      /releasePendingWake: id must be a finite number/,
    );
  });
});

// EI-1426 / F-C3: listAllPendingWakes and countAllPendingWakes MUST scope to the
// active workspace. getOrgPg() bypasses RLS — without the WHERE workspace_id = ?
// filter, every workspace's staged wakes appear in one board (data leakage) and,
// on a debris-laden table with no workspace_id index, the full seqscan causes
// repeated 60s timeouts.  Migration 311 adds the missing composite index; these
// tests verify the workspace isolation the index is built to accelerate.
describe('pending-wakes workspace isolation (F-C3 / EI-1426)', () => {
  it('listAllPendingWakes excludes wakes from OTHER workspaces', async () => {
    await stagePendingWake({ ownerId: 's-mine', summary: 'active', workspaceId: 'ws-active' });
    await stagePendingWake({ ownerId: 's-other', summary: 'foreign', workspaceId: 'ws-other' });

    vi.mocked(activeWorkspaceId).mockReturnValue('ws-active');
    const all = await listAllPendingWakes();

    expect(all.map((w) => w.ownerId)).toEqual(['s-mine']); // foreign workspace is invisible
    expect(all.every((w) => w.workspaceId === 'ws-active')).toBe(true);
  });

  it('listAllPendingWakes returns NOTHING when the active workspace has no staged wakes', async () => {
    await stagePendingWake({ ownerId: 's-other', summary: 'nope', workspaceId: 'ws-other' });

    vi.mocked(activeWorkspaceId).mockReturnValue('ws-empty');
    expect(await listAllPendingWakes()).toEqual([]);
  });

  it('countAllPendingWakes badge counts are scoped to the active workspace', async () => {
    await stagePendingWake({ ownerId: 's-a', summary: 'x', workspaceId: 'ws-active' });
    await stagePendingWake({ ownerId: 's-a', summary: 'y', workspaceId: 'ws-active' });
    await stagePendingWake({ ownerId: 's-b', summary: 'z', workspaceId: 'ws-active' });
    // Foreign workspace rows must not inflate the badge
    await stagePendingWake({ ownerId: 's-a', summary: 'foreign', workspaceId: 'ws-foreign' });

    vi.mocked(activeWorkspaceId).mockReturnValue('ws-active');
    const counts = await countAllPendingWakes();

    expect(counts.get('s-a')).toBe(2); // not 3 — foreign row excluded
    expect(counts.get('s-b')).toBe(1);
    expect(counts.has('ws-foreign')).toBe(false);
  });

  it('switching the active workspace changes which wakes are visible', async () => {
    await stagePendingWake({ ownerId: 's-ws1', summary: 'ws1-wake', workspaceId: 'ws-1' });
    await stagePendingWake({ ownerId: 's-ws2', summary: 'ws2-wake', workspaceId: 'ws-2' });

    vi.mocked(activeWorkspaceId).mockReturnValue('ws-1');
    const from1 = await listAllPendingWakes();
    expect(from1.map((w) => w.ownerId)).toEqual(['s-ws1']);

    vi.mocked(activeWorkspaceId).mockReturnValue('ws-2');
    const from2 = await listAllPendingWakes();
    expect(from2.map((w) => w.ownerId)).toEqual(['s-ws2']);
  });
});
