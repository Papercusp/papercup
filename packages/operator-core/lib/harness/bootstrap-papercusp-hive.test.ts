import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  bootstrapPapercuspHive,
  startBootstrapPapercuspHive,
  __resetBootstrapInFlight,
  PAPERCUP_DOGFOOD_REPO_URL,
  type BootstrapPapercuspHiveDeps,
} from './bootstrap-papercusp-hive';

beforeEach(() => __resetBootstrapInFlight());
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
    adoptShare: vi.fn(async () => null),
    goShare: vi.fn(async () => undefined),
    shareExisting: vi.fn(async () => undefined),
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
    expect(deps.shareExisting).toHaveBeenCalledOnce();
  });

  it('uses a LOCAL checkout in place — never clones (dev box)', async () => {
    const deps = spyDeps({ detectRoot: vi.fn(() => '/home/dev/papercup') });
    const res = await bootstrapPapercuspHive(deps);
    expect(deps.clone).not.toHaveBeenCalled();
    expect(deps.ensureHive).toHaveBeenCalledWith({ pathOverride: '/home/dev/papercup' });
    expect(deps.initSubmodules).not.toHaveBeenCalled(); // not a fresh clone
    expect(deps.setHomeWorkspace).toHaveBeenCalledWith(PAPERCUSP_WORKSPACE_ID);
    expect(deps.adoptShare).toHaveBeenCalledOnce();
    expect(deps.goShare).toHaveBeenCalledWith(null);
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
    const arg = (deps.ensureHive as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0] as {
      pathOverride?: string;
    };
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

  it('records the clone + submodules progress sequence for a fresh clone', async () => {
    const events: string[] = [];
    const deps = spyDeps({
      recordProgress: vi.fn((step, status, extra) =>
        events.push(`${step}:${status}${extra?.percent != null ? `@${extra.percent}` : ''}`),
      ),
      // Drive the submodule callbacks synchronously so we can assert recording.
      initSubmodules: vi.fn((_root, opts) => {
        opts?.onProgress?.(1, 4);
        opts?.onDone?.(true);
      }),
    });
    await bootstrapPapercuspHive(deps);
    expect(events).toContain('clone:running@0');
    expect(events).toContain('clone:done');
    expect(events).toContain('submodules:running@0');
    expect(events).toContain('submodules:running@25'); // 1/4 submodules
    expect(events).toContain('submodules:done');
  });

  it('records clone:done + submodules:skipped for a LOCAL checkout (no download)', async () => {
    const events: string[] = [];
    const deps = spyDeps({
      detectRoot: vi.fn(() => '/home/dev/papercup'),
      recordProgress: vi.fn((step, status) => events.push(`${step}:${status}`)),
    });
    await bootstrapPapercuspHive(deps);
    expect(events).toContain('clone:done');
    expect(events).toContain('submodules:skipped');
    expect(deps.initSubmodules).not.toHaveBeenCalled();
  });

  it('records clone:error and skips the submodule phase on a real clone failure', async () => {
    const events: string[] = [];
    const deps = spyDeps({
      clone: vi.fn(async () => ({ code: 'not_found' as const, message: 'nope' })),
      recordProgress: vi.fn((step, status) => events.push(`${step}:${status}`)),
    });
    const res = await bootstrapPapercuspHive(deps);
    expect(res.state).toBe('skipped');
    expect(events).toContain('clone:error');
    expect(events).not.toContain('submodules:running');
  });

  it('parks clone at 0% running (NOT error) with the sign-in prompt on auth_required', async () => {
    const rows: Array<{ step: string; status: string; extra?: { percent?: number; detail?: string } }> = [];
    const deps = spyDeps({
      clone: vi.fn(async () => ({ code: 'auth_required' as const, message: 'Authentication failed' })),
      recordProgress: vi.fn((step, status, extra) => rows.push({ step, status, extra })),
    });
    const res = await bootstrapPapercuspHive(deps);
    expect(res.state).toBe('skipped');
    expect(res.reason).toMatch(/auth_required/);
    // NOT an error — a 0% running clone row carrying the sign-in prompt.
    expect(rows.some((r) => r.step === 'clone' && r.status === 'error')).toBe(false);
    const pending = rows.find(
      (r) => r.step === 'clone' && r.status === 'running' && /sign in to github/i.test(r.extra?.detail ?? ''),
    );
    expect(pending).toBeDefined();
    expect(pending!.extra?.percent).toBe(0);
    expect(rows.some((r) => r.step === 'submodules')).toBe(false);
  });

  it('pins the clone to PAPERCUP_DOGFOOD_REPO_REF (release pin) and is shallow by default', async () => {
    const prev = process.env.PAPERCUP_DOGFOOD_REPO_REF;
    process.env.PAPERCUP_DOGFOOD_REPO_REF = 'desktop-v0.0.2';
    try {
      const deps = spyDeps();
      await bootstrapPapercuspHive(deps);
      expect(deps.clone).toHaveBeenCalledWith(
        PAPERCUP_DOGFOOD_REPO_URL,
        expect.objectContaining({ ref: 'desktop-v0.0.2', shallow: true }),
      );
    } finally {
      if (prev === undefined) delete process.env.PAPERCUP_DOGFOOD_REPO_REF;
      else process.env.PAPERCUP_DOGFOOD_REPO_REF = prev;
    }
  });

  it('omits ref when no pin is baked (dev) — default branch, still shallow', async () => {
    const prev = process.env.PAPERCUP_DOGFOOD_REPO_REF;
    delete process.env.PAPERCUP_DOGFOOD_REPO_REF;
    try {
      const deps = spyDeps();
      await bootstrapPapercuspHive(deps);
      const opts = (deps.clone as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][1] as {
        ref?: string;
        shallow?: boolean;
      };
      expect(opts.ref).toBeUndefined();
      expect(opts.shallow).toBe(true);
    } finally {
      if (prev !== undefined) process.env.PAPERCUP_DOGFOOD_REPO_REF = prev;
    }
  });
});

describe('startBootstrapPapercuspHive (single-flight)', () => {
  it('shares ONE run + the SAME progressId across concurrent triggers', async () => {
    let cloneCount = 0;
    const deps = spyDeps({
      clone: vi.fn(async () => {
        cloneCount += 1;
        return { path: '/clones/papercusp', parsed: { owner: 'Papercusp', repo: 'papercup', cloneUrl: 'x' } };
      }),
      initSubmodules: vi.fn(),
    });
    const a = startBootstrapPapercuspHive(deps);
    const b = startBootstrapPapercuspHive(deps);
    expect(a.progressId).toBe(b.progressId);
    expect(a.done).toBe(b.done); // same promise — not two clones
    await a.done;
    expect(cloneCount).toBe(1);
  });

  it('releases the latch on a skipped result so a later trigger retries', async () => {
    const failing = spyDeps({ clone: vi.fn(async () => ({ code: 'auth_required' as const, message: 'x' })) });
    const first = await startBootstrapPapercuspHive(failing).done;
    expect(first.state).toBe('skipped'); // gh not signed in yet

    // After gh auth, a second trigger actually clones (latch was released).
    const ok = spyDeps({ initSubmodules: vi.fn() });
    const second = await startBootstrapPapercuspHive(ok).done;
    expect(second.state).toBe('cloned-and-created');
    expect(ok.clone).toHaveBeenCalledTimes(1);
  });
});
