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

// Generous timeout: resolveHiveReleaseGate cold-starts the built-in blueprint resolver
// (reads + resolves the blueprint tree from disk, ~5s on first call), which tips past the
// 5s default under heavy PARALLEL load (the full-suite green-checkpoint run) → a spurious
// timeout. Roomy budget kills that load-flake class (the "generous timeouts on import-heavy
// tests" convention from the green-checkpoint bring-up).
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

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

  it('a coding MEMBER blueprint (coding-factory — no explicit releaseGate) gates by default (P-017 derived)', async () => {
    const { resolveHiveReleaseGate } = await import('./hive-release-env');
    // coding-factory carries no releaseGate knob but IS a code repo (requiresRepo, repo-commit
    // output) — the derived rule enables it; the member is what create_from_repo clones run.
    expect(resolveHiveReleaseGate(makeHiveDir('coding-factory'))?.enabled).toBe(true);
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

  it('no_repo only when the checkout has no .git (a metadata-only home)', async () => {
    const noGit = makeHiveDir('coding', { git: false });
    registryProjects = [{ slug: 'c1', path: noGit, self_repo: true }];
    const { resolveHiveReleaseEnv } = await import('./hive-release-env');
    expect((await resolveHiveReleaseEnv('c1', 'default')).reason).toBe('no_repo');
  });

  it('a code MEMBER (has .git, self_repo NOT set) IS gated — P-017 code-in-member', async () => {
    const withGit = makeHiveDir('coding', { git: true });
    registryProjects = [{ slug: 'c2', path: withGit, self_repo: false }]; // a member, not a self_repo home
    const { resolveHiveReleaseEnv } = await import('./hive-release-env');
    const res = await resolveHiveReleaseEnv('c2', 'default');
    expect(res.enabled).toBe(true);
    expect(res.env.PAPERCUSP_INTEGRATION_ROOT).toBe(withGit);
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

describe('resolveCheckpointRouting', () => {
  it('no installSlug → default root, empty overlay, no skip (current behavior)', async () => {
    const { resolveCheckpointRouting } = await import('./hive-release-env');
    const r = await resolveCheckpointRouting({ workspaceId: 'default' }, '/DEFAULT');
    expect(r.root).toBe('/DEFAULT');
    expect(r.extraEnv).toEqual({});
    expect(r.skip).toBeUndefined();
  });

  it('operator-home slug → default root + empty overlay (exact current behavior preserved)', async () => {
    homeSlug = 'papercusp';
    const { resolveCheckpointRouting } = await import('./hive-release-env');
    const r = await resolveCheckpointRouting({ installSlug: 'papercusp', workspaceId: 'default' }, '/DEFAULT');
    expect(r.root).toBe('/DEFAULT');
    expect(r.extraEnv).toEqual({});
    expect(r.skip).toBeUndefined();
  });

  it('gated coding hive → per-hive root + env overlay', async () => {
    const dir = makeHiveDir('coding', { git: true });
    registryProjects = [{ slug: 'oddsmith-hive', path: dir, self_repo: true }];
    const { resolveCheckpointRouting } = await import('./hive-release-env');
    const r = await resolveCheckpointRouting({ installSlug: 'oddsmith-hive', workspaceId: 'default' }, '/DEFAULT');
    expect(r.root).toBe(dir);
    expect(r.extraEnv.PAPERCUSP_INTEGRATION_ROOT).toBe(dir);
    expect(r.skip).toBeUndefined();
  });

  it('non-gated slug (work hive) → skip with reason, default root, no suite', async () => {
    const dir = makeHiveDir('work', { git: true });
    registryProjects = [{ slug: 'workhive', path: dir, self_repo: true }];
    const { resolveCheckpointRouting } = await import('./hive-release-env');
    const r = await resolveCheckpointRouting({ installSlug: 'workhive', workspaceId: 'default' }, '/DEFAULT');
    expect(r.skip?.reason).toBe('gate_disabled');
    expect(r.root).toBe('/DEFAULT');
    expect(r.extraEnv).toEqual({});
  });
});
