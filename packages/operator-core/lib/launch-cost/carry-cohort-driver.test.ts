import { parse as parseToml } from '@iarna/toml';
import { describe, expect, it } from 'vitest';
import { buildCarryTaskEvaluations, buildCohortConfigToml, buildHistoryFiller, cohortArmPlan, reserveCohortBudget,
  priceUsageRow, type CohortArmRecord, type CohortSourceRecord, type CohortUsageRow } from './carry-cohort-driver';
import { createCarryTrialRecipe, evaluateCarryTaskPairs } from './launch-cost-metrics';

const recipe = createCarryTrialRecipe();

describe('P-005 carry cohort driver (pure parts)', () => {
  it('builds deterministic inert filler at the requested o200k size', () => {
    const a = buildHistoryFiller(5_000, 'S-I0'), b = buildHistoryFiller(5_000, 'S-I0'), c = buildHistoryFiller(5_000, 'L-I0');
    expect(a.sha256).toBe(b.sha256);
    expect(c.sha256).not.toBe(a.sha256);
    expect(a.estimatedTokens).toBeGreaterThanOrEqual(5_000);
    expect(a.estimatedTokens).toBeLessThan(5_100);
    for (const fact of [recipe.seedText, 'cedar-48f6e9a2', 'amber-29', 'scarlet-17']) expect(a.text).not.toContain(fact);
  });

  it('plans a source as its recipe pairs in AB/BA order, switching model only for T5', () => {
    const plan = cohortArmPlan(recipe, 'S-I0');
    expect(plan.arms).toHaveLength(10);
    expect(plan.arms.map(a => a.armId)).toEqual(recipe.pairs.filter(p => p.sourceId === 'S-I0').flatMap(p => p.arms.map(a => a.id)));
    expect(plan.arms.filter(a => a.pair.taskId === 'T5').every(a => a.model === 'gpt-6-luna')).toBe(true);
    expect(plan.arms.filter(a => a.pair.taskId !== 'T5').every(a => a.model === 'gpt-6-sol')).toBe(true);
    expect(cohortArmPlan(recipe, 'S-I0', ['T1']).arms.map(a => a.armId)).toEqual(['S-I0-T1:control', 'S-I0-T1:candidate']);
    expect(() => cohortArmPlan(recipe, 'X-I9')).toThrow('unknown recipe source');
  });

  it('renders a config whose root provider key precedes every table', () => {
    const toml = buildCohortConfigToml({ provider: { providerId: 'gw', rootLines: ['model_provider = "gw"'],
      tableLines: ['[model_providers.gw]', 'name = "GW"', 'base_url = "http://127.0.0.1:1/v1"', 'wire_api = "responses"'] },
      mcpUrl: 'http://127.0.0.1:2/mcp', mcpToken: 'tok', modelContextWindow: 872_000, autoCompactTokenLimit: 850_000 });
    const parsed = parseToml(toml) as Record<string, any>;
    expect(parsed.model_provider).toBe('gw');
    expect(parsed.model_context_window).toBe(872_000);
    expect(parsed.model_providers.gw.base_url).toBe('http://127.0.0.1:1/v1');
    expect(parsed.mcp_servers.cache_receipts).toEqual({ url: 'http://127.0.0.1:2/mcp', http_headers: { Authorization: 'Bearer tok' } });
    expect(parsed.features.shell_tool).toBe(false);
  });

  const usage = (id: string, session: string, input: number, extra: Partial<CohortUsageRow> = {}): CohortUsageRow => ({
    id, session_id: session, usage_event_key: `k-${id}`, model: 'gpt-6-sol', ts: `2026-09-26T18:00:${id.padStart(2, '0')}Z`,
    input_tokens: input, cache_read_tokens: 1000, cache_creation_tokens: 0, output_tokens: 50, usage_provenance: null, ...extra });
  const arm = (armId: string, threadId: string | null): CohortArmRecord => {
    const [pairId, side] = armId.split(':');
    return { pairId, sourceId: pairId.slice(0, 4), taskId: pairId.slice(5), arm: side as 'control' | 'candidate', armId,
      model: 'gpt-6-sol', threadId, turnIds: [], sourceRef: 'codex:a/b@c', historyInputTokens: 40_000, historyEvidenceRef: 'h',
      predecessorCompletedAtMs: 0, firstDispatchAtMs: 1, firstUsefulAtMs: 2, observedIdleMs: 5_000, idleEvidenceRef: 'i',
      firstUsefulResponseMs: 1_000, completed: true, quality: 'pass', qualityEvidence: { check: { matches: true } }, response: '{}',
      errors: [], workloadFingerprint: 'w', transport: 't', authorizationScope: 'a' };
  };
  const source: CohortSourceRecord = { sourceId: 'S-I0', homeDir: '/tmp/x', threadId: 'src', turnId: 't', sourceRef: 'codex:a/b@c',
    filler: null, history: null, idle: null, preparation: null, carry: null, errors: [] };

  it('maps canonical rows: first two are startup, preparation is charged to the recipe arm, one-request arms stay evaluable', () => {
    const rows = [usage('1', 'src', 40_000), usage('2', 'ctl', 39_000), usage('3', 'cand', 3_000), usage('4', 'cand', 2_000),
      usage('5', 'cand', 900)];
    const evaluations = buildCarryTaskEvaluations(recipe, [arm('S-I0-T1:control', 'ctl'), arm('S-I0-T1:candidate', 'cand')], [source], rows);
    const [control, candidate] = evaluations;
    expect(control.requests).toEqual([{ id: 'ctl:k-2', phase: 'startup', uncachedInputTokens: 39_000 }]);
    expect(candidate.requests.map(r => r.phase)).toEqual(['preparation', 'startup', 'startup', 'work']);
    expect(control.accountingComplete && candidate.accountingComplete).toBe(true);
    const result = evaluateCarryTaskPairs(evaluations);
    expect(result.insufficient.filter(reason => reason.startsWith('missing-startup'))).toEqual([]);
    // An arm with no canonical rows, or whose thread never opened, is not complete accounting.
    expect(buildCarryTaskEvaluations(recipe, [arm('S-I0-T2:control', null)], [source], rows)[0].accountingComplete).toBe(false);
    expect(buildCarryTaskEvaluations(recipe, [arm('S-I0-T1:candidate', 'cand')], [source], rows.filter(r => r.session_id !== 'src'))[0]
      .accountingComplete).toBe(false);
  });

  it('admits the registered full cohort from zero spend and refuses once the charges reach the cap', () => {
    const remainingArms = recipe.pairs.flatMap(p => p.arms.map(a => ({ armId: a.id, sourceId: p.sourceId, arm: a.arm as 'control' | 'candidate', taskId: p.taskId })));
    const base = { recipe, spentArmOf: () => 'S-I0-T1:candidate', remainingArms, remainingPreparations: recipe.sources.map(s => s.id),
      plannedRequestsPerArm: 2, candidateInputTokenLimit: 40_000, defaultOutputTokenLimit: 4_000 };
    const fresh = reserveCohortBudget({ ...base, spent: [] });
    expect(fresh).toMatchObject({ fitsBudget: true, missing: [], exceeded: [] });
    const heavy = Array.from({ length: 80 }, (_, i) => usage(String(i), `s${i}`, 700_000, { output_tokens: 100 }));
    expect(priceUsageRow(heavy[0])).toBeGreaterThan(2);
    const refused = reserveCohortBudget({ ...base, spent: heavy });
    expect(refused.fitsBudget).toBe(false);
    expect(refused.exceeded).toEqual(expect.arrayContaining(['input-token-cap']));
  });
});
