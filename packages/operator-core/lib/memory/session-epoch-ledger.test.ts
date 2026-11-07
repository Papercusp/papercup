/**
 * Unit pins for the session-epoch surfaced-memory ledger
 * (memory-delivery-unification-2026-07-12 P-002). Mirrors the fake-sql
 * pattern of bump-last-surfaced.test.ts: the contract under test is the
 * defensive posture (guards, uuid filtering, relation-missing latch) and
 * the statement shapes — the SQL itself is exercised by the migration-run
 * integration suites.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  currentSessionEpoch,
  bumpSessionEpoch,
  alreadySurfacedIds,
  stampSurfaced,
  _resetSessionEpochLedgerForTests,
  memoryFragmentOffer, stageMemoryEmission, confirmMemoryEmission,
  MEMORY_EMISSION_TTL_MS,
} from './session-epoch-ledger';
import { configureReadCursorStore, InMemoryReadCursorStore, resetReadCursorStore } from '../agent-tools/coordination/read-cursors';
import type { SqlTag } from './bump-last-surfaced';

const UUID_A = '11111111-1111-1111-1111-111111111111';
const UUID_B = '22222222-2222-2222-2222-222222222222';

describe('exact memory emission receipts', () => {
  beforeEach(() => configureReadCursorStore(new InMemoryReadCursorStore()));
  afterEach(() => resetReadCursorStore());
  const offer = (id = UUID_A, epoch = 3, kind: 'memory' | 'corpus' = 'memory') =>
    memoryFragmentOffer(kind, id, epoch, 'turn-start', `- ${id}: complete snowman ☃`);
  const manifest = ({ rendered: _text, ...row }: ReturnType<typeof offer>) => row;

  it('does not stamp preparation, absent output, a wrong owner or a forged fragment', async () => {
    const { sql, calls } = makeSql();
    const row = offer();
    await stageMemoryEmission(sql, 'owner', 'token-a', [row]);
    const inserts = () => calls.filter(c => c.text.includes('INSERT INTO harness_shared.memory_session_surfaced'));
    expect(inserts()).toHaveLength(0);
    expect(await confirmMemoryEmission(sql, 'other-owner', { token: 'token-a', fragments: [manifest(row)] })).toBe(0);
    expect(await confirmMemoryEmission(sql, 'owner', { token: 'wrong-token', fragments: [manifest(row)] })).toBe(0);
    expect(await confirmMemoryEmission(sql, 'owner', { token: 'token-a', fragments: [{ ...manifest(row), bodyBytes: row.bodyBytes - 1 }] })).toBe(0);
    expect(await confirmMemoryEmission(sql, 'owner', { token: 'token-a', fragments: [] })).toBe(0);
    expect(inserts()).toHaveLength(0);
    expect(await confirmMemoryEmission(sql, 'owner', { token: 'token-a', fragments: [manifest(row)] })).toBe(1);
    expect(inserts()).toHaveLength(1);
    expect(await confirmMemoryEmission(sql, 'owner', { token: 'token-a', fragments: [manifest(row)] })).toBe(0);
  });

  it('keeps overlapping port tokens separate and stamps only the exact emitted subset at its captured epoch', async () => {
    const { sql, calls } = makeSql();
    const a = offer(), b = offer(UUID_B, 4), c = offer('WI-123', 3, 'corpus');
    await stageMemoryEmission(sql, 'owner', 'token-a', [a, c]);
    await stageMemoryEmission(sql, 'owner', 'token-b', [{ ...b, port: 'mid-turn' }]);
    expect(await confirmMemoryEmission(sql, 'owner', { token: 'token-b', fragments: [manifest(b)] })).toBe(0);
    expect(await confirmMemoryEmission(sql, 'owner', { token: 'token-a', fragments: [manifest(c)] })).toBe(1);
    expect(calls.filter(c => c.text.includes('INSERT INTO harness_shared.memory_session_surfaced'))).toHaveLength(0);
    const corpusWrite = calls.find(c => c.text.includes('INSERT INTO harness_shared.corpus_session_surfaced'))!;
    expect(corpusWrite.values).toContain(3); // never resolve a newer compaction epoch at confirmation time
    expect(await confirmMemoryEmission(sql, 'owner', { token: 'token-b', fragments: [{ ...manifest(b), port: 'mid-turn' }] })).toBe(1);
  });

  it('retains an emission candidate after a failed ledger write for a later retry', async () => {
    let fail = true;
    const { sql } = makeSql({ impl: async text => {
      if (fail && text.includes('INSERT INTO harness_shared.memory_session_surfaced')) throw new Error('connection interrupted');
      return text.includes('RETURNING memory_id') ? [{ memory_id: UUID_A }] : [];
    } });
    const row = offer();
    await stageMemoryEmission(sql, 'owner', 'token-a', [row]);
    const proof = { token: 'token-a', fragments: [manifest(row)] };
    expect(await confirmMemoryEmission(sql, 'owner', proof)).toBe(0);
    fail = false;
    expect(await confirmMemoryEmission(sql, 'owner', proof)).toBe(1);
  });

  it('abandons expired candidates without advancing delivery, allowing a fresh attempt', async () => {
    const now = vi.spyOn(Date, 'now');
    try {
      now.mockReturnValue(1000);
      const { sql, calls } = makeSql();
      const row = offer();
      await stageMemoryEmission(sql, 'owner', 'expired-token', [row]);
      now.mockReturnValue(1000 + MEMORY_EMISSION_TTL_MS);
      expect(await confirmMemoryEmission(sql, 'owner', { token: 'expired-token', fragments: [manifest(row)] })).toBe(0);
      expect(calls.some(c => c.text.includes('INSERT INTO harness_shared.memory_session_surfaced'))).toBe(false);
      await stageMemoryEmission(sql, 'owner', 'fresh-token', [row]);
      expect(await confirmMemoryEmission(sql, 'owner', { token: 'fresh-token', fragments: [manifest(row)] })).toBe(1);
    } finally { now.mockRestore(); }
  });
});

function makeSql(opts?: {
  rows?: unknown[];
  impl?: (text: string, values: unknown[]) => Promise<unknown>;
}) {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const sql = (async (template: TemplateStringsArray, ...values: unknown[]) => {
    const text = template.join('?');
    calls.push({ text, values });
    if (opts?.impl) return opts.impl(text, values);
    return opts?.rows ?? (text.includes('RETURNING memory_id') || text.includes('RETURNING ref') ? [{ id: 'inserted' }] : []);
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
  it('returns the new epoch; the only GC is the age sweep (superseded-epoch rows KEPT for forensics)', async () => {
    const { sql, calls } = makeSql({
      impl: async (text) => (text.includes('RETURNING') ? [{ epoch: 2 }] : []),
    });
    expect(await bumpSessionEpoch(sql, 'sid-1')).toBe(2);
    // upsert + age GC only — rubric-system-improvements-2026-07-12 P-005: an
    // immediate superseded-epoch DELETE erased drill forensics mid-grade; old
    // rows are dedup-inert (reads filter on the current epoch), so they stay
    // until the age sweep.
    expect(calls.length).toBe(2);
    expect(calls[0].text).toContain('memory_session_epochs');
    expect(calls[0].text).toContain('ON CONFLICT');
    expect(calls[1].text).toContain('surfaced_at <');
    expect(calls.some((c) => c.text.includes('epoch <'))).toBe(false);
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
