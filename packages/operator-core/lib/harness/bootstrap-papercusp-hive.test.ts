import { describe, it, expect, vi, beforeEach } from 'vitest';

// The canonical invite is now COMMITTED (P-003 activation), so bakedCanonicalHiveInvite()
// returns it by default — which would route every no-`canonicalInvite` test through the
// JOIN path. Mock the constant to null so the legacy clone+create-path tests still exercise
// the per-owner fallback; the P-005/P-006 tests pass `canonicalInvite` explicitly (explicit
// wins over the constant), so they are unaffected.
vi.mock('./canonical-hive-invite', () => ({ CANONICAL_PAPERCUSP_HIVE_INVITE: null, CANONICAL_HIVE_TEAM_ALLOWLIST: [] }));

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
    submodulesNeedUpdate: vi.fn(async () => false),
    ...over,
  };
  return deps as unknown as BootstrapPapercuspHiveDeps & typeof deps;
}

describe('bootstrapPapercuspHive — clone-on-first-boot dogfood hive', () => {
  it('no-ops + homes when the papercusp hive already exists with complete submodules (idempotent)', async () => {
    const deps = spyDeps({
      loadRegistry: vi.fn(async () => ({ projects: [{ slug: PAPERCUSP_HIVE_SLUG, path: '/clones/papercusp' }] })),
    });
    const res = await bootstrapPapercuspHive(deps);
    expect(res.state).toBe('already-present');
    expect(deps.clone).not.toHaveBeenCalled();
    expect(deps.ensureHive).not.toHaveBeenCalled();
    expect(deps.setHomeWorkspace).toHaveBeenCalledWith(PAPERCUSP_WORKSPACE_ID);
    expect(deps.submodulesNeedUpdate).toHaveBeenCalledWith('/clones/papercusp');
    expect(deps.initSubmodules).not.toHaveBeenCalled();
    expect(deps.shareExisting).toHaveBeenCalledOnce();
  });

  it('existing hive with uninitialized submodules resumes the submodule phase', async () => {
    const events: string[] = [];
    const deps = spyDeps({
      loadRegistry: vi.fn(async () => ({ projects: [{ slug: PAPERCUSP_HIVE_SLUG, path: '/clones/papercusp' }] })),
      submodulesNeedUpdate: vi.fn(async () => true),
      recordProgress: vi.fn((step, status, extra) =>
        events.push(`${step}:${status}${extra?.percent != null ? `@${extra.percent}` : ''}`),
      ),
      initSubmodules: vi.fn((_root, opts) => {
        opts?.onProgress?.(3, 27);
        opts?.onDone?.(true);
      }),
    });
    const res = await bootstrapPapercuspHive(deps);
    expect(res.state).toBe('already-present');
    expect(deps.clone).not.toHaveBeenCalled();
    expect(deps.ensureHive).not.toHaveBeenCalled();
    expect(deps.initSubmodules).toHaveBeenCalledWith('/clones/papercusp', expect.any(Object));
    expect(events).toContain('clone:done');
    expect(events).toContain('submodules:running@0');
    expect(events).toContain('submodules:running@11');
    expect(events).toContain('submodules:done');
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

  it('P-005 latch: already joined the canonical hive (hives row keyed on the baked pubkey) → already-present, NO re-join', async () => {
    const joinCanonical = vi.fn(async () => ({ state: 'joined' as const, slug: 'papercusp' }));
    const findJoinedCanonical = vi.fn(async () => ({ slug: 'papercusp' }));
    const deps = spyDeps({
      canonicalInvite: { pubkeyBase64: 'CANON_PUB', inviteSecret: 'sec' },
      findJoinedCanonical,
      joinCanonical,
    });
    const res = await bootstrapPapercuspHive(deps);
    expect(res.state).toBe('already-present');
    expect(res.slug).toBe('papercusp');
    // The expensive ~25s confirm+join is skipped once we've already joined.
    expect(joinCanonical).not.toHaveBeenCalled();
    expect(findJoinedCanonical).toHaveBeenCalledWith('CANON_PUB');
    expect(deps.setHomeWorkspace).toHaveBeenCalledWith(PAPERCUSP_WORKSPACE_ID);
    expect(deps.clone).not.toHaveBeenCalled();
  });

  it('P-006: bootstrap dispatches to the JOIN path on a baked invite (joined → cloned-and-created)', async () => {
    const joinCanonical = vi.fn(async () => ({ state: 'joined' as const, slug: 'papercusp-view' }));
    const findJoinedCanonical = vi.fn(async () => null);
    const deps = spyDeps({
      canonicalInvite: { pubkeyBase64: 'CANON_PUB', inviteSecret: 'sec' },
      findJoinedCanonical,
      joinCanonical,
    });
    const res = await bootstrapPapercuspHive(deps);
    expect(res.state).toBe('cloned-and-created');
    expect(res.slug).toBe('papercusp-view');
    expect(joinCanonical).toHaveBeenCalledOnce();
    expect(deps.clone).not.toHaveBeenCalled(); // JOIN path, never the per-owner clone+create
    expect(deps.ensureHive).not.toHaveBeenCalled();
  });

  it('P-006: a join SKIP propagates as skipped (next-boot retry) — never falls through to clone+create', async () => {
    const joinCanonical = vi.fn(async () => ({
      state: 'skipped' as const,
      slug: null,
      reason: 'canonical hive not announcing yet (owner offline)',
    }));
    const findJoinedCanonical = vi.fn(async () => null);
    const deps = spyDeps({
      canonicalInvite: { pubkeyBase64: 'CANON_PUB', inviteSecret: 'sec' },
      findJoinedCanonical,
      joinCanonical,
    });
    const res = await bootstrapPapercuspHive(deps);
    expect(res.state).toBe('skipped');
    expect(res.reason).toMatch(/not announcing yet/);
    expect(joinCanonical).toHaveBeenCalledOnce();
    expect(deps.ensureHive).not.toHaveBeenCalled();
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
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const events: string[] = [];
    const deps = spyDeps({
      clone: vi.fn(async () => ({ code: 'not_found' as const, message: 'nope' })),
      recordProgress: vi.fn((step, status) => events.push(`${step}:${status}`)),
    });
    const res = await bootstrapPapercuspHive(deps);
    expect(res.state).toBe('skipped');
    expect(events).toContain('clone:error');
    expect(events).not.toContain('submodules:running');
    // The real failure (code + message) is logged for diagnosis (EI / Mac-VM debugging).
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/clone failed: not_found/));
    warn.mockRestore();
  });

  it('records clone:error with detail network_timeout + releases (skipped) on a transient connect timeout (EI-3548)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const rows: Array<{ step: string; status: string; extra?: { detail?: string } }> = [];
    const deps = spyDeps({
      clone: vi.fn(async () => ({ code: 'network_timeout' as const, message: 'Connection timed out' })),
      recordProgress: vi.fn((step, status, extra) => rows.push({ step, status, extra })),
    });
    const res = await bootstrapPapercuspHive(deps);
    warn.mockRestore();
    // Skipped state → startBootstrap releases the single-flight latch so a retry re-runs.
    expect(res.state).toBe('skipped');
    expect(res.reason).toMatch(/network_timeout/);
    // The error row carries the network_timeout detail the UI keys off to auto-retry.
    const err = rows.find((r) => r.step === 'clone' && r.status === 'error');
    expect(err?.extra?.detail).toBe('network_timeout');
    expect(rows.some((r) => r.step === 'submodules')).toBe(false);
  });

  it('EI-3548: a throwing best-effort share (already-present path) does NOT fail setup', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const deps = spyDeps({
      loadRegistry: vi.fn(async () => ({ projects: [{ slug: PAPERCUSP_HIVE_SLUG, path: '/clones/papercusp' }] })),
      shareExisting: vi.fn(async () => {
        throw new Error('Connect Timeout Error (api.github.com:443)');
      }),
    });
    const res = await bootstrapPapercuspHive(deps);
    expect(res.state).toBe('already-present');
    expect(deps.setHomeWorkspace).toHaveBeenCalledWith(PAPERCUSP_WORKSPACE_ID);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/shareExisting failed \(non-fatal\)/));
    warn.mockRestore();
  });

  it('EI-3548: a throwing adoptShare/goShare (create path) does NOT fail the clone+create', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const deps = spyDeps({
      adoptShare: vi.fn(async () => {
        throw new Error('Connect Timeout Error (api.github.com:443)');
      }),
      goShare: vi.fn(async () => {
        throw new Error('Connect Timeout Error (api.github.com:443)');
      }),
    });
    const res = await bootstrapPapercuspHive(deps);
    expect(res.state).toBe('cloned-and-created');
    expect(deps.ensureHive).toHaveBeenCalledOnce();
    expect(deps.setHomeWorkspace).toHaveBeenCalledWith(PAPERCUSP_WORKSPACE_ID);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/adoptShare failed/));
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/goShare failed \(non-fatal\)/));
    warn.mockRestore();
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

  it('releases the latch when the background submodule phase fails so Retry can run again', async () => {
    const failing = spyDeps({
      loadRegistry: vi.fn(async () => ({ projects: [{ slug: PAPERCUSP_HIVE_SLUG, path: '/clones/papercusp' }] })),
      submodulesNeedUpdate: vi.fn(async () => true),
      initSubmodules: vi.fn((_root, opts) => {
        opts?.onDone?.(false);
      }),
    });
    const first = await startBootstrapPapercuspHive(failing).done;
    expect(first.state).toBe('already-present');
    expect(failing.initSubmodules).toHaveBeenCalledTimes(1);

    const retry = spyDeps({
      loadRegistry: vi.fn(async () => ({ projects: [{ slug: PAPERCUSP_HIVE_SLUG, path: '/clones/papercusp' }] })),
      submodulesNeedUpdate: vi.fn(async () => true),
      initSubmodules: vi.fn((_root, opts) => {
        opts?.onDone?.(true);
      }),
    });
    const second = await startBootstrapPapercuspHive(retry).done;
    expect(second.state).toBe('already-present');
    expect(retry.initSubmodules).toHaveBeenCalledTimes(1);
  });
});
