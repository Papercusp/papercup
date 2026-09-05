/**
 * deploy-cli.ts `main()` — the gate's exit-code CHOKEPOINT.
 *
 * The shipped suite covers `gatherPlan` (deploy-gate.test.ts transcribes the
 * refusal predicate inline) but never drove the CLI's OWN exit code. This file
 * does: it injects the gather/deps/execute seams so `main()` runs end-to-end
 * with NO git, drain, restart, or real deploy, and asserts the three branches
 * the chokepoint guarantees:
 *
 *   - a non-green target with no --force → exit 2, and `executeDeploy` is NEVER
 *     called (the refusal happens BEFORE any real-effect dep is touched);
 *   - a green non-noop target → proceeds (executeDeploy runs), exit 0;
 *   - `--deploy-commit <sha>` → forces past the green gate AND emits the loud
 *     un-green audit broadcast before executing.
 */
import { describe, it, expect, vi } from 'vitest';
import { main } from './deploy-cli';
import { releaseConfig, type ReleaseConfig } from './release-config';
import type { DeployDeps, DeployPlan, DeployResult, ExecuteOpts } from './deploy';

const cfg = releaseConfig({ integrationRoot: '/tmp/int', releaseRoot: '/tmp/rel', releaseRef: 'ready' });

// Typed function shapes so the vi.fn mocks expose correctly-typed `.mock.calls`
// tuples (an untyped impl narrows the call-args to `[]`).
type GatherFn = (cfg: ReleaseConfig, opts: { target?: string; force?: boolean }) => Promise<DeployPlan>;
type ExecuteFn = (cfg: ReleaseConfig, plan: DeployPlan, deps: DeployDeps, opts: ExecuteOpts) => Promise<DeployResult>;
type BroadcastFn = (summary: string, body?: string) => Promise<void>;

/** A DeployPlan with the fields `main()` reads, overridable per test. */
function makePlan(over: Partial<DeployPlan> = {}): DeployPlan {
  return {
    target: 'ready',
    targetSha: 'a'.repeat(40),
    currentReleaseSha: 'b'.repeat(40),
    isFastForward: true,
    green: true,
    forced: false,
    commits: ['c1', 'c2'],
    commitShas: ['a'.repeat(40), 'c'.repeat(40)],
    migrations: [],
    warnings: [],
    noop: false,
    servingSha: null,
    servingReachable: false,
    restartOnly: false,
    desktopOnly: false,
    risk: { tier: 'auto', autoDeployable: true, reasons: [], blocked: [] },
    ...over,
  };
}

/** A DeployDeps stub — only `broadcast` is exercised by `main()` directly. */
function makeStubDeps(over: Partial<DeployDeps> = {}): DeployDeps {
  return {
    withDrain: async (fn) => fn(),
    // null is a valid RoutineInfo read ("routine not found") and keeps this stub
    // robust to RoutineInfo widening — main() never reads it (executeDeploy is
    // stubbed), so the value is inert here.
    readReleaseTriggerControl: async () => null,
    readLiveReleaseCertification: async (targetSha) => ({
      status: 'certified', targetSha, certified: true, reason: 'exact source certified',
      bankPath: '/tmp/verdicts.jsonl', evidence: null, invalidLines: 0,
    }),
    snapshot: async () => null,
    runSetup: async () => {},
    bundleHost: async () => {},
    migrate: async () => ({ appliedCount: 0, totalKnown: 0, applied: [], sqlDir: '/tmp' }),
    restart: async () => {},
    health: async () => ({ healthy: true, attempts: 1, elapsedMs: 0 }),
    servingSha: async () => ({ reachable: true, sha: 'abcdef12' }),
    verifyPaths: async () => ({ ok: true, failures: [] }),
    preflight: async () => ({ ok: true }),
    restoreSnapshot: async () => {},
    broadcast: async () => {},
    emitEvent: async () => {}, // WI-2399: injected await-bus emit (main() never reaches it — executeDeploy is stubbed)
    log: () => {},
    ...over,
  };
}

const okResult = (plan: DeployPlan): DeployResult => ({
  ok: true,
  plan,
  steps: [],
  snapshot: null,
  rolledBack: false,
});

// EI-13729: main() now wraps the --execute path in the release-deploy
// single-flight lock. Stub it to "always acquire" so the existing tests keep
// exercising the flow directly, without touching PG/su-lock-store.
const alwaysAcquires = async <T>(fn: () => Promise<T>): Promise<{ acquired: true; result: T }> => ({
  acquired: true,
  result: await fn(),
});

// P-015: recordParity defaults to the REAL fact/coord writer — stubbed here so
// no test ever writes live facts or severe-event broadcasts from a stubbed
// deploy (same rule as recordRefused/recordCoalesced). Tests that assert on it
// override with their own vi.fn.
// EI-20459175302238839: censusStranded defaults to the REAL census, which shells out to
// `git submodule status --recursive` against cfg.integrationRoot. Stubbed to a measured
// all-clear here for the same reason as recordRefused/recordParity — a unit test of the
// exit-code chokepoint must spawn no git and touch no tree. The strand-gate tests below
// override it explicitly; `[]` (measured, clean) is the neutral value, NOT null.
const silent = {
  out: () => {},
  err: () => {},
  runUnderDeployLock: alwaysAcquires,
  recordParity: async () => {},
  censusStranded: async () => [],
};

describe('deploy-cli main() — the gate chokepoint', () => {
  it('REFUSES a non-green target without --force → exit 2, executeDeploy NEVER called', async () => {
    const executeDeploy = vi.fn<ExecuteFn>();
    const makeDeps = vi.fn(() => makeStubDeps());
    const recordRefused = vi.fn(async () => {}); // stub: never write live pipeline_events
    const code = await main({
      ...silent,
      argv: ['node', 'deploy-cli.ts', '--execute'],
      cfg,
      gatherPlan: async () => makePlan({ green: false, forced: false }),
      makeDeps,
      executeDeploy,
      recordRefused,
    });

    expect(code).toBe(2);
    expect(executeDeploy).not.toHaveBeenCalled();
    // The refusal happens before any real-effect dep is built.
    expect(makeDeps).not.toHaveBeenCalled();
    // The 'refused' event is recorded (the fold counts it), via the injected stub.
    expect(recordRefused).toHaveBeenCalledWith(makePlan({ green: false, forced: false }).targetSha);
  });

  it('PLAN ONLY (no --execute) → exit 0, never deploys even when green', async () => {
    const executeDeploy = vi.fn<ExecuteFn>();
    const code = await main({
      ...silent,
      argv: ['node', 'deploy-cli.ts'], // no --execute
      cfg,
      gatherPlan: async () => makePlan({ green: true }),
      makeDeps: () => makeStubDeps(),
      executeDeploy,
    });
    expect(code).toBe(0);
    expect(executeDeploy).not.toHaveBeenCalled();
  });

  it('noop (release already at target) → exit 0, never deploys', async () => {
    const executeDeploy = vi.fn<ExecuteFn>();
    const code = await main({
      ...silent,
      argv: ['node', 'deploy-cli.ts', '--execute'],
      cfg,
      gatherPlan: async () => makePlan({ green: true, noop: true }),
      makeDeps: () => makeStubDeps(),
      executeDeploy,
    });
    expect(code).toBe(0);
    expect(executeDeploy).not.toHaveBeenCalled();
  });

  it('a green non-noop target PROCEEDS — executeDeploy runs, exit 0, NO forced broadcast', async () => {
    const broadcast = vi.fn<BroadcastFn>(async () => {});
    const plan = makePlan({ green: true, noop: false });
    const executeDeploy = vi.fn<ExecuteFn>(async () => okResult(plan));
    const code = await main({
      ...silent,
      argv: ['node', 'deploy-cli.ts', '--execute'],
      cfg,
      gatherPlan: async () => plan,
      makeDeps: () => makeStubDeps({ broadcast }),
      executeDeploy,
    });

    expect(executeDeploy).toHaveBeenCalledTimes(1);
    // rollbackOnFailure default true (no --no-rollback flag).
    expect(executeDeploy.mock.calls[0]![3]).toEqual({ rollbackOnFailure: true });
    expect(code).toBe(0);
    // A green deploy does NOT emit the un-green escape-hatch broadcast.
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('a failed deploy → exit 1', async () => {
    const plan = makePlan({ green: true, noop: false });
    const code = await main({
      ...silent,
      argv: ['node', 'deploy-cli.ts', '--execute'],
      cfg,
      gatherPlan: async () => plan,
      makeDeps: () => makeStubDeps(),
      executeDeploy: async () => ({ ...okResult(plan), ok: false, rolledBack: true, error: 'health failed' }),
    });
    expect(code).toBe(1);
  });

  it('--deploy-commit <sha> FORCES an un-green deploy + emits the loud audit broadcast', async () => {
    const broadcast = vi.fn<BroadcastFn>(async () => {});
    const sha = 'f'.repeat(40);
    // deploy-commit targets a specific (un-green) sha; gatherPlan reflects force.
    const plan = makePlan({ green: false, forced: true, noop: false, targetSha: sha, migrations: ['142-x.sql'] });
    const gatherPlan = vi.fn<GatherFn>(async () => plan);
    const executeDeploy = vi.fn<ExecuteFn>(async () => okResult(plan));

    const code = await main({
      ...silent,
      argv: ['node', 'deploy-cli.ts', '--deploy-commit', sha, '--execute'],
      cfg,
      gatherPlan,
      makeDeps: () => makeStubDeps({ broadcast }),
      executeDeploy,
    });

    // --deploy-commit implies force + sets target to the sha.
    expect(gatherPlan.mock.calls[0]![1]).toEqual({ target: sha, force: true });
    // The loud un-green audit broadcast fires BEFORE the deploy.
    expect(broadcast).toHaveBeenCalledTimes(1);
    const [summary, body] = broadcast.mock.calls[0]!;
    expect(summary).toMatch(/FORCED un-green deploy/);
    expect(summary).toContain(sha.slice(0, 8));
    expect(body).toContain('142-x.sql');
    // …and it still proceeds to execute.
    expect(executeDeploy).toHaveBeenCalledTimes(1);
    expect(code).toBe(0);
  });

  it('--force (without --deploy-commit) also proceeds past the green gate', async () => {
    const broadcast = vi.fn<BroadcastFn>(async () => {});
    const plan = makePlan({ green: false, forced: true, noop: false });
    const executeDeploy = vi.fn<ExecuteFn>(async () => okResult(plan));
    const code = await main({
      ...silent,
      argv: ['node', 'deploy-cli.ts', '--force', '--execute'],
      cfg,
      gatherPlan: async () => plan,
      makeDeps: () => makeStubDeps({ broadcast }),
      executeDeploy,
    });
    expect(executeDeploy).toHaveBeenCalledTimes(1);
    expect(broadcast).toHaveBeenCalledTimes(1); // un-green → loud broadcast
    expect(code).toBe(0);
  });

  it('EI-13729: a COALESCED lock (another deploy in flight) → exit 0, gatherPlan and executeDeploy NEVER called', async () => {
    const gatherPlan = vi.fn<GatherFn>(async () => makePlan({ green: true }));
    const executeDeploy = vi.fn<ExecuteFn>();
    const runUnderDeployLock = vi.fn(async () => ({ acquired: false as const, holder: 'release-deploy:9999:abc' }));
    const code = await main({
      ...silent,
      runUnderDeployLock,
      argv: ['node', 'deploy-cli.ts', '--execute'],
      cfg,
      gatherPlan,
      makeDeps: () => makeStubDeps(),
      executeDeploy,
    });

    expect(code).toBe(0);
    // The whole point: a coalesced attempt never even computes a plan against
    // state that may already be stale by the time it would run.
    expect(gatherPlan).not.toHaveBeenCalled();
    expect(executeDeploy).not.toHaveBeenCalled();
    expect(runUnderDeployLock).toHaveBeenCalledTimes(1);
  });

  it('EI-18835078701597295: a COALESCED attempt is RECORDED durably, with the holder and its liveness', async () => {
    // The CLI is one process per attempt, so "how many attempts in a row coalesced" cannot
    // live in memory here. Without this durable row the consecutive-coalesce alarm has
    // nothing to count and a wedged holder halts delivery with nothing paging.
    const recordCoalesced = vi.fn(async () => {});
    const code = await main({
      ...silent,
      runUnderDeployLock: vi.fn(async () => ({
        acquired: false as const,
        holder: 'release-deploy:9999:abc',
        holderAlive: false,
      })),
      recordCoalesced,
      argv: ['node', 'deploy-cli.ts', '--execute'],
      cfg,
      gatherPlan: vi.fn<GatherFn>(async () => makePlan({ green: true })),
      makeDeps: () => makeStubDeps(),
      executeDeploy: vi.fn<ExecuteFn>(),
    });

    expect(code).toBe(0);
    // holderAlive must survive verbatim — it is what separates a healthy queue behind a
    // live deploy from a leaked lease the reclaim should already have taken.
    expect(recordCoalesced).toHaveBeenCalledWith({ holder: 'release-deploy:9999:abc', holderAlive: false });
  });

  it('EI-18835078701597295: a telemetry failure on the coalesce path never changes the exit code', async () => {
    // Best-effort by construction: the deploy path must not fail because recording did.
    const recordCoalesced = vi.fn(async () => {
      throw new Error('pipeline_events unreachable');
    });
    const code = await main({
      ...silent,
      runUnderDeployLock: vi.fn(async () => ({ acquired: false as const, holder: 'h', holderAlive: true })),
      recordCoalesced,
      argv: ['node', 'deploy-cli.ts', '--execute'],
      cfg,
      gatherPlan: vi.fn<GatherFn>(async () => makePlan({ green: true })),
      makeDeps: () => makeStubDeps(),
      executeDeploy: vi.fn<ExecuteFn>(),
    });

    expect(recordCoalesced).toHaveBeenCalledTimes(1);
    expect(code).toBe(0);
  });

  it('a PLAN-ONLY invocation (no --execute) never consults the deploy lock', async () => {
    const runUnderDeployLock = vi.fn(alwaysAcquires);
    const code = await main({
      ...silent,
      // The Mock<> wrapper narrows the generic return below the field's union
      // type; the underlying function shape is exactly alwaysAcquires.
      runUnderDeployLock: runUnderDeployLock as typeof alwaysAcquires,
      argv: ['node', 'deploy-cli.ts'],
      cfg,
      gatherPlan: async () => makePlan({ green: true }),
      makeDeps: () => makeStubDeps(),
      executeDeploy: vi.fn<ExecuteFn>(),
    });
    expect(code).toBe(0);
    expect(runUnderDeployLock).not.toHaveBeenCalled();
  });

  it('--no-rollback is threaded into executeDeploy opts', async () => {
    const plan = makePlan({ green: true, noop: false });
    const executeDeploy = vi.fn<ExecuteFn>(async () => okResult(plan));
    await main({
      ...silent,
      argv: ['node', 'deploy-cli.ts', '--execute', '--no-rollback'],
      cfg,
      gatherPlan: async () => plan,
      makeDeps: () => makeStubDeps(),
      executeDeploy,
    });
    expect(executeDeploy.mock.calls[0]![3]).toEqual({ rollbackOnFailure: false });
  });

  it('P-015: a COMPLETED deploy reports its parity consequence — forced ok → { ok:true, green:false }', async () => {
    const recordParity = vi.fn(async () => {});
    const plan = makePlan({ green: false, forced: true, noop: false });
    const code = await main({
      ...silent,
      recordParity,
      argv: ['node', 'deploy-cli.ts', '--force', '--execute'],
      cfg,
      gatherPlan: async () => plan,
      makeDeps: () => makeStubDeps(),
      executeDeploy: async () => okResult(plan),
    });
    expect(code).toBe(0);
    expect(recordParity).toHaveBeenCalledTimes(1);
    expect(recordParity).toHaveBeenCalledWith({
      ok: true,
      green: false,
      targetSha: plan.targetSha,
      installSlug: expect.any(String),
      integrationRoot: cfg.integrationRoot,
    });
  });

  it('P-015: a parity-recorder failure never changes the exit code (best-effort by construction)', async () => {
    const recordParity = vi.fn(async () => {
      throw new Error('facts store unreachable');
    });
    const plan = makePlan({ green: true, noop: false });
    const code = await main({
      ...silent,
      recordParity,
      argv: ['node', 'deploy-cli.ts', '--execute'],
      cfg,
      gatherPlan: async () => plan,
      makeDeps: () => makeStubDeps(),
      executeDeploy: async () => okResult(plan),
    });
    expect(recordParity).toHaveBeenCalledTimes(1);
    expect(code).toBe(0);
  });
});
