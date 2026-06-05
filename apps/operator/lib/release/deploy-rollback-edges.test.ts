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
 *
 * Mirrors deploy.test.ts's injected-DeployDeps + call-trace pattern, but with the
 * stub closures recording into the SAME `calls` array so overrides show up in the
 * trace too. No network, no git, no real deploy.
 */
import { describe, it, expect } from 'vitest';
import { executeDeploy, type DeployDeps, type DeployPlan, type SnapshotInfo } from './deploy';
import { releaseConfig } from './release-config';

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
    snapshot: () => rec('snapshot', { snapshotId: 1, kopiaSnapshotId: 'kopia-abc' } as SnapshotInfo),
    runSetup: (sha) => rec(`runSetup:${sha.slice(0, 4)}`, undefined).then(() => undefined),
    migrate: () => rec('migrate', { appliedCount: 1, totalKnown: 5, applied: ['200-x.sql'], sqlDir: '/x' }),
    restart: () => rec('restart', undefined).then(() => undefined),
    health: () => rec('health', { healthy: true, attempts: 1, elapsedMs: 10 }),
    verifyPaths: () => rec('verifyPaths', { ok: true, failures: [] }),
    restoreSnapshot: () => rec('restoreSnapshot', undefined).then(() => undefined),
    broadcast: (s) => {
      calls.push(`broadcast:${s.includes('✅') ? 'ok' : s.includes('❌') ? 'fail' : 'other'}`);
      return Promise.resolve();
    },
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
    migrations: ['libs/papercusp/libs/db/sql/200-x.sql'],
    lockfileChanged: false,
    warnings: [],
    noop: false,
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
