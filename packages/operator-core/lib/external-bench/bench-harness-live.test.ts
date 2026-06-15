/**
 * Pure-orchestration tests for the LIVE bench-harness driver (BRIEF 2 / P-019, su-1226c): the
 * create→feed→drive→cost→teardown ordering, the disposition→stopReason mapping, the iso-budget /
 * escalate / timeout dispositions, and the NEVER-throws-on-failure contract `instantiateBenchHarness`
 * relies on. All over a FAKE {@link BenchHarnessOps} — NO real harness, NO git/PG/LLM, NO spend (the
 * live ops + the real run are owner-gated, exercised only by the pilot trigger, not CI). Mirrors the
 * `hive-eval/live-ports.test.ts` fake-ops discipline.
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  liveBenchHarnessDriver,
  bindLiveBenchHarness,
  stopReasonForDisposition,
  type BenchHarnessOps,
  type BenchHarnessHandle,
  type BenchRunCost,
  type DriveDisposition,
  type DriveResult,
} from './bench-harness-live';
import {
  instantiateBenchHarness,
  setBenchHarnessDriver,
  type BenchHarnessRunRequest,
} from './run-loop';
import type { BenchTask, GenerationBudget, TaskCheckout } from './types';

afterEach(() => setBenchHarnessDriver(null));

// ── fixtures ─────────────────────────────────────────────────────────────────
const TASK: BenchTask = {
  benchmark: 'swe-bench-pro',
  instanceId: 'instance_astropy__astropy-12345',
  problemStatement: 'Fix the units regression in astropy.units.',
  repo: 'astropy/astropy',
  baseCommit: 'abc123',
  graderMeta: { dockerhub_tag: 'astropy-12345' },
};
const BUDGET: GenerationBudget = { maxTokens: 1_000_000, maxUsd: 25 };

function fakeCheckout(over: Partial<TaskCheckout> = {}): TaskCheckout {
  return {
    dir: '/scratch/astropy-12345',
    repo: 'astropy/astropy',
    baseCommit: 'abc123',
    cleanup: async () => {},
    ...over,
  };
}

function req(over: Partial<BenchHarnessRunRequest> = {}): BenchHarnessRunRequest {
  return { blueprintId: 'external-bench', task: TASK, checkout: fakeCheckout(), budget: BUDGET, ...over };
}

/**
 * A fake {@link BenchHarnessOps} with a virtual clock (`now` advances on `sleep`/drive) that records
 * every call so the create→feed→drive→cost→teardown ORDERING is assertable. Configurable: the drive
 * disposition, the cost the run summed, whether a method throws, and a clock advance per drive.
 */
function fakeOps(
  cfg: {
    drive?: DriveResult;
    cost?: BenchRunCost;
    throwOn?: 'createHarness' | 'addFeature' | 'driveToDone' | 'collectCost' | 'teardown';
    driveTakesMs?: number;
  } = {},
) {
  let clock = 0;
  const order: string[] = [];
  const calls = {
    created: [] as string[],
    fed: [] as string[],
    drove: [] as string[],
    costed: [] as string[],
    torn: [] as string[],
  };
  const maybeThrow = (m: NonNullable<typeof cfg.throwOn>) => {
    if (cfg.throwOn === m) throw new Error(`fake ${m} blew up`);
  };
  const ops: BenchHarnessOps = {
    now: () => clock,
    async createHarness({ blueprintId, checkout }) {
      order.push('create');
      maybeThrow('createHarness');
      const handle: BenchHarnessHandle = { slug: 'xbench-fake', featureId: 'F-XB', worktreePath: checkout.dir };
      calls.created.push(`${handle.slug}:${blueprintId}@${checkout.dir}`);
      return handle;
    },
    async addFeature({ handle, task }) {
      order.push('feed');
      maybeThrow('addFeature');
      calls.fed.push(`${handle.featureId}:${task.instanceId}`);
    },
    async driveToDone({ handle }) {
      order.push('drive');
      maybeThrow('driveToDone');
      clock += cfg.driveTakesMs ?? 240_000;
      calls.drove.push(handle.slug);
      return cfg.drive ?? { disposition: 'done' };
    },
    async collectCost({ handle }) {
      order.push('cost');
      maybeThrow('collectCost');
      calls.costed.push(handle.slug);
      return cfg.cost ?? { tokensIn: 120_000, tokensOut: 30_000, costUsd: 4.2, turns: 18 };
    },
    async teardown({ handle }) {
      order.push('teardown');
      maybeThrow('teardown');
      calls.torn.push(handle.slug);
    },
  };
  return { ops, calls, order };
}

const OPTS = { workspaceId: 'ws' };

// ── the happy path: create → feed → drive → cost → teardown ──────────────────
describe('liveBenchHarnessDriver — orchestration over fake ops', () => {
  it('runs create→feed→drive→cost→teardown IN ORDER and returns the summed telemetry on DONE', async () => {
    const { ops, calls, order } = fakeOps();
    const driver = liveBenchHarnessDriver(ops, OPTS);

    const run = await driver.spinRunAndCost(req());

    expect(order).toEqual(['create', 'feed', 'drive', 'cost', 'teardown']);
    expect(calls.created).toEqual(['xbench-fake:external-bench@/scratch/astropy-12345']);
    expect(calls.fed).toEqual(['F-XB:instance_astropy__astropy-12345']);
    expect(calls.drove).toEqual(['xbench-fake']);
    expect(calls.costed).toEqual(['xbench-fake']);
    expect(calls.torn).toEqual(['xbench-fake']);

    expect(run.worktreePath).toBe('/scratch/astropy-12345');
    expect(run.telemetry.stopReason).toBe('done');
    expect(run.telemetry.tokensIn).toBe(120_000);
    expect(run.telemetry.tokensOut).toBe(30_000);
    expect(run.telemetry.costUsd).toBe(4.2);
    expect(run.telemetry.turns).toBe(18);
    expect(run.telemetry.wallClockMs).toBe(240_000); // the virtual clock advanced during drive
    expect(run.telemetry.trajectoryRef).toBe('xbench://xbench-fake');
    expect(run.telemetry.generationError).toBeUndefined();
  });

  it('the SAME driver spins the ablation arm — only the blueprintId differs (causal isolation)', async () => {
    const { ops, calls } = fakeOps();
    const driver = liveBenchHarnessDriver(ops, OPTS);
    await driver.spinRunAndCost(req({ blueprintId: 'coding-solo' }));
    expect(calls.created[0]).toContain('coding-solo');
  });

  it('honors a custom trajectoryRef builder', async () => {
    const { ops } = fakeOps();
    const driver = liveBenchHarnessDriver(ops, { ...OPTS, trajectoryRef: (h) => `rollout://traj/${h.slug}` });
    const run = await driver.spinRunAndCost(req());
    expect(run.telemetry.trajectoryRef).toBe('rollout://traj/xbench-fake');
  });
});

// ── disposition → stopReason mapping ─────────────────────────────────────────
describe('disposition → stopReason mapping', () => {
  const cases: Array<[DriveDisposition, string]> = [
    ['done', 'done'],
    ['escalate', 'escalate'],
    ['budget-exhausted', 'budget-exhausted'],
    ['max-turns', 'max-turns'],
    ['timeout', 'max-turns'], // a wall-clock cap-hit maps to the runaway-bound stop reason (still scored)
    ['error', 'error'],
  ];
  it.each(cases)('stopReasonForDisposition(%s) → %s', (d, expected) => {
    expect(stopReasonForDisposition(d)).toBe(expected);
  });

  it('an ESCALATE disposition → stopReason escalate, costs still summed, NO generationError (a real terminal)', async () => {
    const { ops } = fakeOps({ drive: { disposition: 'escalate', detail: 'feature status=blocked' } });
    const run = await liveBenchHarnessDriver(ops, OPTS).spinRunAndCost(req());
    expect(run.telemetry.stopReason).toBe('escalate');
    expect(run.telemetry.costUsd).toBe(4.2); // a real, scored terminal still carries its spend
    expect(run.telemetry.generationError).toBeUndefined(); // escalate is NOT an infra failure
  });

  it('a BUDGET-EXHAUSTED disposition → stopReason budget-exhausted with the spend that triggered it', async () => {
    const { ops } = fakeOps({
      drive: { disposition: 'budget-exhausted' },
      cost: { tokensIn: 600_000, tokensOut: 420_000, costUsd: 25, turns: 30 },
    });
    const run = await liveBenchHarnessDriver(ops, OPTS).spinRunAndCost(req());
    expect(run.telemetry.stopReason).toBe('budget-exhausted');
    expect(run.telemetry.costUsd).toBe(25);
    expect(run.telemetry.generationError).toBeUndefined();
  });

  it('a TIMEOUT disposition → stopReason max-turns (the runaway bound)', async () => {
    const { ops } = fakeOps({ drive: { disposition: 'timeout', detail: 'did not settle' } });
    const run = await liveBenchHarnessDriver(ops, OPTS).spinRunAndCost(req());
    expect(run.telemetry.stopReason).toBe('max-turns');
  });
});

// ── the NEVER-throws-on-failure contract ─────────────────────────────────────
describe('never throws on failure — returns error telemetry instead', () => {
  it('a CREATE failure → error telemetry (zeroed cost, worktree falls back to checkout.dir), no throw', async () => {
    const { ops, order } = fakeOps({ throwOn: 'createHarness' });
    const checkout = fakeCheckout();
    const run = await liveBenchHarnessDriver(ops, OPTS).spinRunAndCost(req({ checkout }));

    expect(run.telemetry.stopReason).toBe('error');
    expect(run.telemetry.generationError).toMatch(/createHarness blew up/);
    expect(run.telemetry.costUsd).toBe(0); // no handle ⇒ no cost read ⇒ zeroed (no phantom tokens)
    expect(run.telemetry.tokensIn).toBe(0);
    expect(run.worktreePath).toBe(checkout.dir); // falls back to the checkout dir
    expect(order).toEqual(['create']); // nothing past the failing create — and crucially no cost/teardown over a null handle
  });

  it('a DRIVE failure → error telemetry, but cost IS still summed (real spend before the failure) + teardown STILL runs', async () => {
    const { ops, order } = fakeOps({ throwOn: 'driveToDone' });
    const run = await liveBenchHarnessDriver(ops, OPTS).spinRunAndCost(req());

    expect(run.telemetry.stopReason).toBe('error');
    expect(run.telemetry.generationError).toMatch(/driveToDone blew up/);
    // The harness was created, so the cost read + teardown still run (count real spend; never leak a harness).
    expect(run.telemetry.costUsd).toBe(4.2);
    expect(order).toEqual(['create', 'feed', 'drive', 'cost', 'teardown']);
  });

  it('a COST-read failure degrades to zeroed cost, never throws, and teardown still runs', async () => {
    const { ops, order } = fakeOps({ throwOn: 'collectCost' });
    const run = await liveBenchHarnessDriver(ops, OPTS).spinRunAndCost(req());
    // The drive itself succeeded (done), but the cost read threw → degrade to zero, keep the done stopReason.
    expect(run.telemetry.stopReason).toBe('done');
    expect(run.telemetry.costUsd).toBe(0);
    expect(order).toContain('teardown'); // teardown still runs after a cost-read failure
  });

  it('a TEARDOWN failure is swallowed — the run still returns its telemetry', async () => {
    const { ops } = fakeOps({ throwOn: 'teardown' });
    const run = await liveBenchHarnessDriver(ops, OPTS).spinRunAndCost(req());
    expect(run.telemetry.stopReason).toBe('done');
    expect(run.telemetry.costUsd).toBe(4.2); // teardown failing doesn't lose the run's result
  });
});

// ── the binding wires into instantiateBenchHarness (the port the pilot calls) ─
describe('bindLiveBenchHarness wires the driver into instantiateBenchHarness', () => {
  it('after binding, the port delegates to the live driver (over injected fake ops) — no real harness', async () => {
    const { ops, order } = fakeOps();
    bindLiveBenchHarness(OPTS, ops); // inject the fake ops — proves the wiring without real machinery

    const run = await instantiateBenchHarness('external-bench', TASK, fakeCheckout(), BUDGET);

    expect(order).toEqual(['create', 'feed', 'drive', 'cost', 'teardown']);
    expect(run.telemetry.stopReason).toBe('done');
    expect(run.telemetry.costUsd).toBe(4.2);
  });

  it('a bound driver that hits an error still surfaces as error telemetry through the port (never throws)', async () => {
    const { ops } = fakeOps({ throwOn: 'createHarness' });
    bindLiveBenchHarness(OPTS, ops);
    const run = await instantiateBenchHarness('coding-solo', TASK, fakeCheckout(), BUDGET);
    expect(run.telemetry.stopReason).toBe('error');
    expect(run.telemetry.generationError).toMatch(/createHarness blew up/);
  });
});
