/**
 * The drill target resolver (plan physical-drill-iteration-speed-2026-09-29 D-003, D-005).
 *
 * Falsifiers: a physical run can be pointed at another pot/repo through the environment; a
 * same-box run silently falls back to the physical canary (it would then touch the live
 * canary's identity); a same-box run can sign or finalize release evidence.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
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
};

afterEach(() => vi.unstubAllEnvs());

describe('physicalDrillTarget', () => {
  it('is the fixed canary on the physical rig', () => {
    expect(physicalDrillTarget({})).toEqual({
      potHome: PHASE_A_POT_HOME,
      repoKey: PHASE_A_REPO_KEY,
      githubRemote: PHASE_A_GITHUB_REMOTE,
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
      diagnostic: true,
    });
  });

  it('never falls back to the canary when the same-box target is missing or malformed', () => {
    expect(() => physicalDrillTarget({ HIVE_GIT_RIG: 'same-box' })).toThrow(/incomplete or malformed/);
    expect(() => physicalDrillTarget({ ...SAME_BOX, HIVE_GIT_DRILL_TARGET_REPO_KEY: '../x' })).toThrow(/malformed/);
    expect(() => physicalDrillTarget({ ...SAME_BOX, HIVE_GIT_DRILL_TARGET_POT_HOME: PHASE_A_POT_HOME })).toThrow(
      /must not reuse the physical canary/,
    );
  });

  it('routes the git-sync install slug through the same target', () => {
    expect(physicalDrillGitSyncSlug('vm')).toBe(PHASE_A_POT_HOME);
    for (const [k, v] of Object.entries(SAME_BOX)) vi.stubEnv(k, v);
    expect(physicalDrillGitSyncSlug('tower')).toBe('hello-world-pot');
    expect(physicalDrillGitSyncSlug('vm')).toBe('hello-world-pot');
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
});
