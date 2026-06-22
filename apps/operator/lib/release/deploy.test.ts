/**
 * Deploy orchestration tests — the step order + rollback-on-failure are the
 * load-bearing safety property (a deploy that swaps code but skips snapshot, or
 * fails health without rolling back, would wedge the fleet). Stub deps so we
 * test pure orchestration; real wiring is exercised in the e2e integration test.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  gatherPlan,
  executeDeploy,
  isDesktopOnlyDelta,
  DESKTOP_SUBMODULE_PATH,
  type DeployDeps,
  type DeployPlan,
  type SnapshotInfo,
} from './deploy';
import { git, revParse } from './git-ops';
import { releaseConfig } from './release-config';

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
    preflight: () => rec('preflight', { ok: true }),
    restoreSnapshot: () => rec('restoreSnapshot', undefined).then(() => undefined),
    broadcast: (s) => {
      calls.push(`broadcast:${s.includes('✅') ? 'ok' : s.includes('❌') ? 'fail' : 'other'}`);
      return Promise.resolve();
    },
    // The deploy records its own pipeline event (deployer-dies-with-deployed,
    // 2026-06-06: the routine's host dies at the deploy's restart step, so only
    // the deploy process can report the outcome).
    recordEvent: (ev) => {
      calls.push(`recordEvent:${ev.status}`);
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

const plan: DeployPlan = {
  target: 'ready',
  targetSha: 'abcdef1234567890',
  currentReleaseSha: '1111111111111111',
  isFastForward: true,
  green: true,
  forced: false,
  commits: ['c1', 'c2'],
  migrations: ['libs/papercusp/libs/db/sql/200-x.sql'],
  warnings: [],
  noop: false,
  desktopOnly: false,
  risk: { tier: 'review', autoDeployable: false, reasons: ['1 staged migration(s)'], blocked: [] },
};
const cfg = releaseConfig();

describe('isDesktopOnlyDelta — D-003 desktop-only deploy skip', () => {
  it('is true when the only changed path is the papercusp-desktop gitlink', () => {
    expect(isDesktopOnlyDelta([DESKTOP_SUBMODULE_PATH])).toBe(true);
  });
  it('is true for paths under the submodule', () => {
    expect(isDesktopOnlyDelta(['papercusp-desktop/src-tauri/tauri.conf.json'])).toBe(true);
  });
  it('is false when any non-desktop path also changed', () => {
    expect(isDesktopOnlyDelta(['papercusp-desktop', 'apps/operator/lib/x.ts'])).toBe(false);
    expect(isDesktopOnlyDelta(['apps/operator/lib/x.ts'])).toBe(false);
  });
  it('is false for an empty delta (the noop case, gated separately)', () => {
    expect(isDesktopOnlyDelta([])).toBe(false);
  });
  it('does not treat a sibling prefix (papercusp-desktop-extras) as inside the submodule', () => {
    expect(isDesktopOnlyDelta(['papercusp-desktop-extras/x'])).toBe(false);
  });
});

describe('executeDeploy — happy path', () => {
  it('runs steps in order inside the drain, broadcasts success', async () => {
    const { deps, calls } = makeDeps();
    const res = await executeDeploy(cfg, plan, deps);
    expect(res.ok).toBe(true);
    expect(res.rolledBack).toBe(false);
    // drain wraps everything; snapshot precedes swap precedes migrate precedes restart
    expect(calls[0]).toBe('drain:acquire');
    expect(calls.indexOf('snapshot')).toBeLessThan(calls.indexOf('runSetup:abcd'));
    // P-001: preflight runs AFTER the swap but strictly BEFORE migrate + the live restart.
    expect(calls.indexOf('runSetup:abcd')).toBeLessThan(calls.indexOf('preflight'));
    expect(calls.indexOf('preflight')).toBeLessThan(calls.indexOf('migrate'));
    expect(calls.indexOf('migrate')).toBeLessThan(calls.indexOf('restart'));
    expect(calls.indexOf('restart')).toBeLessThan(calls.indexOf('health'));
    expect(calls).toContain('broadcast:ok');
    expect(calls).toContain('recordEvent:ok'); // the deploy reports its own outcome
    expect(calls[calls.length - 1]).toBe('drain:release');
  });
});

describe('executeDeploy — rollback on failure', () => {
  it('rolls back code + db + restart when health fails (migrations staged)', async () => {
    // Deploy health fails on the 1st probe; the post-rollback probe succeeds.
    let healthCalls = 0;
    const { deps, calls } = makeDeps({
      health: () => {
        healthCalls++;
        return Promise.resolve(
          healthCalls === 1
            ? { healthy: false, attempts: 3, elapsedMs: 90, error: 'never came up' }
            : { healthy: true, attempts: 1, elapsedMs: 10 },
        );
      },
    });
    const res = await executeDeploy(cfg, plan, deps);
    expect(res.ok).toBe(false);
    expect(res.rolledBack).toBe(true);
    // rolled the release ref back to the prior sha + restored DB (migrations staged) + restarted
    expect(calls).toContain('runSetup:1111');
    expect(calls).toContain('restoreSnapshot');
    expect(calls).toContain('broadcast:fail');
    expect(calls).toContain('recordEvent:rolled-back');
    expect(calls[calls.length - 1]).toBe('drain:release');
  });

  it('skips DB restore on code-only failures (no migrations)', async () => {
    const noMig = { ...plan, migrations: [] };
    const { deps, calls } = makeDeps({ fail: 'restart' });
    const res = await executeDeploy(cfg, noMig, deps);
    expect(res.ok).toBe(false);
    expect(calls).not.toContain('restoreSnapshot'); // code-only → no destructive DB restore
    expect(calls).toContain('runSetup:1111'); // code reverted
  });

  it('reports rollback failure loudly (operator may need manual recovery)', async () => {
    const { deps, calls } = makeDeps({
      health: () => Promise.resolve({ healthy: false, attempts: 1, elapsedMs: 5, error: 'down' }),
      runSetup: (sha) => (sha.startsWith('1111') ? Promise.reject(new Error('rollback git failed')) : Promise.resolve()),
    });
    const res = await executeDeploy(cfg, plan, deps);
    expect(res.ok).toBe(false);
    expect(res.rolledBack).toBe(false);
    expect(calls).toContain('broadcast:fail');
  });
});

describe('executeDeploy — pre-cutover preflight (P-001, the MODULE_NOT_FOUND crash-loop guard)', () => {
  it('a FAILING preflight aborts before cutover: no migrate, NO live restart, tree reverted, zero downtime', async () => {
    let preflightCalled = false;
    const { deps, calls } = makeDeps({
      preflight: () => {
        preflightCalled = true;
        return Promise.resolve({ ok: false, error: "Cannot find module '@papercusp/x' (MODULE_NOT_FOUND)" });
      },
    });
    const res = await executeDeploy(cfg, plan, deps);
    expect(preflightCalled).toBe(true);
    expect(res.ok).toBe(false);
    // Pre-cutover failure ⇒ the live process never changed ⇒ counts as rolled back (to prev).
    expect(res.rolledBack).toBe(true);
    expect(calls).toContain('runSetup:abcd'); // the swap happened
    expect(calls).not.toContain('migrate'); // aborted BEFORE migrate (no schema change)
    expect(calls).not.toContain('restart'); // :3070 was NEVER cut over (no crash-loop, no downtime)
    expect(calls).not.toContain('restoreSnapshot'); // no migration applied → no destructive DB restore
    expect(calls).toContain('runSetup:1111'); // tree reverted to the prior consistent sha
    expect(calls).toContain('broadcast:fail');
    expect(calls[calls.length - 1]).toBe('drain:release');
  });

  it('a PASSING preflight proceeds to the normal cutover', async () => {
    const { deps, calls } = makeDeps(); // default preflight ok:true
    const res = await executeDeploy(cfg, plan, deps);
    expect(res.ok).toBe(true);
    expect(calls).toContain('preflight');
    expect(calls.indexOf('preflight')).toBeLessThan(calls.indexOf('restart'));
  });

  it('rollback-side preflight failure (prev also won\'t boot) → no second restart, manual recovery (P-002)', async () => {
    let pfCalls = 0;
    const { deps, calls } = makeDeps({
      // pass the pre-cutover check (so we DO cut over), then FAIL the rollback-side check
      preflight: () => {
        pfCalls++;
        return Promise.resolve(pfCalls === 1 ? { ok: true } : { ok: false, error: 'prev node_modules incomplete' });
      },
      // health fails after the live restart → forces a rollback
      health: () => Promise.resolve({ healthy: false, attempts: 1, elapsedMs: 5, error: 'down' }),
    });
    const res = await executeDeploy(cfg, plan, deps);
    expect(res.ok).toBe(false);
    expect(pfCalls).toBe(2); // pre-cutover + rollback-side preflight both ran
    expect(res.rolledBack).toBe(false); // prev won't boot → rollback could not safely complete
    expect(calls).toContain('runSetup:1111'); // tree reverted to prev (code)
    expect(calls.filter((c) => c === 'restart').length).toBe(1); // deploy restart only — rollback-restart SKIPPED (no 2nd crash-loop)
    expect(calls).toContain('broadcast:fail');
  });
});

describe('gatherPlan', () => {
  let repo: string;
  let release: string;
  async function commit(file: string, content: string, msg: string): Promise<string> {
    const full = join(repo, file);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
    await git(repo, ['add', '-A']);
    await git(repo, ['commit', '--no-verify', '-q', '-m', msg]);
    return revParse(repo, 'HEAD');
  }
  beforeEach(async () => {
    repo = mkdtempSync(join(tmpdir(), 'reldep-int-'));
    release = mkdtempSync(join(tmpdir(), 'reldep-rel-'));
    await git(repo, ['init', '-q', '-b', 'main']);
    await git(repo, ['config', 'user.email', 't@e.com']);
    await git(repo, ['config', 'user.name', 'T']);
    await git(repo, ['config', 'commit.gpgsign', 'false']);
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(release, { recursive: true, force: true });
  });

  it('plans a green FF deploy with staged migrations', async () => {
    const c1 = await commit('a.txt', '1', 'c1');
    await git(repo, ['branch', 'ready', c1]);
    // release checkout at c1
    await git(repo, ['worktree', 'add', '--detach', release, c1]);
    // advance main + ready with a migration
    await commit('libs/papercusp/libs/db/sql/300-z.sql', 'SELECT 1;', 'mig');
    const c3 = await commit('apps/operator/lib/x.ts', 'x', 'code');
    await git(repo, ['branch', '-f', 'ready', c3]);

    const p = await gatherPlan(releaseConfig({ integrationRoot: repo, releaseRoot: release, releaseRef: 'ready' }));
    expect(p.targetSha).toBe(c3);
    expect(p.currentReleaseSha).toBe(c1);
    expect(p.green).toBe(true);
    expect(p.isFastForward).toBe(true);
    expect(p.migrations).toEqual(['libs/papercusp/libs/db/sql/300-z.sql']);
    expect(p.commits.length).toBe(2);
    expect(p.noop).toBe(false);
    await git(repo, ['worktree', 'remove', '--force', release]).catch(() => {});
  });

  it('warns when target is not green and not forced', async () => {
    const c1 = await commit('a.txt', '1', 'c1');
    await git(repo, ['branch', 'ready', c1]);
    const c2 = await commit('a.txt', '2', 'c2'); // main ahead of ready
    const p = await gatherPlan(releaseConfig({ integrationRoot: repo, releaseRoot: repo, releaseRef: 'ready' }), {
      target: c2,
    });
    expect(p.green).toBe(false);
    expect(p.warnings.some((w) => w.includes('NOT the green'))).toBe(true);
  });
});
