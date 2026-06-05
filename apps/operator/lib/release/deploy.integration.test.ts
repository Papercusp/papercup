/**
 * Deploy END-TO-END with REAL mechanics — plan release-gate-ready-branch, Phase 4.
 *
 * Drives the real setup-release-checkout.sh (git worktree FF + swap) and the real
 * deploy-time migration apply against a throwaway PG, through the real
 * executeDeploy orchestrator. Stubs only the bits that need live infra (Kopia
 * snapshot, dev-server drain, coord broadcast, systemctl, path-verify).
 *
 * Proves Phase-4 verification:
 *   (a) a deploy swaps the release checkout to `ready` (not raw HEAD) — release
 *       worktree HEAD + working files become the ready commit's, exactly;
 *   (c) a staged migration applies atomically with the code swap; and
 *   the rollback path reverts the release CODE to the prior commit on failure.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import postgres from 'postgres';
import { getTestPg } from '@papercusp/test-config';
import { git, revParse } from './git-ops';
import { gatherPlan, executeDeploy, type DeployDeps, type SnapshotInfo } from './deploy';
import { releaseConfig } from './release-config';
import { applyStagedMigrations } from './migrate';

const SETUP_SCRIPT = resolve(__dirname, '../../bin/release/setup-release-checkout.sh');

let dbUrl: string;
let integ: string;
let release: string;
let c1: string;
let c2: string;
const MIG = 'libs/papercusp/libs/db/sql/950-deploy-e2e.sql';
const TABLE = 'harness_shared.deploy_e2e_t';

beforeAll(async () => {
  dbUrl = await getTestPg();
}, 120_000);

async function commit(file: string, content: string, msg: string): Promise<string> {
  const full = join(integ, file);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content);
  await git(integ, ['add', '-A']);
  await git(integ, ['commit', '--no-verify', '-q', '-m', msg]);
  return revParse(integ, 'HEAD');
}

beforeEach(async () => {
  // Reset this test's migration artifact in the reused testcontainer DB so each
  // run applies it fresh (the runner is idempotent).
  const reset = postgres(dbUrl, { max: 1 });
  try {
    await reset`DELETE FROM harness_shared.schema_migrations WHERE filename = '950-deploy-e2e.sql'`.catch(() => {});
    await reset.unsafe(`DROP TABLE IF EXISTS ${TABLE}`).catch(() => {});
  } finally {
    await reset.end();
  }
  integ = mkdtempSync(join(tmpdir(), 'deploy-int-'));
  release = join(tmpdir(), `deploy-rel-${Math.floor(performance.now() * 1000)}`);
  await git(integ, ['init', '-q', '-b', 'main']);
  await git(integ, ['config', 'user.email', 't@e.com']);
  await git(integ, ['config', 'user.name', 'T']);
  await git(integ, ['config', 'commit.gpgsign', 'false']);
  // c1 = current release state (a sentinel file says "v1")
  c1 = await commit('SENTINEL', 'v1', 'c1 baseline');
  await git(integ, ['branch', 'ready', c1]);
  // stand up the release checkout at c1 via the REAL setup script
  await runSetup(c1);
  // c2 = green ready: sentinel→v2 + a staged migration
  await commit('SENTINEL', 'v2', 'c2 sentinel bump');
  c2 = await commit(MIG, `CREATE TABLE IF NOT EXISTS ${TABLE} (id int);`, 'c2 migration');
  await git(integ, ['branch', '-f', 'ready', c2]);
});

afterEach(async () => {
  await git(integ, ['worktree', 'remove', '--force', release]).catch(() => {});
  rmSync(integ, { recursive: true, force: true });
  rmSync(release, { recursive: true, force: true });
});

function runSetup(ref: string): Promise<void> {
  return new Promise((res, rej) => {
    const { spawn } = require('node:child_process');
    const p = spawn('bash', [SETUP_SCRIPT, '--ref', ref, '--integration', integ, '--release', release, '--node-modules', 'skip']);
    let err = '';
    p.stderr.on('data', (d: Buffer) => (err += d));
    p.on('close', (code: number) => (code === 0 ? res() : rej(new Error(`setup exited ${code}: ${err}`))));
  });
}

function makeDeps(health: () => Promise<{ healthy: boolean; attempts: number; elapsedMs: number; error?: string }>): {
  deps: DeployDeps;
  calls: string[];
} {
  const calls: string[] = [];
  const deps: DeployDeps = {
    withDrain: (fn) => fn(),
    snapshot: async () => {
      calls.push('snapshot');
      return { snapshotId: 1, kopiaSnapshotId: 'e2e-snap' } as SnapshotInfo;
    },
    runSetup: async (sha) => {
      calls.push(`runSetup:${sha.slice(0, 7)}`);
      await runSetup(sha);
    },
    migrate: async () => {
      calls.push('migrate');
      return applyStagedMigrations({ sqlDir: join(release, 'libs/papercusp/libs/db/sql'), dbUrl, log: () => {} });
    },
    restart: async () => {
      calls.push('restart');
    },
    health,
    verifyPaths: async () => ({ ok: true, failures: [] }),
    restoreSnapshot: async () => {
      calls.push('restoreSnapshot');
    },
    broadcast: async () => {
      calls.push('broadcast');
    },
    log: () => {},
  };
  return { deps, calls };
}

const cfg = () => releaseConfig({ integrationRoot: integ, releaseRoot: release, releaseRef: 'ready' });

describe('deploy e2e (real git swap + real migrate)', () => {
  it('(a)+(c): swaps release checkout to ready and applies the staged migration', async () => {
    // pre: release checkout is at c1 (v1), ready is c2 (v2 + migration)
    expect(await revParse(release, 'HEAD')).toBe(c1);
    expect(readFileSync(join(release, 'SENTINEL'), 'utf8')).toBe('v1');

    const plan = await gatherPlan(cfg());
    expect(plan.green).toBe(true);
    expect(plan.migrations).toEqual([MIG]);

    const { deps } = makeDeps(async () => ({ healthy: true, attempts: 1, elapsedMs: 5 }));
    const res = await executeDeploy(cfg(), plan, deps);

    expect(res.ok).toBe(true);
    // (a) release checkout is now exactly the ready commit — code, not raw HEAD
    expect(await revParse(release, 'HEAD')).toBe(c2);
    expect(readFileSync(join(release, 'SENTINEL'), 'utf8')).toBe('v2');
    // (c) the staged migration applied to the DB
    expect(res.migrations?.applied).toContain('950-deploy-e2e.sql');
    const sql = postgres(dbUrl, { max: 1 });
    try {
      const rows = await sql<Array<{ t: string | null }>>`SELECT to_regclass(${TABLE})::text AS t`;
      expect(rows[0]!.t).toBe(TABLE);
    } finally {
      await sql.end();
    }
  });

  it('rolls the release CODE back to the prior commit when health fails', async () => {
    const plan = await gatherPlan(cfg());
    let n = 0;
    const { deps, calls } = makeDeps(async () => {
      n++;
      return n === 1
        ? { healthy: false, attempts: 3, elapsedMs: 30, error: 'down' }
        : { healthy: true, attempts: 1, elapsedMs: 5 };
    });
    const res = await executeDeploy(cfg(), plan, deps);

    expect(res.ok).toBe(false);
    expect(res.rolledBack).toBe(true);
    // release CODE reverted to c1 (v1) — the bad deploy did not stick
    expect(await revParse(release, 'HEAD')).toBe(c1);
    expect(readFileSync(join(release, 'SENTINEL'), 'utf8')).toBe('v1');
    expect(calls).toContain('restoreSnapshot'); // migration staged → DB restore attempted
  });
});
