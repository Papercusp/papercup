/**
 * code-run-adoption.test — the code:run adoption metric (code-run-token-frugality, owner directive
 * 2026-06-26). Pure aggregation with an injected runQuery, so these are deterministic unit tests.
 *
 * TEETH: the opportunity classification reuses the LIVE nudge thresholds (BATCH_NUDGE_THRESHOLD /
 * FANOUT_DISTINCT_THRESHOLD imported from code-run-batch-nudge) — these tests pin the at-threshold
 * boundary so a drift between metric and nudge flips RED.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { BATCH_NUDGE_THRESHOLD, FANOUT_DISTINCT_THRESHOLD } from './code-run-batch-nudge';
import {
  isBatchableSpawn,
  spawnRowsFromCalls,
  summarizeSpawnAdoption,
  computeCodeRunAdoption,
  readCodeRunAdoption,
  rollupAdoption,
  gradeToolUtilization,
  ADOPTION_MIN_SAMPLE,
  ADOPTION_CACHE_TTL_MS,
  CODE_RUN_ADOPTION_SQL,
  __resetCodeRunAdoptionCacheForTests,
  type CallRow,
  type SpawnAdoptionRow,
} from './code-run-adoption';

// The herd guard (EI-6889) is module-level state — reset it before every case so the memo/in-flight
// maps never leak a result across tests.
beforeEach(() => __resetCodeRunAdoptionCacheForTests());

const fanTools = ['plans:get', 'work_items:get', 'docs:search', 'coord:inbox'];

function calls(spawnId: string, role: string, day: string, toolNames: string[]): CallRow[] {
  return toolNames.map((toolName) => ({ spawnId, role, day, toolName }));
}

describe('isBatchableSpawn — reuses the live nudge thresholds', () => {
  it('same-tool AT the threshold is an opportunity; one below is not', () => {
    expect(isBatchableSpawn({ maxSameTool: BATCH_NUDGE_THRESHOLD, distinctTools: 1 })).toBe(true);
    expect(isBatchableSpawn({ maxSameTool: BATCH_NUDGE_THRESHOLD - 1, distinctTools: 1 })).toBe(false);
  });

  it('distinct-tools AT the fan-out threshold is an opportunity; one below is not', () => {
    expect(isBatchableSpawn({ maxSameTool: 1, distinctTools: FANOUT_DISTINCT_THRESHOLD })).toBe(true);
    expect(isBatchableSpawn({ maxSameTool: 1, distinctTools: FANOUT_DISTINCT_THRESHOLD - 1 })).toBe(false);
  });
});

describe('spawnRowsFromCalls — excludes batch tools from the work counts', () => {
  it('does NOT count code:run / recipes:* toward work, but DOES set usedCodeRun', () => {
    const rows = spawnRowsFromCalls([
      ...calls('s1', 'bee', '2026-06-26', ['code:run', 'recipes:search', 'plans:get']),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ workCalls: 1, distinctTools: 1, maxSameTool: 1, usedCodeRun: true });
  });

  it('matches both name forms (code_run / code:run) for the adoption signal', () => {
    const rows = spawnRowsFromCalls(calls('s1', 'bee', '2026-06-26', ['code_run', 'plans:get']));
    expect(rows[0].usedCodeRun).toBe(true);
  });
});

describe('computeCodeRunAdoption — end-to-end raw rows → per-(role,day) summary', () => {
  it('computes opportunity + adoption correctly for a mixed population', () => {
    const day = '2026-06-26';
    const raw: CallRow[] = [
      ...calls('A', 'bee', day, fanTools), // fan-out opportunity, NOT adopted
      ...calls('B', 'bee', day, [...fanTools, 'code:run']), // fan-out opportunity, ADOPTED
      ...calls('C', 'bee', day, ['plans:get', 'docs:get']), // 2 calls — NOT an opportunity
    ];
    const [sum] = computeCodeRunAdoption(raw);
    expect(sum).toMatchObject({
      role: 'bee',
      day,
      spawns: 3,
      opportunitySpawns: 2,
      opportunitySpawnsUsingCodeRun: 1,
      codeRunSpawns: 1,
    });
    expect(sum.adoptionRate).toBeCloseTo(0.5, 5);
  });

  it('classifies a same-tool burst as an opportunity', () => {
    const day = '2026-06-26';
    const sameToolBurst = Array(BATCH_NUDGE_THRESHOLD).fill('work_items:get');
    const [sum] = computeCodeRunAdoption(calls('D', 'queen', day, sameToolBurst));
    expect(sum.opportunitySpawns).toBe(1);
    expect(sum.adoptionRate).toBe(0); // had the chance, did not use code:run
  });

  it('a spawn that only ran code:run has no work-opportunity but counts as a code:run spawn', () => {
    const [sum] = computeCodeRunAdoption(calls('E', 'bee', '2026-06-26', Array(5).fill('code:run')));
    expect(sum).toMatchObject({ spawns: 1, opportunitySpawns: 0, codeRunSpawns: 1 });
    expect(sum.adoptionRate).toBeNull(); // no opportunity ⇒ undefined ratio, not 0
  });

  it('buckets independently per role and per day, sorted by role then day', () => {
    const out = computeCodeRunAdoption([
      ...calls('A', 'bee', '2026-06-25', fanTools),
      ...calls('B', 'queen', '2026-06-26', fanTools),
      ...calls('C', 'bee', '2026-06-26', fanTools),
    ]);
    expect(out.map((s) => `${s.role}/${s.day}`)).toEqual([
      'bee/2026-06-25',
      'bee/2026-06-26',
      'queen/2026-06-26',
    ]);
  });
});

describe('rollupAdoption + gradeToolUtilization — the learning-loop signal', () => {
  const day = '2026-06-26';
  // Build N opportunity spawns, `adopted` of them using code:run, for one role.
  function opportunityCalls(role: string, total: number, adopted: number): CallRow[] {
    const rows: CallRow[] = [];
    for (let i = 0; i < total; i++) {
      const spawnId = `${role}-${i}`;
      // a same-tool burst = a batchable opportunity (maxSameTool ≥ BATCH_NUDGE_THRESHOLD)
      for (let k = 0; k < BATCH_NUDGE_THRESHOLD; k++) rows.push({ spawnId, role, day, toolName: 'work_items:get' });
      if (i < adopted) rows.push({ spawnId, role, day, toolName: 'code:run' });
    }
    return rows;
  }

  it('rolls per-(role,day) summaries into one fleet figure', () => {
    const roll = rollupAdoption(computeCodeRunAdoption(opportunityCalls('bee', 10, 4)));
    expect(roll.opportunitySpawns).toBe(10);
    expect(roll.opportunitySpawnsUsingCodeRun).toBe(4);
    expect(roll.adoptionRate).toBeCloseTo(0.4, 5);
  });

  it('grades a ~2% baseline as broken (the number the loop must move)', () => {
    const roll = rollupAdoption(computeCodeRunAdoption(opportunityCalls('bee', 50, 1)));
    expect(gradeToolUtilization(roll).rating).toBe('broken');
    expect(gradeToolUtilization(roll).evidence).toMatch(/adoption 2%/);
  });

  it('grades a healthy fleet (≥60% folded) as healthy, a mid fleet as degraded', () => {
    expect(gradeToolUtilization(rollupAdoption(computeCodeRunAdoption(opportunityCalls('bee', 20, 14)))).rating).toBe('healthy');
    expect(gradeToolUtilization(rollupAdoption(computeCodeRunAdoption(opportunityCalls('bee', 20, 8)))).rating).toBe('degraded');
  });

  it('too small a sample (< ADOPTION_MIN_SAMPLE opportunities) is honest unknown, not broken', () => {
    const roll = rollupAdoption(computeCodeRunAdoption(opportunityCalls('bee', ADOPTION_MIN_SAMPLE - 1, 0)));
    expect(roll.opportunitySpawns).toBeLessThan(ADOPTION_MIN_SAMPLE);
    expect(gradeToolUtilization(roll).rating).toBe('unknown');
  });

  it('no opportunities at all → null rate → unknown', () => {
    expect(rollupAdoption([]).adoptionRate).toBeNull();
    expect(gradeToolUtilization(rollupAdoption([])).rating).toBe('unknown');
  });
});

describe('summarizeSpawnAdoption — adoptionRate edge', () => {
  it('null adoptionRate when there are zero opportunity spawns', () => {
    const rows: SpawnAdoptionRow[] = [
      { role: 'r', day: 'd', workCalls: 1, distinctTools: 1, maxSameTool: 1, usedCodeRun: false },
    ];
    expect(summarizeSpawnAdoption(rows)[0].adoptionRate).toBeNull();
  });
});

describe('readCodeRunAdoption — runs the canonical SQL through an injected runner', () => {
  it('passes sinceDays as the param and maps DB rows into a summary', async () => {
    const captured: { query: string; params: unknown[] }[] = [];
    const fakeRun = async <T,>(query: string, params: unknown[]): Promise<T[]> => {
      captured.push({ query, params });
      return [
        { role: 'bee', day: '2026-06-26', work_calls: 4, distinct_tools: 4, max_same_tool: 1, used_code_run: false },
        { role: 'bee', day: '2026-06-26', work_calls: 5, distinct_tools: 4, max_same_tool: 1, used_code_run: true },
      ] as unknown as T[];
    };
    const out = await readCodeRunAdoption(fakeRun, { sinceDays: 14 });
    expect(captured[0].params).toEqual([14]);
    expect(captured[0].query).toContain('harness_shared.tool_invocations');
    expect(captured[0].query).toBe(CODE_RUN_ADOPTION_SQL);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ spawns: 2, opportunitySpawns: 2, opportunitySpawnsUsingCodeRun: 1 });
    expect(out[0].adoptionRate).toBeCloseTo(0.5, 5);
  });

  it('defaults to a 7-day window', async () => {
    let seen: unknown[] = [];
    await readCodeRunAdoption(async <T,>(_q: string, p: unknown[]): Promise<T[]> => {
      seen = p;
      return [] as unknown as T[];
    });
    expect(seen).toEqual([7]);
  });
});

describe('readCodeRunAdoption — thundering-herd guard (EI-6889)', () => {
  // TEETH: the operator wedge came from N subsystems each launching an independent 7-day scan of
  // harness_shared.tool_invocations. These pin that concurrent + repeated callers collapse onto ONE
  // scan per window, so a fresh full scan can never be triggered per call again.

  const rows = [
    { role: 'bee', day: '2026-07-02', work_calls: 5, distinct_tools: 4, max_same_tool: 1, used_code_run: true },
  ] as const;

  it('SINGLE-FLIGHT: concurrent callers for the same window share ONE scan', async () => {
    let scans = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const runQuery = async <T,>(): Promise<T[]> => {
      scans += 1;
      await gate; // hold every scan open so all callers overlap in-flight
      return rows as unknown as T[];
    };
    // Fire 18 concurrent callers — the observed herd size on 2026-07-02.
    const all = Promise.all(Array.from({ length: 18 }, () => readCodeRunAdoption(runQuery, { sinceDays: 7 })));
    release();
    const results = await all;
    expect(scans).toBe(1); // 18 callers → exactly ONE PG scan
    // Every caller got the same (correct) rollup.
    for (const r of results) expect(r).toEqual(results[0]);
    expect(results[0][0]).toMatchObject({ spawns: 1, opportunitySpawns: 1, opportunitySpawnsUsingCodeRun: 1 });
  });

  it('SHORT-TTL memo: a second call within the TTL reuses the result without re-scanning', async () => {
    let scans = 0;
    let t = 1_000_000;
    const now = (): number => t;
    const runQuery = async <T,>(): Promise<T[]> => {
      scans += 1;
      return rows as unknown as T[];
    };
    await readCodeRunAdoption(runQuery, { sinceDays: 7, now });
    t += ADOPTION_CACHE_TTL_MS - 1; // still inside the window
    await readCodeRunAdoption(runQuery, { sinceDays: 7, now });
    expect(scans).toBe(1); // second call served from the memo
  });

  it('re-scans once the TTL has elapsed', async () => {
    let scans = 0;
    let t = 1_000_000;
    const now = (): number => t;
    const runQuery = async <T,>(): Promise<T[]> => {
      scans += 1;
      return rows as unknown as T[];
    };
    await readCodeRunAdoption(runQuery, { sinceDays: 7, now });
    t += ADOPTION_CACHE_TTL_MS; // past the window (>= TTL)
    await readCodeRunAdoption(runQuery, { sinceDays: 7, now });
    expect(scans).toBe(2);
  });

  it('keys the memo by sinceDays — a different window is a distinct scan', async () => {
    let scans = 0;
    const now = (): number => 1_000_000;
    const runQuery = async <T,>(): Promise<T[]> => {
      scans += 1;
      return rows as unknown as T[];
    };
    await readCodeRunAdoption(runQuery, { sinceDays: 7, now });
    await readCodeRunAdoption(runQuery, { sinceDays: 14, now });
    expect(scans).toBe(2); // 7d and 14d never share a cache entry
  });

  it('does NOT memoize a failed scan — the next call retries', async () => {
    let scans = 0;
    const runQuery = async <T,>(): Promise<T[]> => {
      scans += 1;
      if (scans === 1) throw new Error('pool exhausted');
      return rows as unknown as T[];
    };
    await expect(readCodeRunAdoption(runQuery, { sinceDays: 7 })).rejects.toThrow('pool exhausted');
    // In-flight slot cleared + failure not cached → the retry actually re-runs and succeeds.
    const out = await readCodeRunAdoption(runQuery, { sinceDays: 7 });
    expect(scans).toBe(2);
    expect(out[0]).toMatchObject({ spawns: 1 });
  });
});

// ── code-run-self-state-adoption-2026-07-03 P-006: poller exclusion ───────────────────

describe('spawnRowsFromCalls — excludes poller tools from the work counts (P-006)', () => {
  it('an activity:recent 2×-per-spawn poller is NOT a batchable opportunity', () => {
    const rows = spawnRowsFromCalls([
      { spawnId: 'p1', role: 'operator', day: '2026-07-03', toolName: 'activity:recent' },
      { spawnId: 'p1', role: 'operator', day: '2026-07-03', toolName: 'activity:recent' },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].maxSameTool).toBe(0);
    expect(rows[0].distinctTools).toBe(0);
    expect(isBatchableSpawn(rows[0])).toBe(false);
  });

  it('a real same-tool burst on a non-poller tool still counts', () => {
    const rows = spawnRowsFromCalls([
      { spawnId: 'r1', role: 'bee', day: '2026-07-03', toolName: 'work_items:get' },
      { spawnId: 'r1', role: 'bee', day: '2026-07-03', toolName: 'work_items:get' },
    ]);
    expect(isBatchableSpawn(rows[0])).toBe(true);
  });
});
