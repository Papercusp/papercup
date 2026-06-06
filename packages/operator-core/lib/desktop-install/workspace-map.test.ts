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
});
