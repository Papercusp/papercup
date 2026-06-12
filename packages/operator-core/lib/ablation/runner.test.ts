/**
 * runner.test.ts — the shadow-ablation cycle orchestration (FB-09 / P-023).
 * Hermetic: fake scenario runner + injected store seams; zero LLM, zero PG,
 * zero flags. The LLM-truthy legs live in the scenario suite itself; this
 * pins the cycle mechanics (snapshot variants, rotation, budget cap, row
 * shape, replay-leg isolation).
 */
import { describe, expect, it } from 'vitest';
import type { RunReport, Scenario, ScenarioVariant } from '@papercusp/testing-shell/llm';

import { SU_PLAYBOOK_FRAMING } from '../llm-testing/targets/su';
import { extractAblatableRules } from './rules';
import type { InsertAblationRunInput } from './store';
import { pickRuleForRotation, runAblationCycle, SNAPSHOT_BASELINE_VARIANT } from './runner';

const BODY = [
  '## Rules',
  '',
  '- **Rule alpha is load-bearing.** Always do the alpha thing before anything else happens here.',
  '- **Rule beta is filler.** This sentence exists to be removed by a passing sedimentologist.',
  '- **Rule gamma is filler too.** Another removable sentence of sufficient length to register.',
  '',
].join('\n');

function fakeReport(scenarioId: string, opts: { passed: boolean; costUsd?: number; tone?: number }): RunReport {
  return {
    scenarioId,
    runs: [
      {
        status: opts.passed ? 'passed' : 'failed',
        summary: { totalCostUsd: opts.costUsd ?? 0.1, turns: [], toolInvocations: [] },
        violations: [],
        judge: { scores: { tone: opts.tone ?? 4 }, findings: [], notes: '' },
      },
    ],
    verdict: opts.passed ? 'pass' : 'fail',
    varianceByAxis: {},
    varianceFindings: [],
  } as unknown as RunReport;
}

const SCENARIOS = [{ id: 's1' }, { id: 's2' }] as unknown as Scenario[];

interface CallLog {
  scenarioId: string;
  variant: ScenarioVariant | undefined;
}

function makeDeps(opts: {
  behavior?: (scenarioId: string, variantId: string) => { passed: boolean; costUsd?: number };
  lastAblated?: Map<string, string>;
  replayLeg?: NonNullable<Parameters<typeof runAblationCycle>[1]['replayLeg']>;
}) {
  const calls: CallLog[] = [];
  const inserted: InsertAblationRunInput[] = [];
  const behavior = opts.behavior ?? (() => ({ passed: true }));
  const deps: Parameters<typeof runAblationCycle>[1] = {
    loadBody: () => BODY,
    scenarios: () => SCENARIOS,
    runScenarioFn: (async (scenario: Scenario, runnerOpts: { variant?: ScenarioVariant }) => {
      calls.push({ scenarioId: scenario.id, variant: runnerOpts.variant });
      return fakeReport(scenario.id, behavior(scenario.id, runnerOpts.variant?.id ?? 'none'));
    }) as never,
    runnerDeps: {} as never,
    insertRun: async (input) => {
      inserted.push(input);
      return 'row-1';
    },
    lastAblatedAt: async () => opts.lastAblated ?? new Map(),
    readLedgerContext: async () => [{ source: 'repo-scan' }],
    nowMs: () => 1_750_000_000_000,
    log: () => {},
    ...(opts.replayLeg ? { replayLeg: opts.replayLeg } : {}),
  };
  return { deps, calls, inserted };
}

describe('pickRuleForRotation', () => {
  const rules = extractAblatableRules(BODY);

  it('unseen rules first in file order, then the stalest', () => {
    expect(pickRuleForRotation(rules, new Map()).ruleKey).toBe(rules[0]!.ruleKey);
    const seen = new Map(rules.map((r, i) => [r.ruleKey, `2026-06-0${i + 1}T00:00:00Z`]));
    expect(pickRuleForRotation(rules, seen).ruleKey).toBe(rules[0]!.ruleKey); // oldest
    seen.set(rules[0]!.ruleKey, '2026-06-09T00:00:00Z');
    expect(pickRuleForRotation(rules, seen).ruleKey).toBe(rules[1]!.ruleKey);
  });
});

describe('runAblationCycle', () => {
  it('runs both arms per scenario on the SAME framed snapshot, differing only in the rule', async () => {
    const { deps, calls, inserted } = makeDeps({});
    const result = await runAblationCycle({ workspaceId: 'w1' }, deps);

    expect(calls).toHaveLength(4); // 2 scenarios × 2 arms
    const baseline = calls[0]!.variant!;
    const ablated = calls[1]!.variant!;
    expect(baseline.id).toBe(SNAPSHOT_BASELINE_VARIANT);
    expect(ablated.id).toBe(`ablate:${result.ruleKey}`);
    const baseText = baseline.configDelta!.systemPromptText as string;
    const ablText = ablated.configDelta!.systemPromptText as string;
    expect(baseText.startsWith(SU_PLAYBOOK_FRAMING)).toBe(true);
    expect(ablText.startsWith(SU_PLAYBOOK_FRAMING)).toBe(true);
    expect(baseText).toContain('Rule alpha is load-bearing');
    expect(ablText).not.toContain('Rule alpha is load-bearing'); // rotation picked the first (unseen) rule
    expect(ablText.length).toBeLessThan(baseText.length);

    expect(inserted).toHaveLength(1);
    const row = inserted[0]!;
    expect(row.verdict).toBe('no-delta');
    expect(row.scenarioCount).toBe(2);
    expect(row.costUsd).toBeCloseTo(0.4);
    expect(row.ledgerContext).toEqual([{ source: 'repo-scan' }]);
    expect(row.detail.scenarios).toHaveLength(2);
    expect(result.runRowId).toBe('row-1');
  });

  it('scores load-bearing when the ablated arm regresses (thresholds tuned for the suite size)', async () => {
    const { deps, inserted } = makeDeps({
      behavior: (_s, variantId) => ({ passed: variantId === SNAPSHOT_BASELINE_VARIANT }),
    });
    const result = await runAblationCycle(
      { workspaceId: 'w1', thresholds: { minMeasurableScenarios: 2 } },
      deps,
    );
    expect(result.score.verdict).toBe('load-bearing');
    expect(inserted[0]!.passRateDelta).toBeCloseTo(-1);
    expect(result.score.regressions).toEqual(['s1', 's2']);
  });

  it('stops opening scenario pairs at the budget cap and records capped', async () => {
    const { deps, calls, inserted } = makeDeps({
      behavior: () => ({ passed: true, costUsd: 0.6 }),
    });
    const result = await runAblationCycle({ workspaceId: 'w1', maxCycleCostUsd: 1.0 }, deps);
    // s1's two arms spend 1.2 ≥ cap → s2 never opens
    expect(calls).toHaveLength(2);
    expect(result.capped).toBe(true);
    expect(inserted[0]!.capped).toBe(true);
    expect(result.score.verdict).toBe('inconclusive'); // 1 measurable < default 4
  });

  it('honors an explicit ruleKey and rejects an unknown one', async () => {
    const rules = extractAblatableRules(BODY);
    const { deps } = makeDeps({});
    const result = await runAblationCycle({ workspaceId: 'w1', ruleKey: rules[2]!.ruleKey }, deps);
    expect(result.ruleKey).toBe(rules[2]!.ruleKey);
    await expect(runAblationCycle({ workspaceId: 'w1', ruleKey: 'nope/nope' }, makeDeps({}).deps)).rejects.toThrow(
      /not found/,
    );
  });

  it('a failing replay leg never sinks the cycle; a succeeding one lands in the row', async () => {
    const failing = makeDeps({ replayLeg: async () => Promise.reject(new Error('replay exploded')) });
    const r1 = await runAblationCycle({ workspaceId: 'w1' }, failing.deps);
    expect(r1.replayLegRan).toBe(false);
    expect(failing.inserted[0]!.replayLeg ?? null).toBeNull();

    const ok = makeDeps({ replayLeg: async () => ({ batteryId: 'b1', cases: 2, compositeDelta: -0.3, costUsd: 1.1 }) });
    const r2 = await runAblationCycle({ workspaceId: 'w1' }, ok.deps);
    expect(r2.replayLegRan).toBe(true);
    expect((ok.inserted[0]!.replayLeg as { compositeDelta: number }).compositeDelta).toBeCloseTo(-0.3);
  });

  it('arm errors record as unmeasurable outcomes, not thrown cycles', async () => {
    const { deps, inserted } = makeDeps({});
    deps.runScenarioFn = (async (scenario: Scenario, runnerOpts: { variant?: ScenarioVariant }) => {
      if (scenario.id === 's2' && runnerOpts.variant?.id !== SNAPSHOT_BASELINE_VARIANT) {
        throw new Error('claim_busy: held elsewhere');
      }
      return fakeReport(scenario.id, { passed: true });
    }) as never;
    const result = await runAblationCycle({ workspaceId: 'w1' }, deps);
    expect(result.score.measurableCount).toBe(1);
    const s2 = inserted[0]!.detail.scenarios.find((s) => s.scenarioId === 's2')!;
    expect(s2.ablated.error).toMatch(/claim_busy/);
  });
});
