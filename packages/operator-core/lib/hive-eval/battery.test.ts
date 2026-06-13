import { describe, it, expect } from 'vitest';
import { runHiveScenarioBattery, type HiveScenarioBatteryConfig } from './battery';
import { createInMemoryHiveEvalStore, type InstanceManifest } from './store';
import { makeFakeHivePorts, type FakeHiveBehavior, type HiveScenarioCell } from './run-harness';
import type { HiveScenario } from './scenario';

const instance: InstanceManifest = {
  instanceId: 'gen0-abc123-ws',
  workspaceId: 'ws',
  codeSha: 'abc123',
  createdAt: new Date('2026-06-13T00:00:00Z'),
};

const serial: HiveScenario = {
  id: 'serial',
  title: 'Serial',
  shape: 'serial',
  sandbox: { source: '/s', commit: 'seed' },
  workItems: [
    { id: 'a', title: 'a', spec: 'a', dependsOn: [] },
    { id: 'b', title: 'b', spec: 'b', dependsOn: ['a'] },
  ],
  plantedBug: { location: 'src/x.js', defect: 'd', detectionSignature: 'sig', inWorkItem: 'b' },
  acceptance: { kind: 'command', description: 'done', command: 'node acceptance.mjs' },
  rationale: 'r',
};

const wide: HiveScenario = {
  ...serial,
  id: 'wide',
  title: 'Wide',
  shape: 'wide-parallel',
  workItems: [
    { id: 'base', title: 'base', spec: 'base', dependsOn: [] },
    { id: 'f1', title: 'f1', spec: 'f1', dependsOn: ['base'] },
    { id: 'f2', title: 'f2', spec: 'f2', dependsOn: ['base'] },
  ],
  plantedBug: { location: 'src/y.js', defect: 'd', detectionSignature: 'sig', inWorkItem: 'f1' },
};

const baseConfig: HiveScenarioBatteryConfig = {
  instance,
  scenarios: [serial, wide],
  repeats: 3,
  seed: 100,
  budgetUsdCap: 10,
  beeCap: 4,
  timeoutMs: 60_000,
};

describe('runHiveScenarioBattery', () => {
  it('runs every scenario × repeat and records instance + scenarios + runs', async () => {
    const store = createInMemoryHiveEvalStore();
    const fake = makeFakeHivePorts(() => ({ advanceMs: 1000, costUsd: 0.25 }));

    const result = await runHiveScenarioBattery(baseConfig, { store, ports: fake.ports });

    expect(result.totalRuns).toBe(6); // 2 scenarios × 3 repeats
    expect(result.completedRuns).toBe(6);
    expect(store.instances.get('gen0-abc123-ws')).toBeDefined();
    expect(store.scenarios.size).toBe(2);
    expect(store.runs.size).toBe(6);
    // every run row was finished with observations
    for (const run of store.runs.values()) {
      expect(run.finishedAt).toBeDefined();
      expect(run.observations?.terminalState).toBe('drained');
    }
    // the throwaway hives were all torn down (no leak)
    expect(fake.tornDown).toHaveLength(6);
  });

  it('records the scenario ideal computed from the DAG (D-004)', async () => {
    const store = createInMemoryHiveEvalStore();
    const fake = makeFakeHivePorts();
    await runHiveScenarioBattery(baseConfig, { store, ports: fake.ports });

    expect(store.scenarios.get('serial')).toMatchObject({ idealWallClockUnits: 2, idealBeeCount: 1 });
    expect(store.scenarios.get('wide')).toMatchObject({ idealWallClockUnits: 2, idealBeeCount: 2 });
  });

  it('aggregates each scenario into a DISTRIBUTION over repeats (P-022)', async () => {
    const store = createInMemoryHiveEvalStore();
    // vary wall-clock across repeats so the distribution has real spread.
    const fake = makeFakeHivePorts((c: HiveScenarioCell): FakeHiveBehavior => ({ advanceMs: 1000 + c.repeat * 1000, costUsd: 1 }));
    const result = await runHiveScenarioBattery(baseConfig, { store, ports: fake.ports });

    const serialDist = result.distributions.find((d) => d.scenarioId === 'serial')!;
    expect(serialDist.runs).toBe(3);
    expect(serialDist.completedRuns).toBe(3);
    expect(serialDist.frontierDrainedRate).toBe(1);
    expect(serialDist.completionRate.mean).toBe(1);
    expect(serialDist.wallClockMs.mean).toBe(2000); // (1000+2000+3000)/3
    expect(serialDist.wallClockMs.sd).toBeGreaterThan(0); // a distribution, not a point
    expect(serialDist.wallClockMs.n).toBe(3);
    expect(serialDist.idealWallClockUnits).toBe(2);
  });

  it('is deterministic: per-repeat seed = seed + repeat, stable runIds', async () => {
    const store1 = createInMemoryHiveEvalStore();
    const store2 = createInMemoryHiveEvalStore();
    await runHiveScenarioBattery(baseConfig, { store: store1, ports: makeFakeHivePorts().ports });
    await runHiveScenarioBattery(baseConfig, { store: store2, ports: makeFakeHivePorts().ports });
    expect([...store1.runs.keys()].sort()).toEqual([...store2.runs.keys()].sort());
    // distinct repeats are distinct rows (the distribution is kept, unlike beekeeper's unique-per-case)
    expect(store1.runs.has('gen0-abc123-ws::serial::r0')).toBe(true);
    expect(store1.runs.has('gen0-abc123-ws::serial::r1')).toBe(true);
    expect(store1.runs.has('gen0-abc123-ws::serial::r2')).toBe(true);
  });

  it('records an errored run and continues the battery (never aborts)', async () => {
    const store = createInMemoryHiveEvalStore();
    // the first wide repeat fails at drive; everything else drains.
    const fake = makeFakeHivePorts((c: HiveScenarioCell): FakeHiveBehavior =>
      c.scenario.id === 'wide' && c.repeat === 0 ? { throwAt: 'drive' } : { advanceMs: 1000 },
    );
    const result = await runHiveScenarioBattery(baseConfig, { store, ports: fake.ports });

    expect(result.totalRuns).toBe(6);
    expect(result.completedRuns).toBe(5);
    const errored = result.outcomes.find((o) => o.status === 'errored')!;
    expect(errored.scenarioId).toBe('wide');
    expect(errored.repeat).toBe(0);
    // the errored run row is finished as 'failed' (no dangling row)
    expect(store.runs.get('gen0-abc123-ws::wide::r0')?.observations?.terminalState).toBe('failed');
    // the distribution for wide aggregates only the 2 completed repeats
    const wideDist = result.distributions.find((d) => d.scenarioId === 'wide')!;
    expect(wideDist.completedRuns).toBe(2);
    expect(wideDist.runs).toBe(3);
  });
});
