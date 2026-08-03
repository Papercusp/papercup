import { describe, expect, it, vi } from 'vitest';
import {
  blockedReason,
  classifyPool,
  groupExactDuplicates,
  normalizeForDedup,
  pickSurvivor,
  sweepCorpus,
  type CorpusRow,
  type CorpusSweepDeps,
} from './corpus-sweep';

/**
 * A deliberately-wrong classifier, kept PERMANENTLY as a control.
 *
 * This is the shape the plan explicitly forbids (D-015 §3): a denylist of
 * 'bench' instead of an allowlist of real pools. It admits every pool shape
 * nobody thought of. The safety tests below run against BOTH it and the real
 * `classifyPool`, and assert the control FAILS where the real one passes — so
 * a future refactor that quietly reintroduces denylist semantics cannot leave
 * these tests green.
 */
function denylistClassifier(poolKey: string | null | undefined): string | null {
  if (typeof poolKey !== 'string' || !poolKey.trim()) return null;
  return poolKey === 'bench' ? null : 'admitted';
}

function row(over: Partial<CorpusRow> & { id: string }): CorpusRow {
  return {
    pool: 'harness:papercusp',
    text: 'a memory body',
    createdAt: '2026-01-01T00:00:00.000Z',
    lastSurfacedAt: null,
    origin: 'local',
    shareable: false,
    sourceHive: null,
    invalidAt: null,
    ...over,
  };
}

describe('classifyPool — allowlist, not denylist (D-015 §3)', () => {
  it('admits the three real pools', () => {
    expect(classifyPool('harness:papercusp')).toBe('harness');
    expect(classifyPool('hive:oddsmith-hive')).toBe('hive');
    expect(classifyPool('120f421b-25c9-47f7-8e3b-329c0edd4bf2')).toBe('user');
  });

  it('EXCLUDES the bench fixture pool', () => {
    // 342 rows of another project's content, incl. a production IP
    // (EI-19451290686156597). Sweeping it would "reconcile" fixtures.
    expect(classifyPool('bench')).toBeNull();
  });

  it('EXCLUDES pool shapes it has never seen — the property a denylist cannot hold', () => {
    const unseen = ['workspace:papercusp-workspace', 'scratch', 'eval:run-7', 'harness:', 'hive:'];
    for (const key of unseen) {
      expect(classifyPool(key), `classifyPool(${key})`).toBeNull();
      // The control admits every one of them — which is precisely the bug.
      if (key !== 'harness:' && key !== 'hive:') {
        expect(denylistClassifier(key), `control should admit ${key}`).not.toBeNull();
      }
    }
  });

  it('rejects empty / missing keys', () => {
    expect(classifyPool('')).toBeNull();
    expect(classifyPool('   ')).toBeNull();
    expect(classifyPool(null)).toBeNull();
    expect(classifyPool(undefined)).toBeNull();
  });
});

describe('normalizeForDedup', () => {
  it('folds whitespace and case but nothing meaning-bearing', () => {
    expect(normalizeForDedup('  We   use\nPostgres ')).toBe('we use postgres');
    expect(normalizeForDedup('We use Postgres')).toBe(normalizeForDedup('we  use   postgres'));
  });

  it('does NOT fold two genuinely different bodies', () => {
    expect(normalizeForDedup('we use postgres')).not.toBe(normalizeForDedup('we use mysql'));
    // Punctuation is meaning-bearing and must survive — folding it would let
    // "ship it" and "ship it?" auto-resolve into each other.
    expect(normalizeForDedup('ship it')).not.toBe(normalizeForDedup('ship it?'));
  });
});

describe('blockedReason — auto-resolution is local-only', () => {
  it('spares a shareable row (an UPDATE would broadcast a federation op)', () => {
    expect(blockedReason(row({ id: 'a', shareable: true }))).toBe('shareable');
  });

  it('spares a row that came from a peer', () => {
    expect(blockedReason(row({ id: 'a', origin: 'remote' }))).toBe('federated');
    expect(blockedReason(row({ id: 'a', sourceHive: 'hive:peer' }))).toBe('federated');
  });

  it('spares a row whose window is already closed', () => {
    expect(blockedReason(row({ id: 'a', invalidAt: '2026-02-02T00:00:00.000Z' }))).toBe(
      'already-closed',
    );
  });

  it('clears a plain local row', () => {
    expect(blockedReason(row({ id: 'a' }))).toBeNull();
  });
});

describe('pickSurvivor', () => {
  it('prefers a row recall has surfaced over one it never has', () => {
    const surfaced = row({ id: 'b', lastSurfacedAt: '2026-03-01T00:00:00.000Z' });
    const never = row({ id: 'a', createdAt: '2020-01-01T00:00:00.000Z' });
    expect(pickSurvivor([never, surfaced]).id).toBe('b');
  });

  it('falls back to the oldest when neither was surfaced', () => {
    const older = row({ id: 'z', createdAt: '2020-01-01T00:00:00.000Z' });
    const newer = row({ id: 'a', createdAt: '2026-01-01T00:00:00.000Z' });
    expect(pickSurvivor([newer, older]).id).toBe('z');
  });

  it('is a TOTAL order — same input in any order picks the same survivor', () => {
    const rows = [
      row({ id: 'c' }),
      row({ id: 'a' }),
      row({ id: 'b' }),
    ];
    const first = pickSurvivor(rows).id;
    expect(pickSurvivor([...rows].reverse()).id).toBe(first);
    expect(pickSurvivor([rows[1], rows[2], rows[0]]).id).toBe(first);
  });

  it('does not mutate the caller’s array', () => {
    const rows = [row({ id: 'c' }), row({ id: 'a' })];
    pickSurvivor(rows);
    expect(rows.map((r) => r.id)).toEqual(['c', 'a']);
  });
});

describe('groupExactDuplicates', () => {
  it('groups identical bodies in the SAME pool', () => {
    const groups = groupExactDuplicates([
      row({ id: 'a', text: 'we use postgres', createdAt: '2026-01-01T00:00:00.000Z' }),
      row({ id: 'b', text: 'We  use   Postgres', createdAt: '2026-02-01T00:00:00.000Z' }),
      row({ id: 'c', text: 'something else' }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].survivorId).toBe('a');
    expect(groups[0].redundantIds).toEqual(['b']);
  });

  it('NEVER groups across pools — two pools may hold the same fact legitimately', () => {
    const groups = groupExactDuplicates([
      row({ id: 'a', pool: 'harness:papercusp', text: 'we use postgres' }),
      row({ id: 'b', pool: 'hive:papercusp', text: 'we use postgres' }),
    ]);
    expect(groups).toHaveLength(0);
  });

  it('excludes already-closed rows from grouping', () => {
    const groups = groupExactDuplicates([
      row({ id: 'a', text: 'dup' }),
      row({ id: 'b', text: 'dup', invalidAt: '2026-02-02T00:00:00.000Z' }),
    ]);
    expect(groups).toHaveLength(0);
  });

  it('reports a spared duplicate as blocked instead of redundant', () => {
    const groups = groupExactDuplicates([
      row({ id: 'a', text: 'dup', lastSurfacedAt: '2026-03-01T00:00:00.000Z' }),
      row({ id: 'b', text: 'dup', shareable: true }),
      row({ id: 'c', text: 'dup' }),
    ]);
    expect(groups[0].survivorId).toBe('a');
    expect(groups[0].redundantIds).toEqual(['c']);
    expect(groups[0].blocked).toEqual([{ id: 'b', reason: 'shareable' }]);
  });

  it('ignores blank bodies', () => {
    expect(groupExactDuplicates([row({ id: 'a', text: '  ' }), row({ id: 'b', text: '' })])).toEqual(
      [],
    );
  });
});

function fakeDeps(over: Partial<CorpusSweepDeps> = {}): CorpusSweepDeps {
  return {
    listPools: async () => ['harness:papercusp'],
    listRows: async () => [],
    softForget: async () => true,
    sweepConflicts: async () => [],
    ...over,
  };
}

describe('sweepCorpus', () => {
  it('never reads a pool the allowlist rejects', async () => {
    const listRows = vi.fn(async () => [] as CorpusRow[]);
    const res = await sweepCorpus(
      {},
      fakeDeps({ listPools: async () => ['bench', 'workspace:x', 'harness:papercusp'], listRows }),
    );
    expect(listRows).toHaveBeenCalledTimes(1);
    expect(listRows).toHaveBeenCalledWith('harness:papercusp');
    expect(res.skippedPools.map((s) => s.pool).sort()).toEqual(['bench', 'workspace:x']);
  });

  it('report mode changes NOTHING', async () => {
    const softForget = vi.fn(async () => true);
    const res = await sweepCorpus(
      { mode: 'report' },
      fakeDeps({
        listRows: async () => [row({ id: 'a', text: 'dup' }), row({ id: 'b', text: 'dup' })],
        softForget,
      }),
    );
    expect(softForget).not.toHaveBeenCalled();
    expect(res.totals.redundant).toBe(1);
    expect(res.totals.resolved).toBe(0);
  });

  it('apply mode resolves ONLY the eligible redundant rows', async () => {
    const softForget = vi.fn(async () => true);
    const res = await sweepCorpus(
      { mode: 'apply' },
      fakeDeps({
        listRows: async () => [
          row({ id: 'keep', text: 'dup', lastSurfacedAt: '2026-03-01T00:00:00.000Z' }),
          row({ id: 'drop', text: 'dup' }),
          row({ id: 'shared', text: 'dup', shareable: true }),
        ],
        softForget,
      }),
    );
    expect(softForget).toHaveBeenCalledTimes(1);
    expect(softForget).toHaveBeenCalledWith('drop');
    expect(res.totals.resolved).toBe(1);
    expect(res.totals.blocked).toBe(1);
  });

  it('NEVER auto-resolves a contradiction, even in apply mode', async () => {
    const softForget = vi.fn(async () => true);
    const fileConflict = vi.fn(async () => {});
    const res = await sweepCorpus(
      { mode: 'apply' },
      fakeDeps({
        listRows: async () => [row({ id: 'x', text: 'we use postgres' })],
        sweepConflicts: async () => [
          { aId: 'x', aText: 'we use postgres', bId: 'y', bText: 'we use mysql', summary: 'both cannot hold' },
        ],
        softForget,
        fileConflict,
      }),
    );
    expect(softForget).not.toHaveBeenCalled();
    expect(fileConflict).toHaveBeenCalledTimes(1);
    expect(res.totals.conflictPairs).toBe(1);
  });

  it('bounds the LLM layer by maxPoolsJudged', async () => {
    const sweepConflicts = vi.fn(async () => []);
    const res = await sweepCorpus(
      { maxPoolsJudged: 1 },
      fakeDeps({
        listPools: async () => ['harness:papercusp', 'hive:papercusp', 'hive:oddsmith-hive'],
        sweepConflicts,
      }),
    );
    expect(sweepConflicts).toHaveBeenCalledTimes(1);
    expect(res.pools.filter((p) => p.judged)).toHaveLength(1);
  });

  it('skips the LLM layer entirely when judgeConflicts is false', async () => {
    const sweepConflicts = vi.fn(async () => []);
    await sweepCorpus({ judgeConflicts: false }, fakeDeps({ sweepConflicts }));
    expect(sweepConflicts).not.toHaveBeenCalled();
  });

  it('degrades instead of aborting when a pass throws', async () => {
    const res = await sweepCorpus(
      { mode: 'apply' },
      fakeDeps({
        listPools: async () => ['harness:papercusp', 'hive:papercusp'],
        listRows: async (pool) => {
          if (pool === 'harness:papercusp') throw new Error('pg down');
          return [row({ id: 'a', pool, text: 'dup' }), row({ id: 'b', pool, text: 'dup' })];
        },
        sweepConflicts: async () => {
          throw new Error('judge down');
        },
      }),
    );
    expect(res.pools).toHaveLength(2);
    expect(res.totals.resolved).toBe(1);
    expect(res.totals.conflictPairs).toBe(0);
  });

  it('counts a failed resolve rather than reporting it as resolved', async () => {
    const res = await sweepCorpus(
      { mode: 'apply' },
      fakeDeps({
        listRows: async () => [row({ id: 'a', text: 'dup' }), row({ id: 'b', text: 'dup' })],
        softForget: async () => false,
      }),
    );
    expect(res.totals.resolved).toBe(0);
    expect(res.pools[0].resolveErrors).toBe(1);
  });

  it('honours an explicit pool list, still allowlist-checked', async () => {
    const listPools = vi.fn(async () => ['harness:papercusp']);
    const listRows = vi.fn(async () => [] as CorpusRow[]);
    const res = await sweepCorpus({ pools: ['hive:papercusp', 'bench'] }, fakeDeps({ listPools, listRows }));
    expect(listPools).not.toHaveBeenCalled();
    expect(listRows).toHaveBeenCalledExactlyOnceWith('hive:papercusp');
    expect(res.skippedPools).toEqual([{ pool: 'bench', reason: 'not-a-real-pool' }]);
  });
});
