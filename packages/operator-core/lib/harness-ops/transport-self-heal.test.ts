/**
 * WI-1385 regression: operator → harness dispatch self-heals a STALE cached LOCAL
 * endpoint. A sidecar that died or MOVED to a new port leaves the harness_registry
 * `.localEndpoint` pointing at a dead port; before this fix `harnessApiFetch`
 * hammered that dead port forever (ECONNREFUSED every ~13min for the oddsmith
 * blueprint-run cadence). The fix: on a connection-refuse across every retry of a
 * `local`-source base, drop the cached endpoint so the next dispatch fails closed
 * ("endpoint not registered") until the sidecar re-advertises its live port.
 *
 * Hermetic: the registry module + global `fetch` are stubbed so no PG / real socket
 * is touched. (The env/frame/local resolution ORDER is covered by transport.test.ts;
 * this file covers the source-scoped invalidation semantics.)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Frame } from '@papercusp/deployment-driver';

// In-memory registry the stubs read/write, so loadHarnessRegistry +
// mutateHarnessRegistry operate hermetically.
const state: { projects: Array<{ slug: string; localEndpoint?: { host: string; port: number; advertisedAt: string } }> } = {
  projects: [],
};
const mutateSpy = vi.fn(
  async (mutator: (reg: { projects: typeof state.projects }) => { projects: typeof state.projects }) => {
    const next = mutator({ projects: state.projects });
    state.projects = next.projects;
    return next;
  },
);
vi.mock('../harness-registry', () => ({
  loadHarnessRegistry: vi.fn(async () => ({ projects: state.projects })),
  mutateHarnessRegistry: mutateSpy,
}));
// step-2 (deployed frame) is only consulted with a workspaceId; stub it inert so a
// stray lookup can never reach real deployment state.
vi.mock('../deployment/deployed-frame', () => ({
  loadDeployedFrame: vi.fn(async () => undefined),
}));

const { resolveHarnessApiBase, harnessApiFetch, invalidateHarnessLocalEndpoint, harnessEndpointEnvVar } =
  await import('./transport.js');

const SLUG = 'oddsmith';
const ENV_VAR = harnessEndpointEnvVar(SLUG);

/** An undici-shaped ECONNREFUSED: `TypeError: fetch failed` whose `.cause.code` is
 *  the OS error (what `isConnRefused` / `isTransientNetworkError` read). */
function connRefused(): TypeError {
  const e = new TypeError('fetch failed');
  (e as { cause?: unknown }).cause = { code: 'ECONNREFUSED', message: 'connect ECONNREFUSED 127.0.0.1:46260' };
  return e;
}
/** A non-refused transient (a connect timeout — may recover on the SAME port). */
function timedOut(): TypeError {
  const e = new TypeError('fetch failed');
  (e as { cause?: unknown }).cause = { code: 'ETIMEDOUT', message: 'connect ETIMEDOUT 127.0.0.1:46260' };
  return e;
}

function seedLocalEndpoint(port: number): void {
  state.projects = [{ slug: SLUG, localEndpoint: { host: '127.0.0.1', port, advertisedAt: '2026-07-01T00:00:00Z' } }];
}

beforeEach(() => {
  delete process.env[ENV_VAR];
  state.projects = [];
  mutateSpy.mockClear();
  vi.unstubAllGlobals();
});

describe('resolveHarnessApiBase source tagging', () => {
  it('reports source: env | frame | local for each resolution step', async () => {
    process.env[ENV_VAR] = 'http://127.0.0.1:9999';
    expect(await resolveHarnessApiBase(SLUG)).toEqual({ base: 'http://127.0.0.1:9999', source: 'env' });
    delete process.env[ENV_VAR];

    const frame = {
      id: 'frame-1',
      target: 'local',
      placement: 'remote',
      host: '10.0.0.5',
      callablePort: 8080,
    } as Frame;
    expect(await resolveHarnessApiBase(SLUG, undefined, frame)).toEqual({ base: 'http://10.0.0.5:8080', source: 'frame' });

    seedLocalEndpoint(46229);
    expect(await resolveHarnessApiBase(SLUG)).toEqual({ base: 'http://127.0.0.1:46229', source: 'local' });
  });
});

describe('harnessApiFetch self-heal on a persistent connection-refuse (WI-1385)', () => {
  it('drops the stale LOCAL endpoint so the next dispatch fails closed', async () => {
    seedLocalEndpoint(46260); // dead port
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(connRefused()));

    await expect(
      harnessApiFetch(SLUG, '/api/op/oddsmith%3Aprospect', { method: 'POST' }, { backoffsMs: [] }),
    ).rejects.toThrow(/dispatch to http:\/\/127\.0\.0\.1:46260.*failed/);

    // The stale endpoint was cleared exactly once …
    expect(mutateSpy).toHaveBeenCalledTimes(1);
    expect(state.projects[0]?.localEndpoint).toBeUndefined();
    // … so the next resolve fails closed until the sidecar re-advertises.
    await expect(resolveHarnessApiBase(SLUG)).rejects.toThrow(/no dispatch endpoint registered/);
  });

  it('does NOT invalidate an ENV-override base (only the local source self-heals)', async () => {
    process.env[ENV_VAR] = 'http://127.0.0.1:9999';
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(connRefused()));

    await expect(harnessApiFetch(SLUG, '/x', undefined, { backoffsMs: [] })).rejects.toThrow(/failed/);
    expect(mutateSpy).not.toHaveBeenCalled();
  });

  it('does NOT invalidate on a non-refused transient error (a timeout may recover on the same port)', async () => {
    seedLocalEndpoint(46260);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(timedOut()));

    await expect(harnessApiFetch(SLUG, '/x', undefined, { backoffsMs: [] })).rejects.toThrow(/failed/);
    expect(mutateSpy).not.toHaveBeenCalled();
    expect(state.projects[0]?.localEndpoint).toBeDefined();
  });

  it('rides over a mid-restart refuse that recovers within the backoff window (no invalidation)', async () => {
    seedLocalEndpoint(46229);
    const okRes = new Response('{"ok":true}', { status: 200 });
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(connRefused()) // first attempt refuses (sidecar booting)
      .mockResolvedValueOnce(okRes); // retry succeeds on the same port
    vi.stubGlobal('fetch', fetchMock);

    const res = await harnessApiFetch(SLUG, '/x', undefined, { backoffsMs: [1] });
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // recovered on the same port → endpoint kept, never invalidated
    expect(mutateSpy).not.toHaveBeenCalled();
    expect(state.projects[0]?.localEndpoint?.port).toBe(46229);
  });
});

describe('invalidateHarnessLocalEndpoint', () => {
  it('clears a present endpoint, is idempotent, and no-ops for an unknown slug', async () => {
    seedLocalEndpoint(46260);
    expect(await invalidateHarnessLocalEndpoint(SLUG)).toEqual({ cleared: true });
    expect(state.projects[0]?.localEndpoint).toBeUndefined();

    expect(await invalidateHarnessLocalEndpoint(SLUG)).toEqual({ cleared: false }); // already cleared
    expect(await invalidateHarnessLocalEndpoint('does-not-exist')).toEqual({ cleared: false });
  });
});
