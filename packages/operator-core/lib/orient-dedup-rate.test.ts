/**
 * orient-dedup-rate.test — WI-839 metric #3. Pure aggregation + grading with
 * an injected runQuery, so these are deterministic unit tests (mirrors
 * code-run-adoption.test.ts's structure).
 */
import { describe, it, expect } from 'vitest';
import {
  rollupOrientDedup,
  readOrientDedupRate,
  gradeOrientDedupRate,
  ORIENT_DEDUP_RATE_SQL,
  ORIENT_DEDUP_MIN_SAMPLE,
  ORIENT_DEDUP_HEALTHY_BELOW,
  ORIENT_DEDUP_DEGRADED_BELOW,
  type SpawnOrientRow,
} from './orient-dedup-rate';

function rows(n: number, redundant: number): SpawnOrientRow[] {
  const out: SpawnOrientRow[] = [];
  for (let i = 0; i < n; i++) out.push({ spawnId: `s${i}`, oriented: true, redundant: i < redundant });
  return out;
}

describe('rollupOrientDedup — folds per-spawn rows', () => {
  it('counts only oriented spawns, and how many of those are also redundant', () => {
    const roll = rollupOrientDedup([
      { spawnId: 'a', oriented: true, redundant: true },
      { spawnId: 'b', oriented: true, redundant: false },
      { spawnId: 'c', oriented: false, redundant: true }, // not oriented — ignored entirely
    ]);
    expect(roll.orientedSpawns).toBe(2);
    expect(roll.alsoRedundantSpawns).toBe(1);
    expect(roll.pctRedundant).toBe(50);
  });

  it('no oriented spawns → null pctRedundant', () => {
    const roll = rollupOrientDedup([{ spawnId: 'a', oriented: false, redundant: true }]);
    expect(roll.orientedSpawns).toBe(0);
    expect(roll.pctRedundant).toBeNull();
  });

  it('empty input → null pctRedundant', () => {
    expect(rollupOrientDedup([]).pctRedundant).toBeNull();
  });

  it('rounds to 1 decimal', () => {
    // 1/3 = 33.333...% → 33.3
    const roll = rollupOrientDedup(rows(3, 1));
    expect(roll.pctRedundant).toBe(33.3);
  });
});

describe('gradeOrientDedupRate — cutoffs (lower pctRedundant is healthier)', () => {
  it('too small a sample (< ORIENT_DEDUP_MIN_SAMPLE) is honest unknown', () => {
    const roll = rollupOrientDedup(rows(ORIENT_DEDUP_MIN_SAMPLE - 1, 0));
    expect(gradeOrientDedupRate(roll).rating).toBe('unknown');
  });

  it('below HEALTHY_BELOW is healthy', () => {
    const roll = rollupOrientDedup(rows(20, 0)); // 0% redundant
    expect(gradeOrientDedupRate(roll).rating).toBe('healthy');
  });

  it('between HEALTHY_BELOW and DEGRADED_BELOW is degraded', () => {
    const roll = rollupOrientDedup(rows(20, 8)); // 40% redundant
    expect(roll.pctRedundant).toBeGreaterThanOrEqual(ORIENT_DEDUP_HEALTHY_BELOW);
    expect(roll.pctRedundant!).toBeLessThan(ORIENT_DEDUP_DEGRADED_BELOW);
    expect(gradeOrientDedupRate(roll).rating).toBe('degraded');
  });

  it('the ~100% baseline is broken', () => {
    const roll = rollupOrientDedup(rows(20, 20));
    expect(gradeOrientDedupRate(roll).rating).toBe('broken');
    expect(gradeOrientDedupRate(roll).evidence).toMatch(/100% of coord:orient spawns/);
  });
});

describe('readOrientDedupRate — runs the canonical SQL through an injected runner', () => {
  it('canonical SQL ignores coord:orient internal subcalls by requiring post-orient follow-ups', () => {
    expect(ORIENT_DEDUP_RATE_SQL).toContain("tool_name='coord:orient'");
    expect(ORIENT_DEDUP_RATE_SQL).toContain('min(invoked_at) AS first_orient_at');
    expect(ORIENT_DEDUP_RATE_SQL).toContain('t.invoked_at > o.first_orient_at');
    expect(ORIENT_DEDUP_RATE_SQL).toContain('coalesce(redundant, false) AS redundant');
  });

  it('passes sinceHours as the param and maps DB rows into a rollup', async () => {
    const captured: { query: string; params: unknown[] }[] = [];
    const fakeRun = async <T,>(query: string, params: unknown[]): Promise<T[]> => {
      captured.push({ query, params });
      return [
        { spawn_id: 'a', oriented: true, redundant: true },
        { spawn_id: 'b', oriented: true, redundant: false },
      ] as unknown as T[];
    };
    const roll = await readOrientDedupRate(fakeRun, { sinceHours: 48 });
    expect(captured[0].params).toEqual([48]);
    expect(captured[0].query).toBe(ORIENT_DEDUP_RATE_SQL);
    expect(roll.orientedSpawns).toBe(2);
    expect(roll.alsoRedundantSpawns).toBe(1);
  });

  it('defaults to a 24-hour window', async () => {
    let seen: unknown[] = [];
    await readOrientDedupRate(async <T,>(_q: string, p: unknown[]): Promise<T[]> => {
      seen = p;
      return [] as unknown as T[];
    });
    expect(seen).toEqual([24]);
  });
});
