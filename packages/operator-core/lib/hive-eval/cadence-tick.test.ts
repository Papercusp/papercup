/**
 * Cadence-tick gate tests (HE-07, P-050) — the Hive-eval battery's monthly pulse refuses
 * unattended spend, dedupes by code SHA, and never throws (the durable-step double-spend guard).
 * Mirrors lib/iq-battery/cadence-tick.test.ts; all deps injected, no PG/git/LLM.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  runHiveEvalCadenceTick,
  ownerBudgetUsd,
  HIVE_EVAL_CADENCE_DEFAULT_REPEATS,
  HIVE_EVAL_CADENCE_DEFAULT_BEE_CAP,
  type HiveEvalCadenceDeps,
  type HiveEvalRunRequest,
} from './cadence-tick';

function deps(over: Partial<HiveEvalCadenceDeps> = {}): { deps: HiveEvalCadenceDeps; ran: HiveEvalRunRequest[]; logs: string[] } {
  const ran: HiveEvalRunRequest[] = [];
  const logs: string[] = [];
  const base: HiveEvalCadenceDeps = {
    currentCodeSha: () => 'abc1234',
    generationExists: async () => false,
    runBattery: async (req) => {
      ran.push(req);
    },
    log: (m) => logs.push(m),
    ...over,
  };
  return { deps: base, ran, logs };
}

const input = (payload: Record<string, unknown> | null) => ({ installSlug: 'papercup', payload });

describe('runHiveEvalCadenceTick gates (P-050)', () => {
  it('REFUSES without an owner-set budget (no unattended whole-Hive spend)', async () => {
    const { deps: d, ran } = deps();
    const out = await runHiveEvalCadenceTick(d, input({}));
    expect(out.action).toBe('refused');
    expect(ran).toHaveLength(0);
    if (out.action === 'refused') expect(out.reason).toMatch(/budgetUsd/);
  });

  it('REFUSES on a non-positive / non-numeric budget', async () => {
    const { deps: d, ran } = deps();
    for (const bad of [0, -5, 'lots', NaN]) {
      const out = await runHiveEvalCadenceTick(d, input({ budgetUsd: bad as unknown as number }));
      expect(out.action).toBe('refused');
    }
    expect(ran).toHaveLength(0);
  });

  it('REFUSES when the code SHA is unknowable', async () => {
    const { deps: d, ran } = deps({ currentCodeSha: () => 'unknown' });
    const out = await runHiveEvalCadenceTick(d, input({ budgetUsd: 25 }));
    expect(out.action).toBe('refused');
    expect(ran).toHaveLength(0);
  });

  it('SKIPS when a generation already exists at this SHA (dedupe / replay guard)', async () => {
    const exists = vi.fn(async () => true);
    const { deps: d, ran } = deps({ generationExists: exists });
    const out = await runHiveEvalCadenceTick(d, input({ budgetUsd: 25 }));
    expect(out.action).toBe('skipped');
    if (out.action === 'skipped') expect(out.codeSha).toBe('abc1234');
    expect(exists).toHaveBeenCalledWith('abc1234');
    expect(ran).toHaveLength(0);
  });

  it('RUNS with a budget + new SHA, passing the corpus defaults through', async () => {
    const { deps: d, ran } = deps();
    const out = await runHiveEvalCadenceTick(d, input({ budgetUsd: 30 }));
    expect(out.action).toBe('ran');
    if (out.action === 'ran') expect(out.capUsd).toBe(30);
    expect(ran).toHaveLength(1);
    expect(ran[0]).toMatchObject({
      harness: 'papercup',
      capUsd: 30,
      repeats: HIVE_EVAL_CADENCE_DEFAULT_REPEATS,
      beeCap: HIVE_EVAL_CADENCE_DEFAULT_BEE_CAP,
      dryRun: false,
    });
    expect(ran[0].scenarioIds).toBeUndefined(); // full corpus
  });

  it('honors payload overrides (scenarioIds / repeats / beeCap / dryRun)', async () => {
    const { deps: d, ran } = deps();
    await runHiveEvalCadenceTick(
      d,
      input({ budgetUsd: 50, scenarioIds: ['serial-pipeline', 'diamond'], repeats: 3, beeCap: 8, dryRun: true }),
    );
    expect(ran[0]).toMatchObject({ repeats: 3, beeCap: 8, dryRun: true });
    expect(ran[0].scenarioIds).toEqual(['serial-pipeline', 'diamond']);
  });

  it('a thrown generation is RETURNED as failed, never re-thrown (no durable-step replay)', async () => {
    const { deps: d } = deps({
      runBattery: async () => {
        throw new Error('live ports unbound (P-051)');
      },
    });
    const out = await runHiveEvalCadenceTick(d, input({ budgetUsd: 25 }));
    expect(out.action).toBe('failed');
    if (out.action === 'failed') expect(out.error).toMatch(/P-051/);
  });
});

describe('ownerBudgetUsd', () => {
  it('accepts a positive finite number, rejects everything else', () => {
    expect(ownerBudgetUsd({ budgetUsd: 12.5 })).toBe(12.5);
    expect(ownerBudgetUsd({ budgetUsd: 0 })).toBeNull();
    expect(ownerBudgetUsd({ budgetUsd: -1 })).toBeNull();
    expect(ownerBudgetUsd({ budgetUsd: 'x' as unknown as number })).toBeNull();
    expect(ownerBudgetUsd(null)).toBeNull();
    expect(ownerBudgetUsd({})).toBeNull();
  });
});
