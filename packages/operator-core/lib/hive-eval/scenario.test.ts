import { describe, it, expect } from 'vitest';
import { computeParallelismStructure, validateScenario, type HiveScenario, type ScenarioWorkItem } from './scenario';
import { HIVE_EVAL_SCENARIOS, getScenario } from './scenarios';

const wi = (id: string, dependsOn: string[] = [], unitCost?: number): ScenarioWorkItem => ({
  id,
  title: id,
  spec: id,
  dependsOn,
  ...(unitCost == null ? {} : { unitCost }),
});

describe('computeParallelismStructure', () => {
  it('a serial chain has critical path = length and ideal bees = 1', () => {
    const p = computeParallelismStructure([wi('a'), wi('b', ['a']), wi('c', ['b']), wi('d', ['c'])]);
    expect(p.idealWallClockUnits).toBe(4);
    expect(p.totalUnits).toBe(4);
    expect(p.idealBeeCount).toBe(1);
    expect(p.criticalPath).toEqual(['a', 'b', 'c', 'd']);
    expect(p.maxSpeedup).toBe(1);
  });

  it('a wide fan-out has critical path 3 and ideal bees = the fan width', () => {
    const p = computeParallelismStructure([
      wi('base'),
      wi('f1', ['base']),
      wi('f2', ['base']),
      wi('f3', ['base']),
      wi('f4', ['base']),
      wi('agg', ['f1', 'f2', 'f3', 'f4']),
    ]);
    expect(p.idealWallClockUnits).toBe(3); // base → f* → agg
    expect(p.idealBeeCount).toBe(4); // f1..f4 run concurrently
    expect(p.totalUnits).toBe(6);
    expect(p.maxSpeedup).toBe(2);
  });

  it('a diamond has critical path 3 and ideal bees = 3 branches', () => {
    const p = computeParallelismStructure([
      wi('a'),
      wi('b', ['a']),
      wi('c', ['a']),
      wi('d', ['a']),
      wi('e', ['b', 'c', 'd']),
    ]);
    expect(p.idealWallClockUnits).toBe(3);
    expect(p.idealBeeCount).toBe(3);
  });

  it('a deep chain with one branch has the long critical path and ideal bees = 2', () => {
    const p = computeParallelismStructure([
      wi('s1'),
      wi('s2', ['s1']),
      wi('s3', ['s2']),
      wi('s4', ['s3']),
      wi('s5', ['s4']),
      wi('branch', ['s2']),
    ]);
    expect(p.idealWallClockUnits).toBe(5); // s1..s5
    expect(p.idealBeeCount).toBe(2); // s3 overlaps branch
    expect(p.criticalPath).toEqual(['s1', 's2', 's3', 's4', 's5']);
  });

  it('honors a cost accessor (measured durations — the HE-05 critical-path-ratio path)', () => {
    const items = [wi('a'), wi('b', ['a']), wi('c', ['a'])];
    // a:10, b:5, c:1 → critical path a→b = 15, peak concurrency 2 (b,c overlap after a).
    const cost = (w: ScenarioWorkItem) => ({ a: 10, b: 5, c: 1 })[w.id as 'a' | 'b' | 'c'];
    const p = computeParallelismStructure(items, cost);
    expect(p.idealWallClockUnits).toBe(15);
    expect(p.totalUnits).toBe(16);
    expect(p.idealBeeCount).toBe(2);
    expect(p.criticalPath).toEqual(['a', 'b']);
  });

  it('throws on a dependency cycle', () => {
    expect(() => computeParallelismStructure([wi('a', ['b']), wi('b', ['a'])])).toThrow(/cycle/);
  });

  it('throws on an unknown dependency', () => {
    expect(() => computeParallelismStructure([wi('a', ['ghost'])])).toThrow(/unknown id/);
  });

  it('returns zeros for an empty DAG', () => {
    expect(computeParallelismStructure([])).toEqual({
      totalUnits: 0,
      idealWallClockUnits: 0,
      idealBeeCount: 0,
      criticalPath: [],
      maxSpeedup: 0,
    });
  });
});

describe('validateScenario', () => {
  const base: HiveScenario = {
    id: 's',
    title: 's',
    shape: 'serial',
    sandbox: { source: '/x', commit: 'seed' },
    workItems: [wi('a'), wi('b', ['a'])],
    plantedBug: { location: 'src/x.js', defect: 'd', detectionSignature: 'sig', inWorkItem: 'b' },
    acceptance: { kind: 'command', description: 'd', command: 'node acceptance.mjs' },
    rationale: 'r',
  };

  it('accepts a well-formed scenario', () => {
    expect(validateScenario(base)).toEqual([]);
  });

  it('flags a dangling dependency', () => {
    const bad = { ...base, workItems: [wi('a', ['ghost'])] };
    expect(validateScenario(bad).some((p) => /unknown id/.test(p.message))).toBe(true);
  });

  it('flags a cycle', () => {
    const bad = { ...base, workItems: [wi('a', ['b']), wi('b', ['a'])] };
    expect(validateScenario(bad).some((p) => /not a DAG/.test(p.message))).toBe(true);
  });

  it('flags a planted bug attached to a missing work-item', () => {
    const bad = { ...base, plantedBug: { ...base.plantedBug, inWorkItem: 'ghost' } };
    expect(validateScenario(bad).some((p) => p.field === 'plantedBug')).toBe(true);
  });

  it('flags a command acceptance test with no command', () => {
    const bad = { ...base, acceptance: { kind: 'command' as const, description: 'd' } };
    expect(validateScenario(bad).some((p) => p.field === 'acceptance')).toBe(true);
  });
});

describe('the seeded corpus (P-020)', () => {
  it('has 4 scenarios spanning serial / wide-parallel / deep-dependency / diamond', () => {
    const shapes = HIVE_EVAL_SCENARIOS.map((s) => s.shape).sort();
    expect(shapes).toEqual(['deep-dependency', 'diamond', 'serial', 'wide-parallel']);
  });

  it('every scenario is internally valid', () => {
    for (const s of HIVE_EVAL_SCENARIOS) {
      expect({ id: s.id, problems: validateScenario(s) }).toEqual({ id: s.id, problems: [] });
    }
  });

  it('every scenario has a unique id and a planted bug attached to a real item', () => {
    const ids = new Set(HIVE_EVAL_SCENARIOS.map((s) => s.id));
    expect(ids.size).toBe(HIVE_EVAL_SCENARIOS.length);
    for (const s of HIVE_EVAL_SCENARIOS) {
      expect(s.workItems.some((w) => w.id === s.plantedBug.inWorkItem)).toBe(true);
    }
  });

  it('computes the documented objective optima per scenario (D-004)', () => {
    const ideal = (id: string) => computeParallelismStructure(getScenario(id)!.workItems);
    expect(ideal('serial-pipeline')).toMatchObject({ idealWallClockUnits: 4, idealBeeCount: 1 });
    expect(ideal('wide-fanout')).toMatchObject({ idealWallClockUnits: 3, idealBeeCount: 4 });
    expect(ideal('deep-chain')).toMatchObject({ idealWallClockUnits: 5, idealBeeCount: 2 });
    expect(ideal('diamond')).toMatchObject({ idealWallClockUnits: 3, idealBeeCount: 3 });
  });
});
