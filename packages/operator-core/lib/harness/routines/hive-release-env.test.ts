/**
 * hive-release-env — per-hive release-gate resolution (per-hive-git-and-release-gate P-006).
 *
 * resolveHiveReleaseGate runs against the REAL built-in blueprints (coding/work); the
 * registry + operator-home slug are mocked for resolveHiveReleaseEnv. No PG, no network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

let registryProjects: Array<{ slug: string; path: string; self_repo?: boolean }>;
let homeSlug: string;
let tmpDirs: string[];

function makeHiveDir(extendsId: string, opts: { git?: boolean; extraKnobs?: string } = {}): string {
  const d = mkdtempSync(join(tmpdir(), 'hre-'));
  tmpDirs.push(d);
  mkdirSync(join(d, '.papercusp'), { recursive: true });
  const knobs = opts.extraKnobs ? `\nknobs:\n${opts.extraKnobs}` : '';
  writeFileSync(join(d, '.papercusp', 'blueprint.yaml'), `id: t\nextends: ${extendsId}${knobs}\n`);
  if (opts.git) mkdirSync(join(d, '.git'), { recursive: true });
  return d;
}

beforeEach(() => {
  vi.resetModules();
  registryProjects = [];
  homeSlug = 'papercusp';
  tmpDirs = [];
  vi.doMock('../../harness-registry', () => ({
    loadHarnessRegistry: async () => ({ projects: registryProjects }),
  }));
  vi.doMock('../operator-home-harness', () => ({
    operatorHomeHarnessSlug: () => homeSlug,
  }));
});
afterEach(() => {
  vi.doUnmock('../../harness-registry');
  vi.doUnmock('../operator-home-harness');
  for (const d of tmpDirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

describe('resolveHiveReleaseGate', () => {
  it('coding → enabled with staging/main defaults', async () => {
    const { resolveHiveReleaseGate } = await import('./hive-release-env');
    const gate = resolveHiveReleaseGate(makeHiveDir('coding'));
    expect(gate?.enabled).toBe(true);
    expect(gate?.integrationBranch).toBe('staging');
    expect(gate?.releaseRef).toBe('main');
  });

  it('work (non-coding) → gate disabled', async () => {
    const { resolveHiveReleaseGate } = await import('./hive-release-env');
    expect(resolveHiveReleaseGate(makeHiveDir('work'))?.enabled).toBe(false);
  });

  it('no blueprint file → null', async () => {
    const { resolveHiveReleaseGate } = await import('./hive-release-env');
    const empty = mkdtempSync(join(tmpdir(), 'hre-empty-'));
    tmpDirs.push(empty);
    expect(resolveHiveReleaseGate(empty)).toBeNull();
  });

  it('surfaces the testCommand knob for greenCmd defaulting', async () => {
    const { resolveHiveReleaseGate } = await import('./hive-release-env');
    const gate = resolveHiveReleaseGate(makeHiveDir('coding', { extraKnobs: '  testCommand: npm run test:ci' }));
    expect(gate?.testCommand).toBe('npm run test:ci');
    expect(gate?.greenCmd).toBeNull(); // explicit greenCmd unset → caller falls back to testCommand
  });
});

describe('resolveHiveReleaseEnv', () => {
  it('not_found when the slug is not in the registry', async () => {
    const { resolveHiveReleaseEnv } = await import('./hive-release-env');
    const res = await resolveHiveReleaseEnv('ghost', 'default');
    expect(res.enabled).toBe(false);
    expect(res.reason).toBe('not_found');
  });

  it('gate_disabled for a non-coding (work) hive', async () => {
    const dir = makeHiveDir('work', { git: true });
    registryProjects = [{ slug: 'workhive', path: dir, self_repo: true }];
    const { resolveHiveReleaseEnv } = await import('./hive-release-env');
    const res = await resolveHiveReleaseEnv('workhive', 'default');
    expect(res.enabled).toBe(false);
    expect(res.reason).toBe('gate_disabled');
  });

  it('no_repo for a coding hive without a .git (or without self_repo)', async () => {
    const noGit = makeHiveDir('coding', { git: false });
    registryProjects = [{ slug: 'c1', path: noGit, self_repo: true }];
    const { resolveHiveReleaseEnv } = await import('./hive-release-env');
    expect((await resolveHiveReleaseEnv('c1', 'default')).reason).toBe('no_repo');

    const withGit = makeHiveDir('coding', { git: true });
    registryProjects = [{ slug: 'c2', path: withGit, self_repo: false }]; // self_repo NOT set
    expect((await resolveHiveReleaseEnv('c2', 'default')).reason).toBe('no_repo');
  });

  it('operator-home slug → enabled with an EMPTY overlay (exact current behavior preserved)', async () => {
    const dir = makeHiveDir('coding', { git: true });
    homeSlug = 'papercusp';
    registryProjects = [{ slug: 'papercusp', path: dir, self_repo: true }];
    const { resolveHiveReleaseEnv } = await import('./hive-release-env');
    const res = await resolveHiveReleaseEnv('papercusp', 'default');
    expect(res.enabled).toBe(true);
    expect(res.isOperatorHome).toBe(true);
    expect(res.env).toEqual({}); // no overlay → systemd-unit env + releaseConfig defaults
  });

  it('a regular coding hive → namespaced per-hive env overlay (build fallback greenCmd)', async () => {
    const dir = makeHiveDir('coding', { git: true });
    homeSlug = 'papercusp'; // dir slug differs → not the home
    registryProjects = [{ slug: 'oddsmith-hive', path: dir, self_repo: true }];
    const { resolveHiveReleaseEnv, DEFAULT_GREEN_CMD } = await import('./hive-release-env');
    const res = await resolveHiveReleaseEnv('oddsmith-hive', 'default');
    expect(res.enabled).toBe(true);
    expect(res.isOperatorHome).toBe(false);
    expect(res.env.PAPERCUSP_INTEGRATION_ROOT).toBe(dir);
    expect(res.env.PAPERCUSP_RELEASE_SLUG).toBe('oddsmith-hive');
    expect(res.env.PAPERCUSP_INTEGRATION_BRANCH).toBe('staging');
    expect(res.env.PAPERCUSP_RELEASE_REF).toBe('main');
    expect(res.env.PAPERCUSP_RELEASE_ROOT).toBe(join(dirname(dir), 'oddsmith-hive-release'));
    expect(res.env.PAPERCUSP_CHECKPOINT_ROOT).toBe(join(dirname(dir), 'oddsmith-hive-checkpoint'));
    expect(res.env.PAPERCUSP_GREEN_CMD).toBe(DEFAULT_GREEN_CMD); // coding greenCmd null + no testCommand
  });

  it('greenCmd defaults to the testCommand knob when set (the gate runs the SAME test command)', async () => {
    const dir = makeHiveDir('coding', { git: true, extraKnobs: '  testCommand: npm run test:affected' });
    registryProjects = [{ slug: 'mycode', path: dir, self_repo: true }];
    const { resolveHiveReleaseEnv } = await import('./hive-release-env');
    const res = await resolveHiveReleaseEnv('mycode', 'default');
    expect(res.env.PAPERCUSP_GREEN_CMD).toBe('npm run test:affected');
  });
});
