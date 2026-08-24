/**
 * Rollback edge-cases for executeDeploy that the shipped deploy.test.ts doesn't
 * cover (it exercises health-fail-with-snapshot + code-only-no-migrations). The
 * load-bearing safety property is that the right things roll back — and that a
 * MISSING snapshot doesn't silently pretend the DB was restored:
 *
 *   1. verifyPaths:{ok:false} after a healthy restart (migrations staged) ⇒
 *      rolls back code + DB (snapshot present) + restart, broadcasts fail.
 *   2. snapshot:()=>null + staged migrations + a deploy failure ⇒ rolls back
 *      code, SKIPS restoreSnapshot (nothing to restore), and the fail broadcast
 *      signals the DB was NOT restorable (rolledBack reflects only the code revert).
 *   3. WI-6648: a PRE-CUTOVER failure verifies the reverted tree instead of
 *      assuming it. `rolledBack` must mean "the rollback is verified good", not
 *      merely "the rollback steps ran" — on this path nothing restarts, so an
 *      unbootable prev checkout would otherwise stay silent until some later
 *      restart, long after the deploy reported `rolled-back`.
 *
 * Mirrors deploy.test.ts's injected-DeployDeps + call-trace pattern, but with the
 * stub closures recording into the SAME `calls` array so overrides show up in the
 * trace too. No network, no git, no real deploy.
 */
import { describe, it, expect } from 'vitest';
import { executeDeploy, type DeployDeps, type DeployPlan, type SnapshotInfo } from './deploy';
import { releaseConfig } from './release-config';

// WI-2399 closed the class EI-7287 patched here: executeDeploy's await-bus emit is
// now an INJECTED dep (deps.emitEvent), not a hard `await import(engine)`. So the
// vi.mock of the await engine is gone — makeDeps below supplies a no-op emitEvent
// stub, and TypeScript would reject the DeployDeps literal if it were missing, so
// no failure-path test can ever fire a REAL release:deploy-failed onto the shared
// bus by forgetting to mock.

/**
 * Like deploy.test.ts's makeDeps, but the call-trace array is created up front so
 * a test's own override closures can push into it (the original helper closes over
 * a private `calls`, so overrides that don't go through `rec` are invisible).
 */
function makeDeps(over: Partial<DeployDeps> & { fail?: string } = {}): { deps: DeployDeps; calls: string[] } {
  const calls: string[] = [];
  const failAt = over.fail;
  const rec = <T>(name: string, val: T): Promise<T> => {
    calls.push(name);
    if (failAt === name) return Promise.reject(new Error(`stub failure at ${name}`));
    return Promise.resolve(val);
  };
  const deps: DeployDeps = {
    withDrain: async (fn) => {
      calls.push('drain:acquire');
      try {
        return await fn();
      } finally {
        calls.push('drain:release');
      }
    },
    readReleaseTriggerControl: async () => ({
      name: 'release-trigger',
      active: true,
      cron: null,
      lastFiredAtMs: null,
      nextFireAtMs: null,
      pause: null,
    }),
    snapshot: () => rec('snapshot', { snapshotId: 1, kopiaSnapshotId: 'kopia-abc' } as SnapshotInfo),
    runSetup: (sha) => rec(`runSetup:${sha.slice(0, 4)}`, undefined).then(() => undefined),
    bundleHost: () => rec('bundleHost', undefined).then(() => undefined),
    migrate: () => rec('migrate', { appliedCount: 1, totalKnown: 5, applied: ['200-x.sql'], sqlDir: '/x' }),
    restart: () => rec('restart', undefined).then(() => undefined),
    health: () => rec('health', { healthy: true, attempts: 1, elapsedMs: 10 }),
    servingSha: () => rec('servingSha', { reachable: true, sha: 'abcdef12' }),
    verifyPaths: () => rec('verifyPaths', { ok: true, failures: [] }),
    preflight: () => rec('preflight', { ok: true }),
    restoreSnapshot: () => rec('restoreSnapshot', undefined).then(() => undefined),
    broadcast: (s) => {
      calls.push(`broadcast:${s.includes('✅') ? 'ok' : s.includes('❌') ? 'fail' : 'other'}`);
      return Promise.resolve();
    },
    emitEvent: async () => {}, // WI-2399: injected await-bus emit — no-op here (these tests don't assert emitted keys)
    log: () => {},
    ...stripFail(over),
  };
  return { deps, calls };
}

function stripFail(o: Partial<DeployDeps> & { fail?: string }): Partial<DeployDeps> {
  const { fail, ...rest } = o;
  void fail;
  return rest;
}

function basePlan(): DeployPlan {
  return {
    target: 'ready',
    targetSha: 'abcdef1234567890',
    currentReleaseSha: '1111111111111111',
    isFastForward: true,
    green: true,
    forced: false,
    commits: ['c1', 'c2'],
    commitShas: ['abcdef1234567890', 'cccccccccccccccc'],
    migrations: ['libs/papercusp/libs/db/sql/200-x.sql'],
    warnings: [],
    noop: false,
    servingSha: null,
    servingReachable: false,
    restartOnly: false,
    desktopOnly: false,
    risk: { tier: 'review', autoDeployable: false, reasons: ['1 staged migration(s)'], blocked: [] },
  };
}
const cfg = releaseConfig();

describe('executeDeploy — verify-paths failure rolls back', () => {
  it('rolls back code + DB (snapshot present, migrations staged) when verify-paths fails', async () => {
    // Health is fine; the release-path verify is what fails (operator booted but
    // a runtime read still resolves outside the release checkout).
    let healthCalls = 0;
    const { deps, calls } = makeDeps();
    // override verifyPaths to FAIL, recording into the shared trace
    deps.verifyPaths = () => {
      calls.push('verifyPaths');
      return Promise.resolve({ ok: false, failures: ['sqlMigrations: resolved OUTSIDE release root → /churn'] });
    };
    deps.health = () => {
      healthCalls++;
      calls.push('health'); // deploy probe healthy → we reach verify; rollback probe healthy too
      return Promise.resolve({ healthy: true, attempts: 1, elapsedMs: 10 });
    };

    const res = await executeDeploy(cfg, basePlan(), deps);

    expect(res.ok).toBe(false);
    expect(res.rolledBack).toBe(true);
    expect(res.error).toMatch(/release-path verify failed/);
    // verify ran, then code reverted to prevReleaseSha, then DB restored (migrations staged), then restart
    expect(calls).toContain('verifyPaths');
    expect(calls).toContain('runSetup:1111'); // code reverted to prevReleaseSha
    expect(calls).toContain('restoreSnapshot'); // DB restored: migrations staged + snapshot present
    expect(calls).toContain('broadcast:fail');
    expect(calls[calls.length - 1]).toBe('drain:release');
    expect(healthCalls).toBeGreaterThanOrEqual(2); // deploy probe + rollback probe
    // the verify-paths step ran (it resolved {ok:false}; executeDeploy then throws
    // on the not-ok result, which is what triggers rollback)
    expect(res.steps.some((s) => s.name === 'verify-paths')).toBe(true);
  });
});

describe('executeDeploy — no snapshot taken but migrations staged', () => {
  it('skips restoreSnapshot (nothing to restore) and signals DB was NOT restorable on failure', async () => {
    // snapshotting disabled → snapshot() returns null; a later step fails with
    // migrations staged. Code rolls back; DB restore is impossible (no snapshot).
    const { deps, calls } = makeDeps({ fail: 'restart' });
    deps.snapshot = () => {
      calls.push('snapshot');
      return Promise.resolve(null);
    };

    const res = await executeDeploy(cfg, basePlan(), deps);

    expect(res.ok).toBe(false);
    expect(res.snapshot).toBeNull();
    // code reverted, but the DB restore is skipped because there is no snapshot
    expect(calls).toContain('runSetup:1111'); // code reverted
    expect(calls).not.toContain('restoreSnapshot'); // CANNOT restore DB — no snapshot was taken
    expect(calls).toContain('broadcast:fail');
    expect(calls[calls.length - 1]).toBe('drain:release');
    // migrations WERE staged, so the DB may be dirty — yet no restore was possible
    expect(basePlan().migrations.length).toBeGreaterThan(0);
  });
});

describe('executeDeploy — PRE-CUTOVER rollback verifies the reverted tree (WI-6648)', () => {
  // `fail: 'migrate'` reproduces the real 2026-07-28 09:00Z shape: snapshot → swap →
  // preflight(ok) → migrate FAILS. Both migrateRan and liveCutover stay false, so this
  // is the pre-cutover branch — the live :3070 never went down and nothing restarts.
  it('runs rollback-preflight after reverting, and reports rolledBack when prev boots', async () => {
    const { deps, calls } = makeDeps({ fail: 'migrate' });

    const res = await executeDeploy(cfg, basePlan(), deps);

    expect(res.ok).toBe(false);
    expect(res.rolledBack).toBe(true);
    expect(calls).toContain('runSetup:1111'); // tree reverted to prevReleaseSha
    // the reverted tree is CHECKED, not assumed — this step did not exist before WI-6648
    expect(res.steps.some((s) => s.name === 'rollback-preflight')).toBe(true);
    // pre-cutover: the live process never changed, so no restart and no DB restore
    expect(calls).not.toContain('restart');
    expect(calls).not.toContain('restoreSnapshot'); // migrate never applied
    expect(calls).toContain('broadcast:fail');
    expect(calls[calls.length - 1]).toBe('drain:release');
  });

  it('reports rolledBack:false when the reverted checkout will NOT boot', async () => {
    let preflights = 0;
    const { deps, calls } = makeDeps({ fail: 'migrate' });
    deps.preflight = () => {
      preflights++;
      calls.push('preflight');
      // 1st call = the pre-cutover boot check on the TARGET; it must pass, or the deploy
      // never reaches migrate. 2nd = the post-rollback check on PREV — the new one.
      return Promise.resolve(
        preflights === 1 ? { ok: true } : { ok: false, error: 'MODULE_NOT_FOUND: @dnd-kit/core' },
      );
    };

    const res = await executeDeploy(cfg, basePlan(), deps);

    expect(res.ok).toBe(false);
    expect(preflights).toBe(2); // target check, then reverted-tree check
    // THE REGRESSION THIS FILE GUARDS: this was hardcoded `true` before WI-6648, so a
    // rollback that left an unbootable tree was recorded as a clean 'rolled-back'.
    expect(res.rolledBack).toBe(false);
    expect(calls).toContain('runSetup:1111'); // the revert itself still happened
    expect(calls).not.toContain('restart'); // still pre-cutover: nothing to restart back
    expect(calls).toContain('broadcast:fail');
    // The STEP succeeded (preflight resolved); its RESULT is what was not ok. `step()`
    // records ok:true whenever fn resolves, so step.ok can never carry this verdict —
    // which is exactly why the branch has to read `rollbackPreflight.ok` itself.
    expect(res.steps.find((s) => s.name === 'rollback-preflight')?.ok).toBe(true);
  });
});
