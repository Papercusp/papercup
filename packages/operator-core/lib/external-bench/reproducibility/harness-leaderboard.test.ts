import { describe, expect, it } from 'vitest';
import manifest from '../harness-leaderboard-manifest.json' with { type: 'json' };
import { currentBenchmarkProtocolSchema, planCurrentBenchmarkConfirmation, requireCurrentBenchmarkAssignment } from './schema';
import { computePreregHash } from './prereg';
import { currentProtocolFixture, hlbProtocolFixture } from './_protocol-test-fixture';

type Protocol = ReturnType<typeof hlbProtocolFixture>;
const execution = (p: Protocol) => ({ runId: p.runId, armId: p.arms[0].id,
  seed: p.seeds[0], taskId: p.taskIds[0], agent: p.arms[0].agent, model: p.arms[0].model,
  effort: p.arms[0].effort, account: p.arms[0].account, budget: p.arms[0].generationBudget,
  sourceProfile: structuredClone(p.sourceProfile) });

describe('frozen Harness Leaderboard protocol (P-023)', () => {
  describe.each(['terminal-bench-2.1', 'deep-swe'] as const)('%s', suite => {
    it.each(['smoke', 'pilot', 'full'] as const)('round-trips the exact %s population without inventing repository sampling', stage => {
      const p = hlbProtocolFixture('hlb-' + suite + '-' + stage, suite, stage);
      const parsed = currentBenchmarkProtocolSchema.parse(p);
      expect(parsed.taskIds).toEqual(manifest.suites[suite].subsets[stage]);
      expect(parsed.sampling).toBeUndefined();
      expect(parsed.confirmation).toBeNull();
      expect(parsed.sourceProfile!.comparison).toBe(stage === 'full' ? 'full-board-descriptive' : 'incomplete-descriptive');
      expect(computePreregHash(currentBenchmarkProtocolSchema.parse(JSON.parse(JSON.stringify(parsed)))))
        .toBe(computePreregHash(parsed));
      expect(requireCurrentBenchmarkAssignment(p, execution(p))).toEqual(parsed);
    });

    it('retains a disjoint confirmatory split as a distinct protocol', () => {
      const p = hlbProtocolFixture('hlb-confirmatory-' + suite, suite, 'pilot', true);
      expect(currentBenchmarkProtocolSchema.safeParse(p).success).toBe(true);
      expect(p.confirmation!.taskIds.every(id => !p.taskIds.includes(id))).toBe(true);
      p.sourceProfile.comparison = 'full-board-descriptive';
      expect(currentBenchmarkProtocolSchema.safeParse(p).success).toBe(false);
    });
  });

  const defects: Array<[string, (p: Protocol) => void]> = [
    ['source revision', p => { p.sourceProfile.sourceRevision = '0'.repeat(40); }],
    ['source registry', p => { p.sourceProfile.sourceRegistrySha256 = '0'.repeat(64); }],
    ['manifest identity', p => { Reflect.set(p.sourceProfile, 'manifestSha256', '0'.repeat(64)); }],
    ['dataset revision', p => { p.sourceProfile.datasetRevision = '0'.repeat(40); }],
    ['Harbor version', p => { p.sourceProfile.harborVersion = '0.23.0' as never; }],
    ['network restriction', p => { p.sourceProfile.networkPolicy = 'enforced'; }],
    ['missing task', p => { p.taskIds.pop(); }],
    ['reordered tasks', p => { p.taskIds.reverse(); }],
    ['excluded task', p => { p.taskIds[0] = Object.keys(manifest.suites['terminal-bench-2.1'].excluded)[0]; }],
    ['missing exclusion', p => { p.exclusions.pop(); }],
    ['stage relabel', p => { p.sourceProfile.stage = 'full'; }],
    ['full-board relabel', p => { p.sourceProfile.comparison = 'full-board-descriptive'; }],
    ['missing generation slot', p => { p.seeds.pop(); }],
    ['duplicate generation slot', p => { p.seeds[2] = p.seeds[0]; }],
    ['weights mismatch', p => { p.sourceProfile.models.baseline.weightsRevision = 'other-weights'; }],
    ['precision mismatch', p => { p.sourceProfile.models.baseline.precision = 'other-precision'; }],
    ['context limit mismatch', p => { p.sourceProfile.models.baseline.contextTokens = 900000; }],
    ['output limit mismatch', p => { p.sourceProfile.models.baseline.outputTokens = 2048; }],
    ['unbound input ceiling', p => { delete p.priceSchedule.rates[0].inputTokenCeiling; delete p.priceSchedule.rates[0].inputTokenCeilingSourceSha256; }],
    ['unbound output ceiling', p => { delete p.priceSchedule.rates[0].outputTokenCeiling; }],
    ['input ceiling overflow', p => { p.priceSchedule.rates[0].inputTokenCeiling = 2000000; }],
    ['output ceiling under-reserves', p => { Object.values(p.sourceProfile.models).forEach(model => { model.outputTokens = 8192; }); }],
    ['model mismatch', p => { p.arms[1].model = 'different'; }],
    ['effort mismatch', p => { p.arms[1].effort = 'low'; }],
    ['unsupported effort', p => { p.sourceProfile.models.papercusp.supportedEfforts = ['low']; }],
    ['provider mismatch', p => { p.sourceProfile.models.papercusp.provider = 'anthropic'; }],
    ['resolved model mismatch', p => { p.sourceProfile.models.papercusp.resolvedModelId = 'different'; }],
    ['edited registry snapshot', p => { p.sourceProfile.modelRegistry.snapshotId = 'bad'; }],
    ['missing arm pins', p => { delete p.sourceProfile.models.baseline; }],
    ['extra arm pins', p => { p.sourceProfile.models.foreign = p.sourceProfile.models.baseline; }],
    ['missing verifier', p => { delete p.sourceProfile.verifiers[p.taskIds[0]]; }],
    ['missing image', p => { delete p.grader.images![p.taskIds[0]]; }],
    ['extra image', p => { p.grader.images!.foreign = p.grader.images![p.taskIds[0]]; }],
    ['missing dataset digest', p => { delete p.grader.datasetSha256; }],
    ['mutable image', p => { p.grader.images![p.taskIds[0]] = 'fixture:latest'; }],
    ['unmeasured runtime', p => { p.arms[0].runtime.runtimeRevision = 'unknown'; }],
    ['unmeasured source', p => { p.arms[0].runtime.sourceRevision = 'unknown'; }],
    ['context overflow', p => { p.sourceProfile.models.papercusp.outputTokens = 2000000; }],
    ['compaction overflow', p => { p.sourceProfile.models.papercusp.compactionLimitTokens = 2000000; }],
    ['timeout overflow', p => { p.sourceProfile.agentTimeoutMs = 1; }],
    ['descriptive superiority claim', p => { p.stopping.superiorityClaim = 'withheld-confirmation-only'; }],
  ];
  it.each(defects)('refuses %s before allocation', (_name, mutate) => {
    const p = hlbProtocolFixture(); mutate(p);
    expect(currentBenchmarkProtocolSchema.safeParse(p).success).toBe(false);
    expect(() => requireCurrentBenchmarkAssignment(p, execution(p))).toThrow();
  });

  it.each(['adapterRevision', 'harborRuntimeSha256', 'networkPolicySha256', 'agentTimeoutMs',
    'verifierTimeoutMs', 'verifiers', 'models', 'modelRegistry'] as const)('requires the %s witness', field => {
    const p = hlbProtocolFixture();
    delete (p.sourceProfile as unknown as Record<string, unknown>)[field];
    expect(currentBenchmarkProtocolSchema.safeParse(p).success).toBe(false);
  });

  it('requires the adapter witness and rejects drift even when it is independently well formed', () => {
    const p = hlbProtocolFixture();
    const launch = execution(p); delete (launch as Partial<typeof launch>).sourceProfile;
    expect(() => requireCurrentBenchmarkAssignment(p, launch)).toThrow(/source profile/);
    launch.sourceProfile = structuredClone(p.sourceProfile);
    launch.sourceProfile.networkPolicySha256 = 'f'.repeat(64);
    expect(() => requireCurrentBenchmarkAssignment(p, launch)).toThrow(/source profile/);
    launch.sourceProfile = structuredClone(p.sourceProfile);
    launch.seed = 4;
    expect(() => requireCurrentBenchmarkAssignment(p, launch)).toThrow(/not in the frozen protocol/);
  });

  it('counts three generation slots independently of infrastructure retry allowance', () => {
    const p = hlbProtocolFixture(); p.stopping.maxAttemptsPerAssignment = 7;
    expect(currentBenchmarkProtocolSchema.safeParse(p).success).toBe(true);
    p.seeds.push(4);
    expect(currentBenchmarkProtocolSchema.safeParse(p).success).toBe(false);
  });

  it('changes immutable identity when a valid measured runtime pin changes', () => {
    const p = hlbProtocolFixture(); const hash = computePreregHash(p);
    p.sourceProfile.verifierTimeoutMs += 1;
    expect(currentBenchmarkProtocolSchema.safeParse(p).success).toBe(true);
    expect(computePreregHash(p)).not.toBe(hash);
  });

  it('keeps task selection separate from a repository-aware inference policy', () => {
    const p = hlbProtocolFixture('hlb-repositories', 'deep-swe', 'pilot', true);
    const roster = [...p.taskIds];
    p.sampling!.taskRepositories[p.taskIds[0]] = 'a-second-fixture-repository';
    expect(currentBenchmarkProtocolSchema.safeParse(p).success).toBe(true);
    expect(p.taskIds).toEqual(roster);
    delete p.sampling!.taskRepositories[p.taskIds[0]];
    expect(currentBenchmarkProtocolSchema.safeParse(p).success).toBe(false);
  });

  it('preserves legacy confirmation and refuses descriptive confirmation planning', () => {
    const old = currentProtocolFixture();
    expect(currentBenchmarkProtocolSchema.safeParse(old).success).toBe(true);
    expect(currentBenchmarkProtocolSchema.safeParse({ ...old, confirmation: null }).success).toBe(false);
    expect(currentBenchmarkProtocolSchema.safeParse({ ...old, stopping: { ...old.stopping, superiorityClaim: 'descriptive-only' } }).success).toBe(false);
    expect(() => planCurrentBenchmarkConfirmation(hlbProtocolFixture())).toThrow();
  });
});
