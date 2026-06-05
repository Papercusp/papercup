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
import { gatherPlan, executeDeploy, type DeployDeps, type DeployPlan, type SnapshotInfo } from './deploy';
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

const plan: DeployPlan = {
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
  risk: { tier: 'review', autoDeployable: false, reasons: ['1 staged migration(s)'], blocked: [] },
};
const cfg = releaseConfig();

describe('executeDeploy — happy path', () => {
  it('runs steps in order inside the drain, broadcasts success', async () => {
    const { deps, calls } = makeDeps();
    const res = await executeDeploy(cfg, plan, deps);
    expect(res.ok).toBe(true);
    expect(res.rolledBack).toBe(false);
    // drain wraps everything; snapshot precedes swap precedes migrate precedes restart
    expect(calls[0]).toBe('drain:acquire');
    expect(calls.indexOf('snapshot')).toBeLessThan(calls.indexOf('runSetup:abcd'));
    expect(calls.indexOf('runSetup:abcd')).toBeLessThan(calls.indexOf('migrate'));
    expect(calls.indexOf('migrate')).toBeLessThan(calls.indexOf('restart'));
    expect(calls.indexOf('restart')).toBeLessThan(calls.indexOf('health'));
    expect(calls).toContain('broadcast:ok');
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
