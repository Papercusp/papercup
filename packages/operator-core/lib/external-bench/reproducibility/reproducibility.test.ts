/**
 * Pure unit tests for the reproducibility layer (BRIEF 8 / P-010) — the bits that
 * need no DB: canonical JSON, the content-addressed prereg hash, and the
 * deterministic rollout id. DB-backed emit/store/prereg/firewall behaviour is in
 * reproducibility.integration.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { canonicalJson } from './canonical-json';
import { computePreregHash } from './prereg';
import { rolloutIdFor } from './emit';
import { fleetRunIdFor } from './fleet';
import { currentBenchmarkProtocolSchema, planCurrentBenchmarkConfirmation, requireCurrentBenchmarkAssignment } from './schema';
import { currentProtocolFixture } from './_protocol-test-fixture';

describe('current frozen benchmark protocol', () => {
  it('derives withheld power from exact repository counts, never pilot tasks or repeated seeds', () => {
    const protocol = currentProtocolFixture();
    protocol.confirmation.method = 'paired-repository-hoeffding-v1';
    protocol.confirmation.taskIds = ['withheld-1', 'withheld-2'];
    protocol.confirmation.plannedPairedTasks = 2;
    protocol.sampling!.taskRepositories['withheld-2'] = 'another-repo';
    const base = planCurrentBenchmarkConfirmation(protocol);
    expect(base).toMatchObject({ independentRepositories: 2, effectiveRepositories: 2, pairedTasks: 2,
      seedsPerTask: 1, generationAssignments: 4, meetsTarget: false, inferenceAuthorized: false });
    expect(base.repositories).toEqual([{ repository: 'another-repo', pairedTasks: 1 }, { repository: 'withheld-repo', pairedTasks: 1 }]);
    protocol.confirmation.seeds = [2, 3, 4];
    const repeated = planCurrentBenchmarkConfirmation(protocol);
    expect(repeated.generationAssignments).toBe(12);
    expect(repeated.effectiveRepositories).toBe(base.effectiveRepositories);
    expect(repeated.powerLowerBound).toBe(base.powerLowerBound);
    expect(repeated.detectableEffectBound).toBe(base.detectableEffectBound);
    protocol.sampling!.taskRepositories['withheld-2'] = 'withheld-repo';
    expect(planCurrentBenchmarkConfirmation(protocol).independentRepositories).toBe(1);
  });

  it('refuses an unbound method, repository mapping or unspecified confirmation subset', () => {
    const protocol = currentProtocolFixture();
    expect(() => planCurrentBenchmarkConfirmation(protocol)).toThrow(/rejection rule/);
    protocol.confirmation.method = 'paired-repository-hoeffding-v1';
    delete protocol.sampling;
    expect(() => planCurrentBenchmarkConfirmation(protocol)).toThrow(/repository mapping/);
    protocol.sampling = currentProtocolFixture().sampling;
    protocol.confirmation.taskIds.push('withheld-2');
    protocol.sampling!.taskRepositories['withheld-2'] = 'withheld-repo';
    expect(() => planCurrentBenchmarkConfirmation(protocol)).toThrow(/unspecified subset/);
    protocol.confirmation.plannedPairedTasks = 2;
    expect(() => planCurrentBenchmarkConfirmation(protocol)).not.toThrow();
    protocol.confirmation.taskIds[1] = 't1';
    expect(() => planCurrentBenchmarkConfirmation(protocol)).toThrow(/withheld/);
  });

  it('binds a complete declared assignment to the configured launch and equal generation cap', () => {
    const protocol = currentProtocolFixture();
    expect(requireCurrentBenchmarkAssignment(protocol, { runId: 'run-1', armId: 'papercusp', taskId: 't1', seed: 1,
      agent: 'codex', model: 'configured-alias', effort: 'high', account: 'auto', budget: { maxUsd: 3, maxWallClockMs: 100 } })).toEqual(protocol);
  });
  it.each(['taskIds', 'seeds', 'arms', 'aggregateBudgetUsd', 'maxInFlightUsd', 'priceSchedule', 'grader', 'context', 'exclusions', 'stopping', 'confirmation'])
    ('refuses omitted frozen protocol component %s', field => {
      const protocol = currentProtocolFixture() as unknown as Record<string, unknown>; delete protocol[field];
      expect(currentBenchmarkProtocolSchema.safeParse(protocol).success).toBe(false);
    });
  it.each([
    ['duplicate-task', (p: ReturnType<typeof currentProtocolFixture>) => { p.taskIds.push('t1'); }],
    ['duplicate-seed', (p: ReturnType<typeof currentProtocolFixture>) => { p.seeds.push(1); }],
    ['duplicate-arm', (p: ReturnType<typeof currentProtocolFixture>) => { p.arms[1].id = p.arms[0].id; }],
    ['unequal-caps', (p: ReturnType<typeof currentProtocolFixture>) => { p.arms[1].generationBudget.maxUsd = 4; }],
    ['unbounded-exposure', (p: ReturnType<typeof currentProtocolFixture>) => { p.maxInFlightUsd = 61; }],
    ['unpriced-model', (p: ReturnType<typeof currentProtocolFixture>) => { p.arms[0].model = 'other'; }],
    ['withheld-leak', (p: ReturnType<typeof currentProtocolFixture>) => { p.confirmation.taskIds.push('t1'); }],
    ['underreserved-confirmation', (p: ReturnType<typeof currentProtocolFixture>) => { p.confirmation.plannedPairedTasks = 2; }],
    ['missing-context-pin', (p: ReturnType<typeof currentProtocolFixture>) => { p.context.memoryHash = ''; }],
  ])('rejects protocol defect %s', (_name, mutate) => {
    const protocol = currentProtocolFixture(); mutate(protocol);
    expect(currentBenchmarkProtocolSchema.safeParse(protocol).success).toBe(false);
  });
  it('changes the immutable protocol hash for each meaningful identity or policy drift', () => {
    const base = currentProtocolFixture(); const frozen = computePreregHash(base);
    for (const mutate of [
      (p: typeof base) => { p.arms[0].model = 'changed'; },
      (p: typeof base) => { p.arms[0].runtime.promptHash = 'e'.repeat(64); },
      (p: typeof base) => { p.arms[0].runtime.toolsHash = 'e'.repeat(64); },
      (p: typeof base) => { p.grader.version = 'changed'; },
      (p: typeof base) => { p.taskIds = ['changed']; },
      (p: typeof base) => { p.seeds = [2]; },
      (p: typeof base) => { p.aggregateBudgetUsd = 59; },
      (p: typeof base) => { p.exclusions = ['changed']; },
      (p: typeof base) => { p.stopping.maxAttemptsPerAssignment = 2; },
      (p: typeof base) => { p.sampling!.taskRepositories.t1 = 'other-repository'; },
      (p: typeof base) => { p.sampling!.bootstrapSeed = 17; },
      (p: typeof base) => { p.sampling!.bootstrapIterations = 2000; },
      (p: typeof base) => { p.sampling!.ci = 0.9; },
    ]) { const changed = structuredClone(base); mutate(changed); expect(computePreregHash(changed)).not.toBe(frozen); }
  });

  it('requires frozen repository sampling for new launches while preserving older protocol reads', () => {
    const protocol = currentProtocolFixture(); delete protocol.sampling;
    expect(currentBenchmarkProtocolSchema.safeParse(protocol).success).toBe(true);
    expect(() => requireCurrentBenchmarkAssignment(protocol, { runId: 'run-1', armId: 'papercusp', taskId: 't1', seed: 1,
      agent: 'codex', model: 'configured-alias', effort: 'high', account: 'auto', budget: { maxUsd: 3, maxWallClockMs: 100 } }))
      .toThrow(/repository sampling/);
  });

  it.each(['missing-pilot', 'missing-confirmation', 'foreign-task', 'blank-repository', 'unknown-unit'])
    ('refuses repository sampling defect %s', defect => {
      const protocol = currentProtocolFixture(); const sampling = protocol.sampling!;
      if (defect === 'missing-pilot') delete sampling.taskRepositories.t1;
      if (defect === 'missing-confirmation') delete sampling.taskRepositories['withheld-1'];
      if (defect === 'foreign-task') sampling.taskRepositories.foreign = 'repo';
      if (defect === 'blank-repository') sampling.taskRepositories.t1 = '';
      if (defect === 'unknown-unit') (sampling as { unit: string }).unit = 'seed';
      expect(currentBenchmarkProtocolSchema.safeParse(protocol).success).toBe(false);
    });
});

describe('canonicalJson', () => {
  it('is key-order independent', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it('sorts nested object keys but preserves array order', () => {
    expect(canonicalJson({ z: { y: 1, x: 2 }, a: [3, 1, 2] })).toBe('{"a":[3,1,2],"z":{"x":2,"y":1}}');
  });

  it('drops undefined members', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });
});

describe('computePreregHash', () => {
  it('is stable across key order (content-addressed)', () => {
    const a = computePreregHash({ arms: ['papercusp'], seeds: 3, suite: 'swe-bench-pro' });
    const b = computePreregHash({ suite: 'swe-bench-pro', seeds: 3, arms: ['papercusp'] });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes when the config changes (tune-to-test tamper-evidence)', () => {
    const a = computePreregHash({ seeds: 3 });
    const b = computePreregHash({ seeds: 5 });
    expect(a).not.toBe(b);
  });
});

describe('rolloutIdFor', () => {
  it('is deterministic for the same attempt key', () => {
    expect(rolloutIdFor('run1', 'swe-bench-pro', 'task-1', 'papercusp', 0)).toBe(
      rolloutIdFor('run1', 'swe-bench-pro', 'task-1', 'papercusp', 0),
    );
  });

  it('differs per seed, per arm, and per task (no collisions across the natural key)', () => {
    const base = rolloutIdFor('run1', 'swe-bench-pro', 'task-1', 'papercusp', 0);
    expect(base).not.toBe(rolloutIdFor('run1', 'swe-bench-pro', 'task-1', 'papercusp', 1));
    expect(base).not.toBe(rolloutIdFor('run1', 'swe-bench-pro', 'task-1', 'baseline-a-ablation', 0));
    expect(base).not.toBe(rolloutIdFor('run1', 'swe-bench-pro', 'task-2', 'papercusp', 0));
    expect(base).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('fleetRunIdFor', () => {
  it('is deterministic and differs per fleet arm, backlog, and seed', () => {
    const base = fleetRunIdFor('run1', 'swe-bench-pro', 'backlog-A', 'hive', 0);
    expect(base).toBe(fleetRunIdFor('run1', 'swe-bench-pro', 'backlog-A', 'hive', 0));
    expect(base).not.toBe(fleetRunIdFor('run1', 'swe-bench-pro', 'backlog-A', 'queen-ablated', 0));
    expect(base).not.toBe(fleetRunIdFor('run1', 'swe-bench-pro', 'backlog-B', 'hive', 0));
    expect(base).not.toBe(fleetRunIdFor('run1', 'swe-bench-pro', 'backlog-A', 'hive', 1));
    expect(base).toMatch(/^[0-9a-f]{64}$/);
  });
});
