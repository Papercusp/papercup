/**
 * code-run-adoption.test — the code:run adoption metric (code-run-token-frugality, owner directive
 * 2026-06-26). Pure aggregation with an injected runQuery, so these are deterministic unit tests.
 *
 * TEETH: the opportunity classification reuses the LIVE nudge thresholds (BATCH_NUDGE_THRESHOLD /
 * FANOUT_DISTINCT_THRESHOLD imported from code-run-batch-nudge) — these tests pin the at-threshold
 * boundary so a drift between metric and nudge flips RED.
 */
import { describe, it, expect } from 'vitest';
import { BATCH_NUDGE_THRESHOLD, FANOUT_DISTINCT_THRESHOLD } from './code-run-batch-nudge';
import {
  isBatchableSpawn,
  spawnRowsFromCalls,
  summarizeSpawnAdoption,
  computeCodeRunAdoption,
  readCodeRunAdoption,
  CODE_RUN_ADOPTION_SQL,
  type CallRow,
  type SpawnAdoptionRow,
} from './code-run-adoption';

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
