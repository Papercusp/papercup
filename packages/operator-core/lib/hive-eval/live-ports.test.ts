/**
 * Pure-core tests for the LIVE HiveRunPorts (P-063 / D-011): the seed-app→pinned-SHA
 * materialization plan, the scenario→seed-DAG plan, and the drained predicate. No git/PG/LLM —
 * the IO assembly (makeLiveHivePorts) + the real whole-Hive run are owner-gated (P-051), exercised
 * only by an owner-armed run, not CI.
 */
import { describe, it, expect } from 'vitest';
import {
  seedRepoMaterializeCommands,
  seedRepoCloneCommands,
  scenarioSeedPlan,
  isHiveDrained,
} from './live-ports';
import { getScenario } from './scenarios';

describe('seed-app → a pinned-SHA git repo (pure)', () => {
  it('materializes a one-commit base repo with a fixed identity (commit never fails on missing config)', () => {
    const cmds = seedRepoMaterializeCommands('/scratch/base').map((c) => c.argv.join(' '));
    expect(cmds[0]).toBe('git init --quiet /scratch/base');
    expect(cmds[1]).toBe('git -C /scratch/base add -A');
    expect(cmds[2]).toContain('git -C /scratch/base');
    expect(cmds[2]).toContain('user.name=hive-eval'); // identity so commit doesn't fail
    expect(cmds[2]).toContain('commit --quiet -m hive-eval seed-app base');
  });

  it('hermetic-clones the materialized base @ the pinned SHA (local --local + detached checkout)', () => {
    const sha = 'a'.repeat(40);
    const cmds = seedRepoCloneCommands({ baseDir: '/scratch/base', commit: sha, destDir: '/scratch/run' }).map((c) =>
      c.argv.join(' '),
    );
    expect(cmds[0]).toBe(`git clone --quiet --local /scratch/base /scratch/run`); // local source ⇒ --local
    expect(cmds[1]).toBe(`git -C /scratch/run checkout --detach ${sha}`); // pinned, never a ref
  });

  it('rejects a non-SHA commit (the gym clone pin guard) — guards against cloning a ref', () => {
    expect(() => seedRepoCloneCommands({ baseDir: '/b', commit: 'seed', destDir: '/d' })).toThrow(/pinned hex SHA/);
  });
});

describe('scenario → seed-DAG plan (pure)', () => {
  it('maps the work-item DAG to member-harness features + block edges (wide-fanout)', () => {
    const scenario = getScenario('wide-fanout')!; // w0 → {w1..w4} → w5
    const plan = scenarioSeedPlan(scenario);

    expect(plan.features.map((f) => f.featureId)).toEqual(['w0', 'w1', 'w2', 'w3', 'w4', 'w5']);
    expect(plan.features[0]).toMatchObject({ featureId: 'w0', title: scenario.workItems[0].title, spec: scenario.workItems[0].spec });

    // Each dependsOn → a (feature blockedBy prerequisite) edge: w1..w4 ← w0; w5 ← w1..w4.
    const edgeKeys = plan.edges.map((e) => `${e.feature}<-${e.blockedBy}`).sort();
    expect(edgeKeys).toEqual(
      ['w1<-w0', 'w2<-w0', 'w3<-w0', 'w4<-w0', 'w5<-w1', 'w5<-w2', 'w5<-w3', 'w5<-w4'].sort(),
    );
  });

  it('a serial chain yields one edge per stage; a base node has none', () => {
    const plan = scenarioSeedPlan(getScenario('serial-pipeline')!); // w1→w2→w3→w4
    expect(plan.edges.map((e) => `${e.feature}<-${e.blockedBy}`)).toEqual(['w2<-w1', 'w3<-w2', 'w4<-w3']);
    expect(plan.edges.some((e) => e.feature === 'w1')).toBe(false); // the source node blocks on nothing
  });
});

describe('drained predicate (pure)', () => {
  const drained = { plans: [], frontier: [] } as Parameters<typeof isHiveDrained>[0];
  it('DRAINED only when nothing ready, nothing started, and nothing in flight', () => {
    expect(isHiveDrained(drained, 0)).toBe(true);
  });
  it('NOT drained while a placement is in flight (a bee is still working)', () => {
    expect(isHiveDrained(drained, 1)).toBe(false);
  });
  it('NOT drained while the frontier has a ready item', () => {
    expect(isHiveDrained({ plans: [], frontier: [{} as never] }, 0)).toBe(false);
  });
  it('NOT drained while a plan is still started', () => {
    expect(isHiveDrained({ plans: [{} as never], frontier: [] }, 0)).toBe(false);
  });
});
