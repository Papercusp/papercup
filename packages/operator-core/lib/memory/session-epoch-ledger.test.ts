/**
 * Unit pins for the session-epoch surfaced-memory ledger
 * (memory-delivery-unification-2026-07-12 P-002). Mirrors the fake-sql
 * pattern of bump-last-surfaced.test.ts: the contract under test is the
 * defensive posture (guards, uuid filtering, relation-missing latch) and
 * the statement shapes — the SQL itself is exercised by the migration-run
 * integration suites.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  currentSessionEpoch,
  bumpSessionEpoch,
  alreadySurfacedIds,
  stampSurfaced,
  _resetSessionEpochLedgerForTests,
} from './session-epoch-ledger';
import type { SqlTag } from './bump-last-surfaced';

const UUID_A = '11111111-1111-1111-1111-111111111111';
const UUID_B = '22222222-2222-2222-2222-222222222222';

function makeSql(opts?: {
  rows?: unknown[];
  impl?: (text: string, values: unknown[]) => Promise<unknown>;
}) {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const sql = (async (template: TemplateStringsArray, ...values: unknown[]) => {
    const text = template.join('?');
    calls.push({ text, values });
    if (opts?.impl) return opts.impl(text, values);
    return opts?.rows ?? [];
  }) as unknown as SqlTag;
  return { sql, calls };
}

beforeEach(() => {
  _resetSessionEpochLedgerForTests();
});

describe('currentSessionEpoch', () => {
  it('returns 0 for an empty sessionId without querying', async () => {
    const { sql, calls } = makeSql();
    expect(await currentSessionEpoch(sql, '')).toBe(0);
    expect(calls.length).toBe(0);
  });

  it('returns 0 when the session has no row', async () => {
    const { sql } = makeSql({ rows: [] });
    expect(await currentSessionEpoch(sql, 'sid-1')).toBe(0);
  });

  it('returns the stored epoch', async () => {
    const { sql } = makeSql({ rows: [{ epoch: 3 }] });
    expect(await currentSessionEpoch(sql, 'sid-1')).toBe(3);
  });

  it('returns 0 on error (best-effort)', async () => {
    const { sql } = makeSql({ impl: async () => { throw new Error('pg down'); } });
    expect(await currentSessionEpoch(sql, 'sid-1')).toBe(0);
  });
});

describe('bumpSessionEpoch', () => {
  it('returns the new epoch and garbage-collects superseded rows', async () => {
    const { sql, calls } = makeSql({
      impl: async (text) => (text.includes('RETURNING') ? [{ epoch: 2 }] : []),
    });
    expect(await bumpSessionEpoch(sql, 'sid-1')).toBe(2);
    // upsert + per-session GC + age GC
    expect(calls.length).toBe(3);
    expect(calls[0].text).toContain('memory_session_epochs');
    expect(calls[0].text).toContain('ON CONFLICT');
    expect(calls[1].text).toContain('DELETE FROM harness_shared.memory_session_surfaced');
    expect(calls[1].text).toContain('epoch <');
    expect(calls[2].text).toContain('surfaced_at <');
  });

  it('returns null on failure', async () => {
    const { sql } = makeSql({ impl: async () => { throw new Error('nope'); } });
    expect(await bumpSessionEpoch(sql, 'sid-1')).toBeNull();
  });

  it('returns null for an empty sessionId without querying', async () => {
    const { sql, calls } = makeSql();
    expect(await bumpSessionEpoch(sql, '')).toBeNull();
    expect(calls.length).toBe(0);
  });
});

describe('alreadySurfacedIds', () => {
  it('maps rows to a set', async () => {
    const { sql } = makeSql({ rows: [{ id: UUID_A }] });
    const got = await alreadySurfacedIds(sql, 'sid-1', 0, [UUID_A, UUID_B]);
    expect(got).toEqual(new Set([UUID_A]));
  });

  it('filters non-uuid ids and skips the query when none survive', async () => {
    const { sql, calls } = makeSql();
    const got = await alreadySurfacedIds(sql, 'sid-1', 0, ['nope', 'also bad']);
    expect(got.size).toBe(0);
    expect(calls.length).toBe(0);
  });

  it('returns the empty set on error (degrades to no-dedup)', async () => {
    const { sql } = makeSql({ impl: async () => { throw new Error('pg down'); } });
    const got = await alreadySurfacedIds(sql, 'sid-1', 0, [UUID_A]);
    expect(got.size).toBe(0);
  });
});

describe('stampSurfaced', () => {
  it('inserts with the port tag', async () => {
    const { sql, calls } = makeSql();
    expect(await stampSurfaced(sql, 'sid-1', 1, [UUID_A], 'claim')).toBe(true);
    expect(calls.length).toBe(1);
    expect(calls[0].text).toContain('INSERT INTO harness_shared.memory_session_surfaced');
    expect(calls[0].text).toContain('ON CONFLICT');
    expect(calls[0].values).toContain('claim');
  });

  it('no-ops (true) when no valid uuid survives the filter', async () => {
    const { sql, calls } = makeSql();
    expect(await stampSurfaced(sql, 'sid-1', 1, ['bad-id'], 'claim')).toBe(true);
    expect(calls.length).toBe(0);
  });

  it('returns false on error', async () => {
    const { sql } = makeSql({ impl: async () => { throw new Error('pg down'); } });
    expect(await stampSurfaced(sql, 'sid-1', 1, [UUID_A], 'claim')).toBe(false);
  });
});

describe('relation-missing latch', () => {
  it('caches "relation does not exist" as a process-wide no-op until reset', async () => {
    const boom = makeSql({
      impl: async () => {
        throw new Error('relation "harness_shared.memory_session_surfaced" does not exist');
      },
    });
    await alreadySurfacedIds(boom.sql, 'sid-1', 0, [UUID_A]);
    // Latched: subsequent calls skip SQL entirely.
    const after = makeSql({ rows: [{ epoch: 9 }] });
    expect(await currentSessionEpoch(after.sql, 'sid-1')).toBe(0);
    expect(await stampSurfaced(after.sql, 'sid-1', 0, [UUID_A], 'x')).toBe(false);
    expect(after.calls.length).toBe(0);
    // Reset restores.
    _resetSessionEpochLedgerForTests();
    expect(await currentSessionEpoch(after.sql, 'sid-1')).toBe(9);
    expect(after.calls.length).toBe(1);
  });
});
