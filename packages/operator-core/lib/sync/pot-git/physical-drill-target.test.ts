/**
 * The drill target resolver (plan physical-drill-iteration-speed-2026-09-29 D-003, D-005).
 *
 * Falsifiers: a physical run can be pointed at another pot/repo through the environment; a
 * same-box run silently falls back to the physical canary (it would then touch the live
 * canary's identity); a same-box run can sign or finalize release evidence.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PHASE_A_POT_HOME,
  PHASE_A_REPO_KEY,
  PHASE_A_GITHUB_REMOTE,
  physicalDrillGitSyncSlug,
  physicalDrillTarget,
} from './physical-drill-phase-a';
import { refuseDiagnosticEvidence } from './physical-drill-producer';

const SAME_BOX = {
  HIVE_GIT_RIG: 'same-box',
  HIVE_GIT_DRILL_TARGET_POT_HOME: 'hello-world-pot',
  HIVE_GIT_DRILL_TARGET_REPO_KEY: 'gh-1296269',
  HIVE_GIT_DRILL_TARGET_GITHUB_REMOTE: 'https://github.com/octocat/Hello-World',
  HIVE_GIT_DRILL_TARGET_GIT_SYNC_SLUG: 'hello-world',
};

afterEach(() => vi.unstubAllEnvs());

describe('physicalDrillTarget', () => {
  it('is the fixed canary on the physical rig', () => {
    expect(physicalDrillTarget({})).toEqual({
      potHome: PHASE_A_POT_HOME,
      repoKey: PHASE_A_REPO_KEY,
      githubRemote: PHASE_A_GITHUB_REMOTE,
      gitSyncSlug: PHASE_A_POT_HOME,
      diagnostic: false,
    });
  });

  it('refuses an environment-supplied target without the same-box profile', () => {
    const { HIVE_GIT_RIG: _rig, ...targetOnly } = SAME_BOX;
    expect(() => physicalDrillTarget(targetOnly)).toThrow(/cannot come from the environment on the physical rig/);
    expect(() => physicalDrillTarget({ ...targetOnly, HIVE_GIT_RIG: 'physical' })).toThrow(/physical rig/);
  });

  it('takes the rig-profile target under the same-box profile and marks it diagnostic', () => {
    expect(physicalDrillTarget(SAME_BOX)).toEqual({
      potHome: 'hello-world-pot',
      repoKey: 'gh-1296269',
      githubRemote: 'https://github.com/octocat/Hello-World',
      gitSyncSlug: 'hello-world',
      diagnostic: true,
    });
  });

  it('never falls back to the canary when the same-box target is missing or malformed', () => {
    expect(() => physicalDrillTarget({ HIVE_GIT_RIG: 'same-box' })).toThrow(/incomplete or malformed/);
    expect(() => physicalDrillTarget({ ...SAME_BOX, HIVE_GIT_DRILL_TARGET_REPO_KEY: '../x' })).toThrow(/malformed/);
    const { HIVE_GIT_DRILL_TARGET_GIT_SYNC_SLUG: _slug, ...noGitSync } = SAME_BOX;
    expect(() => physicalDrillTarget(noGitSync)).toThrow(/incomplete or malformed/);
    expect(() => physicalDrillTarget({ ...SAME_BOX, HIVE_GIT_DRILL_TARGET_POT_HOME: PHASE_A_POT_HOME })).toThrow(
      /must not reuse the physical canary/,
    );
    expect(() => physicalDrillTarget({ ...SAME_BOX, HIVE_GIT_DRILL_TARGET_GIT_SYNC_SLUG: PHASE_A_POT_HOME })).toThrow(
      /must not reuse the physical canary/,
    );
  });

  it('routes the git-sync install slug through the same target', () => {
    expect(physicalDrillGitSyncSlug('vm')).toBe(PHASE_A_POT_HOME);
    expect(physicalDrillGitSyncSlug('tower')).toBe(PHASE_A_POT_HOME);
    for (const [k, v] of Object.entries(SAME_BOX)) vi.stubEnv(k, v);
    // A create-from-repo pot: git-sync belongs to the member checkout, not the pot home.
    expect(physicalDrillGitSyncSlug('tower')).toBe('hello-world');
    expect(physicalDrillGitSyncSlug('vm')).toBe('hello-world');
  });
});

describe('a diagnostic target can never become release evidence', () => {
  it('refuses sign and finalize under the same-box profile', () => {
    expect(() => refuseDiagnosticEvidence('sign')).not.toThrow();
    for (const [k, v] of Object.entries(SAME_BOX)) vi.stubEnv(k, v);
    expect(() => refuseDiagnosticEvidence('sign')).toThrow(/sign refused .* diagnostic/);
    expect(() => refuseDiagnosticEvidence('finalize')).toThrow(/finalize refused .* diagnostic/);
  });

  it('the producer CLI refuses sign before touching its arguments', () => {
    const here = fileURLToPath(new URL('.', import.meta.url));
    const repo = resolve(here, '../../../../..');
    const tsx = join(repo, 'node_modules/tsx/dist/cli.mjs');
    const scratch = mkdtempSync(join(tmpdir(), 'drill-target-'));
    try {
      const res = spawnSync(
        process.execPath,
        [tsx, join(here, 'physical-drill-producer.ts'), 'sign', join(scratch, 'evidence.json'), 'tower', join(scratch, 'cache.json')],
        { env: { ...process.env, ...SAME_BOX }, encoding: 'utf8', timeout: 60_000 },
      );
      expect(res.status).toBe(1);
      expect(res.stderr).toMatch(/sign refused .* diagnostic/);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 90_000);

  // Found live (same-box run 20260930T044642Z): both owners share ONE machine, so the CLI
  // preflight must take the target's diagnostic flag — the unit relaxation alone was not
  // wired, and the physical rig must still demand two machines through the same CLI.
  it('the producer CLI preflight accepts one shared machine only under the same-box profile', () => {
    const here = fileURLToPath(new URL('.', import.meta.url));
    const repo = resolve(here, '../../../../..');
    const tsx = join(repo, 'node_modules/tsx/dist/cli.mjs');
    const scratch = mkdtempSync(join(tmpdir(), 'drill-target-'));
    const identity = (hostId: string, deviceKey: string) => JSON.stringify({
      schemaVersion: 'hive-git-physical-host-identity/v1',
      hostId,
      deviceKey,
      keychainId: `4242:${hostId}`,
      githubUserId: 4242,
      githubLogin: `${hostId}-owner`,
      machineFingerprint: 'b'.repeat(64),
    });
    const physicalEnv: NodeJS.ProcessEnv = { ...process.env };
    for (const key of Object.keys(SAME_BOX)) delete physicalEnv[key];
    try {
      const tower = join(scratch, 'tower.json');
      const vm = join(scratch, 'vm.json');
      writeFileSync(tower, identity('tower', 'dG93ZXI='));
      writeFileSync(vm, identity('vm', 'dm0='));
      const run = (env: NodeJS.ProcessEnv) => spawnSync(
        process.execPath,
        [tsx, join(here, 'physical-drill-producer.ts'), 'preflight', tower, vm],
        { env, encoding: 'utf8', timeout: 60_000 },
      );
      const sameBox = run({ ...physicalEnv, ...SAME_BOX });
      expect(sameBox.error).toBeUndefined();
      expect(sameBox.stderr).not.toMatch(/distinct/);
      expect(sameBox.status).toBe(0);
      const physical = run(physicalEnv);
      expect(physical.error).toBeUndefined();
      expect(physical.status).toBe(1);
      expect(physical.stderr).toMatch(/distinct machineFingerprint values/);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 120_000);
});
