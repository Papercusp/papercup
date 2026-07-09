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
  makeLiveHivePorts,
  type LiveHiveOps,
  type LiveRunStats,
} from './live-ports';
import { getScenario } from './scenarios';
import { hiveEvalRunIdentity } from './run-identity';
import type { HiveScenarioCell } from './run-harness';

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

// ── makeLiveHivePorts orchestration (over fake ops — no git/PG/LLM) ──
//
// A fake ops with a virtual clock: `sleep` advances it, and the Hive "drains" once the clock
// reaches `drainAtMs` (so the poll loop drains on the 2nd tick by default). Records every call so
// the boot→seed→drive→collect→teardown ordering + the drained loop are assertable.
function fakeOps(opts: { drainAtMs?: number; stats?: LiveRunStats } = {}) {
  const drainAtMs = opts.drainAtMs ?? 10_000;
  let clock = 0;
  const calls = {
    exec: [] as string[], created: [] as string[], registered: [] as string[], seeded: [] as string[],
    edges: [] as string[], started: 0, paused: 0, surveys: 0, dropped: [] as string[], dissolved: [] as string[], rm: [] as string[],
  };
  const ops: LiveHiveOps = {
    scratchRoot: (slug) => `/scratch/${slug}`,
    copyDir: async () => {},
    exec: async (cmd, args) => {
      calls.exec.push([cmd, ...args].join(' '));
      return { stdout: args.includes('rev-parse') ? 'a'.repeat(40) : '' };
    },
    rm: async (p) => { calls.rm.push(p); },
    createHive: async ({ slug }) => { calls.created.push(slug); },
    registerMember: async ({ member, hiveHome }) => { calls.registered.push(`${member}@${hiveHome}`); },
    seedFeature: async ({ featureId }) => { calls.seeded.push(featureId); },
    syncBlockEdges: async ({ featureId, blockedBy }) => { calls.edges.push(`${featureId}<-${[...blockedBy].join(',')}`); },
    startHive: async () => { calls.started++; },
    pauseHive: async () => { calls.paused++; },
    survey: async () => {
      calls.surveys++;
      return clock >= drainAtMs ? { plans: [], frontier: [] } : { plans: [], frontier: [{} as never] };
    },
    countInFlightPlacements: async () => (clock >= drainAtMs ? 0 : 1),
    readRunStats: async () => opts.stats ?? { costUsd: 1.25, workItemsTotal: 6, workItemsCompleted: 6 },
    readRunTrace: async () => ({ distilledTrace: 'trace', traceRef: 'ref://x' }),
    dropMember: async ({ member }) => { calls.dropped.push(member); },
    dissolveHive: async ({ hiveHome }) => { calls.dissolved.push(hiveHome); },
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
  };
  return { ops, calls };
}

describe('makeLiveHivePorts orchestration (P-063, fake ops)', () => {
  const scenario = getScenario('wide-fanout')!;
  const cell: HiveScenarioCell = { instanceId: 'inst', scenario, repeat: 0, seed: 1, budgetUsdCap: 5, beeCap: 4 };
  const identity = hiveEvalRunIdentity({ instanceId: 'inst', scenarioId: scenario.id, repeat: 0, seed: 1 });

  it('bootHive materializes + hermetic-clones the seed-app and mints the Queen seat + member', async () => {
    const { ops, calls } = fakeOps();
    const ports = makeLiveHivePorts(ops, { workspaceId: 'ws' });
    const boot = await ports.bootHive({ scenario, cell, identity });

    expect(boot.potSlug).toBe(identity.potSlug);
    expect(boot.repoPath).toContain('/clone');
    expect(calls.exec.some((c) => c.includes('git init'))).toBe(true);
    expect(calls.exec.some((c) => c.includes('rev-parse'))).toBe(true);
    expect(calls.exec.some((c) => c.includes('git clone'))).toBe(true);
    expect(calls.created).toEqual([identity.potSlug]); // the Queen seat
    expect(calls.registered).toEqual([`${identity.potSlug}m@${identity.potSlug}`]); // substrate as member
  });

  it('seedScenario seeds every work-item + its block edges into the member harness', async () => {
    const { ops, calls } = fakeOps();
    const ports = makeLiveHivePorts(ops, { workspaceId: 'ws' });
    const boot = await ports.bootHive({ scenario, cell, identity });
    await ports.seedScenario({ scenario, boot });

    expect(calls.seeded).toEqual(['w0', 'w1', 'w2', 'w3', 'w4', 'w5']);
    // edges only for items with deps (w0, the source, has none).
    expect(calls.edges).toEqual(['w1<-w0', 'w2<-w0', 'w3<-w0', 'w4<-w0', 'w5<-w1,w2,w3,w4']);
  });

  it('driveToCompletion starts the Hive, polls until drained, always pauses, returns stats', async () => {
    const { ops, calls } = fakeOps({ drainAtMs: 10_000 });
    const ports = makeLiveHivePorts(ops, { workspaceId: 'ws', pollIntervalMs: 10_000 });
    const boot = await ports.bootHive({ scenario, cell, identity });
    const drive = await ports.driveToCompletion({ scenario, boot, cell, timeoutMs: 60_000 });

    expect(calls.started).toBe(1);
    expect(calls.paused).toBe(1); // bounds spend
    expect(drive.terminalState).toBe('drained');
    expect(drive.frontierDrained).toBe(true);
    expect(drive.workItemsCompleted).toBe(6);
    expect(drive.costUsd).toBe(1.25);
    expect(calls.surveys).toBeGreaterThanOrEqual(2);
  });

  it('driveToCompletion returns timeout (and STILL pauses) when the Hive never drains', async () => {
    const { ops, calls } = fakeOps({ drainAtMs: Infinity });
    const ports = makeLiveHivePorts(ops, { workspaceId: 'ws', pollIntervalMs: 10_000 });
    const boot = await ports.bootHive({ scenario, cell, identity });
    const drive = await ports.driveToCompletion({ scenario, boot, cell, timeoutMs: 30_000 });

    expect(drive.terminalState).toBe('timeout');
    expect(drive.frontierDrained).toBe(false);
    expect(calls.paused).toBe(1); // a timed-out run must not keep spending
  });

  it('collectRunData reads the trace; teardown drops the member + dissolves the hive + removes both clones', async () => {
    const { ops, calls } = fakeOps();
    const ports = makeLiveHivePorts(ops, { workspaceId: 'ws' });
    const boot = await ports.bootHive({ scenario, cell, identity });

    const collected = await ports.collectRunData({ scenario, boot, drive: {} as never, cell, maxChars: 8000 });
    expect(collected.traceRef).toBe('ref://x');

    await ports.teardown({ boot });
    expect(calls.dropped).toEqual([`${identity.potSlug}m`]);
    expect(calls.dissolved).toEqual([identity.potSlug]);
    expect(calls.rm).toHaveLength(2); // base + clone
  });
});
