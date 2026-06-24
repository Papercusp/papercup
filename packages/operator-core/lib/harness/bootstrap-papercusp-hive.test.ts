import { describe, it, expect, vi } from 'vitest';
import {
  bootstrapPapercuspHive,
  PAPERCUP_DOGFOOD_REPO_URL,
  type BootstrapPapercuspHiveDeps,
} from './bootstrap-papercusp-hive';
import { PAPERCUSP_HIVE_SLUG } from './ensure-papercusp-hive';
import { PAPERCUSP_WORKSPACE_ID } from './papercusp-workspace';

/** Build a deps object whose seams are all spies, overridable per-case. */
function spyDeps(over: Partial<BootstrapPapercuspHiveDeps> = {}) {
  const deps = {
    detectRoot: vi.fn(() => null as string | null),
    loadRegistry: vi.fn(async () => ({ projects: [] as Array<{ slug: string }> })),
    clone: vi.fn(async () => ({
      path: '/clones/papercusp',
      parsed: { owner: 'Papercusp', repo: 'papercup', cloneUrl: 'https://github.com/Papercusp/papercup.git' },
    })),
    ensureHive: vi.fn(async (_opts?: { pathOverride?: string }) => ({
      state: 'newly-created' as const,
      slug: PAPERCUSP_HIVE_SLUG,
    })),
    setHomeWorkspace: vi.fn(),
    initSubmodules: vi.fn(),
    recordProgress: vi.fn(),
    ...over,
  };
  return deps as unknown as BootstrapPapercuspHiveDeps & typeof deps;
}

describe('bootstrapPapercuspHive — clone-on-first-boot dogfood hive', () => {
  it('no-ops + homes when the papercusp hive already exists (idempotent)', async () => {
    const deps = spyDeps({ loadRegistry: vi.fn(async () => ({ projects: [{ slug: PAPERCUSP_HIVE_SLUG }] })) });
    const res = await bootstrapPapercuspHive(deps);
    expect(res.state).toBe('already-present');
    expect(deps.clone).not.toHaveBeenCalled();
    expect(deps.ensureHive).not.toHaveBeenCalled();
    expect(deps.setHomeWorkspace).toHaveBeenCalledWith(PAPERCUSP_WORKSPACE_ID);
  });

  it('uses a LOCAL checkout in place — never clones (dev box)', async () => {
    const deps = spyDeps({ detectRoot: vi.fn(() => '/home/dev/papercup') });
    const res = await bootstrapPapercuspHive(deps);
    expect(deps.clone).not.toHaveBeenCalled();
    expect(deps.ensureHive).toHaveBeenCalledWith({ pathOverride: '/home/dev/papercup' });
    expect(deps.initSubmodules).not.toHaveBeenCalled(); // not a fresh clone
    expect(deps.setHomeWorkspace).toHaveBeenCalledWith(PAPERCUSP_WORKSPACE_ID);
    expect(res.state).toBe('newly-created');
  });

  it('CLONES the dogfood repo on a packaged install, then creates + homes + inits submodules', async () => {
    const deps = spyDeps();
    const res = await bootstrapPapercuspHive(deps);
    expect(deps.clone).toHaveBeenCalledWith(
      PAPERCUP_DOGFOOD_REPO_URL,
      expect.objectContaining({ destName: PAPERCUSP_HIVE_SLUG }),
    );
    expect(deps.ensureHive).toHaveBeenCalledWith({ pathOverride: '/clones/papercusp' });
    expect(deps.setHomeWorkspace).toHaveBeenCalledWith(PAPERCUSP_WORKSPACE_ID);
    expect(deps.initSubmodules).toHaveBeenCalledWith('/clones/papercusp', expect.any(Object));
    expect(res.state).toBe('cloned-and-created');
    expect(res.path).toBe('/clones/papercusp');
  });

  it('no-ops on auth_required (gh not signed in) — leaves home untouched so the next boot retries', async () => {
    const deps = spyDeps({
      clone: vi.fn(async () => ({ code: 'auth_required' as const, message: 'Authentication failed' })),
    });
    const res = await bootstrapPapercuspHive(deps);
    expect(res.state).toBe('skipped');
    expect(res.reason).toMatch(/auth_required/);
    expect(deps.ensureHive).not.toHaveBeenCalled();
    expect(deps.setHomeWorkspace).not.toHaveBeenCalled();
  });

  it('adopts an existing clone dir (dest_exists) instead of refusing', async () => {
    const deps = spyDeps({
      clone: vi.fn(async () => ({ code: 'dest_exists' as const, message: 'already exists' })),
    });
    const res = await bootstrapPapercuspHive(deps);
    expect(res.state).toBe('cloned-and-created');
    const arg = deps.ensureHive.mock.calls[0][0] as { pathOverride?: string };
    expect(arg.pathOverride).toMatch(/\/clones\/papercusp$/);
    expect(deps.setHomeWorkspace).toHaveBeenCalledWith(PAPERCUSP_WORKSPACE_ID);
  });

  it('propagates an ensureHive skip without homing', async () => {
    const deps = spyDeps({
      detectRoot: vi.fn(() => '/repo'),
      ensureHive: vi.fn(async () => ({ state: 'skipped' as const, slug: null, reason: 'create_failed' })),
    });
    const res = await bootstrapPapercuspHive(deps);
    expect(res.state).toBe('skipped');
    expect(res.reason).toBe('create_failed');
    expect(deps.setHomeWorkspace).not.toHaveBeenCalled();
  });
});
