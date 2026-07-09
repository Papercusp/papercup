/**
 * workspace-map.test.ts — the generated "Where to work" playbook section
 * (staging-branch-pipeline-2026-06-06). The CONTENT is config-derived, so the
 * tests pin the contract: paths/branches come from the (injectable) config,
 * env seams override, and the section carries the three load-bearing rules
 * (work in the integration tree; never touch the release/checkpoint trees;
 * the green pin is automation-only).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWorkspaceMapSection, resolveWorkspaceMapConfig } from './workspace-map';

// EI-8794: the fallback-detection tests below stub `execFileSync` itself (rather
// than relying on the real `git` binary), so the "detection failed" path is
// deterministic regardless of what git checkout the test happens to run inside.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFileSync: vi.fn(actual.execFileSync) };
});
import { execFileSync } from 'node:child_process';

const CFG = {
  integrationRoot: '/work/papercup',
  releaseRoot: '/work/papercup-release',
  checkpointRoot: '/work/papercup-checkpoint',
  integrationBranch: 'staging',
  releaseRef: 'main',
};

describe('renderWorkspaceMapSection', () => {
  it('renders the canonical tree + branch and the two do-not-touch artifact trees', () => {
    const s = renderWorkspaceMapSection(CFG);
    expect(s).toContain('Where to work');
    expect(s).toContain('✅ `/work/papercup`');
    expect(s).toContain('branch `staging`');
    expect(s).toContain('origin/staging');
    expect(s).toContain('🚫 `/work/papercup-release`');
    expect(s).toContain('🚫 `/work/papercup-checkpoint`');
  });

  it('states the green pin is automation-only and includes the self-check', () => {
    const s = renderWorkspaceMapSection(CFG);
    expect(s).toContain('`main` is automation-only');
    expect(s).toContain('green-checkpoint fast-forwards it');
    expect(s).toContain('git branch --show-current');
  });

  it('follows the config, not hardcoded names (the whole point — branches changed once already)', () => {
    const s = renderWorkspaceMapSection({
      ...CFG,
      integrationBranch: 'firehose',
      releaseRef: 'golden',
    });
    expect(s).toContain('branch `firehose`');
    expect(s).toContain('`golden` is automation-only');
    expect(s).not.toContain('branch `staging`');
  });

  it('EI-8794: does NOT claim the canonical-tree ✅ when gitDetected is false', () => {
    const s = renderWorkspaceMapSection({ ...CFG, gitDetected: false });
    expect(s).not.toContain('✅');
    expect(s).not.toContain('ALL repo work happens here');
    expect(s).toContain('⚠️');
    expect(s).toContain('NOT a git checkout');
    expect(s).toContain('/work/papercup');
    // The other trees' warnings are unaffected.
    expect(s).toContain('🚫 `/work/papercup-release`');
    expect(s).toContain('🚫 `/work/papercup-checkpoint`');
  });

  it('renders the canonical ✅ claim when gitDetected is omitted or true (unaffected by the EI-8794 guard)', () => {
    expect(renderWorkspaceMapSection(CFG)).toContain('✅ `/work/papercup`');
    expect(renderWorkspaceMapSection({ ...CFG, gitDetected: true })).toContain('✅ `/work/papercup`');
  });
});

describe('resolveWorkspaceMapConfig', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('honours the release-gate env seams', () => {
    vi.stubEnv('PAPERCUSP_INTEGRATION_ROOT', '/x/integ');
    vi.stubEnv('PAPERCUSP_RELEASE_ROOT', '/x/rel');
    vi.stubEnv('PAPERCUSP_CHECKPOINT_ROOT', '/x/chk');
    vi.stubEnv('PAPERCUSP_INTEGRATION_BRANCH', 'staging');
    vi.stubEnv('PAPERCUSP_RELEASE_REF', 'main');
    expect(resolveWorkspaceMapConfig()).toEqual({
      integrationRoot: '/x/integ',
      releaseRoot: '/x/rel',
      checkpointRoot: '/x/chk',
      integrationBranch: 'staging',
      releaseRef: 'main',
    });
  });

  it('derives sibling defaults from the integration root', () => {
    vi.stubEnv('PAPERCUSP_INTEGRATION_ROOT', '/srv/papercup');
    const cfg = resolveWorkspaceMapConfig();
    expect(cfg.releaseRoot).toBe('/srv/papercup-release');
    expect(cfg.checkpointRoot).toBe('/srv/papercup-checkpoint');
    expect(cfg.integrationBranch).toBe('staging'); // code default mirrors release-config.ts
    expect(cfg.releaseRef).toBe('main');
  });

  it('checkpoint default is per-root (<basename>-checkpoint), matching release-config.ts', () => {
    // releaseRoot keeps the legacy fixed name; checkpointRoot must NOT — the 2026-07-02
    // cross-lineage race fix namespaces it by the integration root's basename.
    vi.stubEnv('PAPERCUSP_INTEGRATION_ROOT', '/srv/papercusp');
    const cfg = resolveWorkspaceMapConfig();
    expect(cfg.releaseRoot).toBe('/srv/papercup-release');
    expect(cfg.checkpointRoot).toBe('/srv/papercusp-checkpoint');
  });

  it('EI-8794: suppresses git stderr (stdio-suppressed) via the execFileSync call', () => {
    vi.stubEnv('PAPERCUSP_INTEGRATION_ROOT', '');
    (vi.mocked(execFileSync) as unknown as { mockReturnValueOnce: (v: string) => void }).mockReturnValueOnce(
      '/repo/toplevel\n',
    );
    resolveWorkspaceMapConfig();
    expect(vi.mocked(execFileSync)).toHaveBeenCalledWith(
      'git',
      ['rev-parse', '--show-toplevel'],
      expect.objectContaining({ stdio: ['ignore', 'pipe', 'ignore'] }),
    );
  });

  it('EI-8794: falls back to cwd + gitDetected:false when git rev-parse fails (not a git checkout)', () => {
    vi.stubEnv('PAPERCUSP_INTEGRATION_ROOT', '');
    vi.mocked(execFileSync).mockImplementationOnce(() => {
      throw new Error('fatal: not a git repository (or any of the parent directories): .git');
    });
    const cfg = resolveWorkspaceMapConfig();
    expect(cfg.integrationRoot).toBe(process.cwd());
    expect(cfg.gitDetected).toBe(false);
  });

  it('EI-8794: gitDetected is omitted (not false) when git rev-parse succeeds', () => {
    vi.stubEnv('PAPERCUSP_INTEGRATION_ROOT', '');
    (vi.mocked(execFileSync) as unknown as { mockReturnValueOnce: (v: string) => void }).mockReturnValueOnce(
      '/repo/toplevel\n',
    );
    const cfg = resolveWorkspaceMapConfig();
    expect(cfg.integrationRoot).toBe('/repo/toplevel');
    expect(cfg.gitDetected).not.toBe(false);
  });
});
