import { describe, it, expect } from 'vitest';
import {
  runHiveScenarioOnce,
  hiveScenarioSubject,
  makeFakeHivePorts,
  type HiveScenarioCell,
  type FakeHiveBehavior,
} from './run-harness';
import { hiveEvalRunIdentity } from './run-identity';
import type { HiveScenario } from './scenario';

const scenario: HiveScenario = {
  id: 'demo',
  title: 'Demo',
  shape: 'serial',
  sandbox: { source: '/seed', commit: 'seed' },
  workItems: [
    { id: 'a', title: 'a', spec: 'a', dependsOn: [] },
    { id: 'b', title: 'b', spec: 'b', dependsOn: ['a'] },
    { id: 'c', title: 'c', spec: 'c', dependsOn: ['b'] },
  ],
  plantedBug: { location: 'src/x.js', defect: 'd', detectionSignature: 'sig', inWorkItem: 'b' },
  acceptance: { kind: 'command', description: 'done', command: 'node acceptance.mjs' },
  rationale: 'r',
};

const cell = (over: Partial<HiveScenarioCell> = {}): HiveScenarioCell => ({
  instanceId: 'inst-1',
  scenario,
  repeat: 0,
  seed: 7,
  budgetUsdCap: 5,
  beeCap: 4,
  ...over,
});

const opts = { defaultTimeoutMs: 60_000, maxDistillChars: 4000 };

describe('runHiveScenarioOnce', () => {
  it('captures a clean drain and tears the hive down', async () => {
    const fake = makeFakeHivePorts(() => ({ advanceMs: 1234, costUsd: 0.5 }));
    const rec = await runHiveScenarioOnce(cell(), fake.ports, opts);

    expect(rec.runId).toBe('inst-1::demo::r0');
    expect(rec.observations.terminalState).toBe('drained');
    expect(rec.observations.frontierDrained).toBe(true);
    expect(rec.observations.workItemsCompleted).toBe(3);
    expect(rec.observations.workItemsTotal).toBe(3);
    expect(rec.observations.wallClockMs).toBe(1234); // deterministic fake clock
    expect(rec.observations.costUsd).toBe(0.5);
    expect(rec.parallelism.idealWallClockUnits).toBe(3);
    expect(rec.distilledTrace).toContain('demo');
    const expectedSlug = hiveEvalRunIdentity({ instanceId: 'inst-1', scenarioId: 'demo', repeat: 0, seed: 7 }).hiveSlug;
    expect(fake.booted).toEqual([expectedSlug]);
    expect(fake.tornDown).toEqual([expectedSlug]); // always torn down on success
  });

  it('records a bounded timeout as a (non-thrown) result', async () => {
    const fake = makeFakeHivePorts((): FakeHiveBehavior => ({ terminalState: 'timeout', frontierDrained: false, workItemsCompleted: 1 }));
    const rec = await runHiveScenarioOnce(cell(), fake.ports, opts);
    expect(rec.observations.terminalState).toBe('timeout');
    expect(rec.observations.frontierDrained).toBe(false);
    expect(rec.observations.workItemsCompleted).toBe(1);
    expect(fake.tornDown).toHaveLength(1);
  });

  it('an infra failure at boot throws and leaves no hive to tear down', async () => {
    const fake = makeFakeHivePorts(() => ({ throwAt: 'boot' }));
    await expect(runHiveScenarioOnce(cell(), fake.ports, opts)).rejects.toThrow(/boot failure/);
    expect(fake.booted).toEqual([]);
    expect(fake.tornDown).toEqual([]);
  });

  it('an infra failure after boot still tears the hive down (no leak)', async () => {
    for (const phase of ['seed', 'drive', 'collect'] as const) {
      const fake = makeFakeHivePorts(() => ({ throwAt: phase }));
      await expect(runHiveScenarioOnce(cell(), fake.ports, opts)).rejects.toThrow();
      expect(fake.tornDown).toHaveLength(1); // teardown ran despite the failure
    }
  });

  it('is deterministic: same key → same runId + hive slug', async () => {
    const fakeA = makeFakeHivePorts();
    const fakeB = makeFakeHivePorts();
    const a = await runHiveScenarioOnce(cell({ repeat: 2, seed: 9 }), fakeA.ports, opts);
    const b = await runHiveScenarioOnce(cell({ repeat: 2, seed: 9 }), fakeB.ports, opts);
    expect(a.runId).toBe(b.runId);
    expect(fakeA.booted).toEqual(fakeB.booted);
  });
});

describe('hiveScenarioSubject (the eval-battery Subject adapter for HE-06)', () => {
  it('runs + distills + tears down through the same ports', async () => {
    const fake = makeFakeHivePorts(() => ({ advanceMs: 500 }));
    const subject = hiveScenarioSubject(fake.ports, opts);
    const handle = await subject.run(cell());
    expect(handle.terminalState).toBe('drained');
    expect(handle.wallClockMs).toBe(500);
    expect(fake.tornDown).toEqual([]); // run() does not tear down — collectAndDistill does

    const distilled = await subject.collectAndDistill({ handle, cell: cell(), maxChars: 4000 });
    expect(distilled.distilledTrace).toContain('demo');
    expect(distilled.signals?.parallelism.idealWallClockUnits).toBe(3);
    expect(distilled.signals?.observations.frontierDrained).toBe(true);
    expect(fake.tornDown).toHaveLength(1);
  });

  it('judgeInput carries the scenario intent', () => {
    const subject = hiveScenarioSubject(makeFakeHivePorts().ports, opts);
    const ji = subject.judgeInput(cell());
    expect(ji.intent).toContain('Demo');
    expect(ji.intent).toContain('Known-good end state');
  });
});
