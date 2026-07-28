// @vitest-environment jsdom
/**
 * The `/` entry-route `beforeLoad` — the first-run gateway that used to HANG
 * forever on a wedged backend (bare `fetch`, no timeout) and freeze the desktop
 * blank on launch (WI-2817). These lock the post-fix contract:
 *   - backend answers 2xx, wizard finished   → /adv
 *   - backend answers 2xx, wizard unfinished → first-run target (never /adv)
 *   - backend answers 5xx                    → /adv, NEVER first-run
 *   - backend answers 4xx                    → /adv, NEVER first-run
 *   - backend UNREACHABLE (retries exhausted) → /adv (recoverable surface,
 *     NOT a hang and NOT onboarding) — the core resilience change.
 *
 * The two non-2xx cases INVERT what this file previously asserted, deliberately
 * (EI-18889416741921988). The old contract — "non-2xx → first-run" — meant a
 * returning user whose sidecar lagged the webview got a 502 from the shell's own
 * proxy and landed in the onboarding tutorial, which is precisely the outcome the
 * UNREACHABLE case beside it was written to prevent. The endpoint answers a
 * genuine fresh install with 200 + `{ step_status: {} }`, so a non-2xx is never
 * evidence about the user at all — only that the backend could not answer.
 *
 * Found by the packaged perf suite, which had been measuring `/onboarding` while
 * publishing the numbers as the operator shell.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tanstack/react-router', () => ({
  // Expose the route options object so we can call beforeLoad directly.
  createFileRoute: () => (opts: Record<string, unknown>) => opts,
  redirect: (arg: Record<string, unknown>) =>
    Object.assign(new Error('redirect'), { __redirect: true, ...arg }),
  isRedirect: (e: unknown) => Boolean((e as { __redirect?: boolean })?.__redirect),
}));

// Deterministic flags: getFlagSnapshot returns no explicit flags, so
// onboardingFlagEnabled resolves ONBOARDING_AGENT_FIRST from FLAG_DEFAULTS.
vi.mock('@papercusp/flags/client', () => ({
  loadFlags: vi.fn(async () => {}),
  getFlagSnapshot: () => ({ flags: {} }),
}));

import { Route } from './index';

const beforeLoad = (Route as unknown as { beforeLoad: () => Promise<never> }).beforeLoad;

/** Run beforeLoad and return the thrown redirect target (or throw a real error). */
async function landing(): Promise<{ to?: string; search?: Record<string, unknown> }> {
  try {
    await beforeLoad();
  } catch (e) {
    if ((e as { __redirect?: boolean })?.__redirect) return e as { to?: string };
    throw e;
  }
  throw new Error('beforeLoad did not redirect');
}

function stubFetch(fn: typeof fetch) {
  vi.stubGlobal('fetch', fn);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('/ entry beforeLoad (WI-2817 resilience)', () => {
  it('finished wizard → /adv', async () => {
    stubFetch((async () =>
      new Response(JSON.stringify({ finished_at: '2026-01-01T00:00:00Z' }), { status: 200 })) as typeof fetch);
    const r = await landing();
    expect(r.to).toBe('/adv');
    expect(r.search).toMatchObject({ tab: 'harnesses' });
  });

  it('unfinished wizard → a first-run target, never /adv', async () => {
    stubFetch((async () => new Response(JSON.stringify({}), { status: 200 })) as typeof fetch);
    const r = await landing();
    expect(['/setup', '/onboarding']).toContain(r.to);
  });

  it('502 from the shell proxy (sidecar still booting) → /adv, NEVER first-run', async () => {
    // The exact packaged-app failure: the webview is served from disk by the
    // papercusp:// protocol handler, so the SPA can render seconds before its
    // sidecar listens, and the shell's proxy answers 502 in that gap.
    stubFetch((async () =>
      new Response('papercusp: upstream error: error sending request', {
        status: 502,
      })) as typeof fetch);
    const r = await landing();
    expect(r.to).toBe('/adv');
  });

  it('a 5xx that RECOVERS within the budget → the recovered answer decides', async () => {
    // Waiting is the whole point of treating 5xx as transient: the second
    // attempt is the sidecar having finished booting.
    let calls = 0;
    stubFetch((async () => {
      calls += 1;
      return calls === 1
        ? new Response('booting', { status: 503 })
        : new Response(JSON.stringify({ finished_at: '2026-01-01T00:00:00Z' }), { status: 200 });
    }) as typeof fetch);
    const r = await landing();
    expect(r.to).toBe('/adv');
    expect(calls).toBeGreaterThan(1);
  });

  it('4xx response → /adv, NEVER first-run (and does not sit out the budget)', async () => {
    // A 4xx will not fix itself, so it must not burn the settle budget — but it
    // is still not a statement about the user.
    const started = Date.now();
    stubFetch((async () => new Response('nope', { status: 404 })) as typeof fetch);
    const r = await landing();
    expect(r.to).toBe('/adv');
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('2xx with an unreadable body → /adv, NEVER first-run', async () => {
    stubFetch((async () => new Response('<html>not json</html>', { status: 200 })) as typeof fetch);
    const r = await landing();
    expect(r.to).toBe('/adv');
  });

  it('UNREACHABLE backend (fetch keeps failing) → /adv, not a hang', async () => {
    // Every attempt rejects (network error). fetchWithTimeout exhausts its
    // retries and throws → the outer catch lands on /adv. The pre-fix code hung
    // here forever. (Real backoff sleeps run — a few retries, ~1.6s.)
    stubFetch((async () => {
      throw new TypeError('Failed to fetch');
    }) as typeof fetch);
    const r = await landing();
    expect(r.to).toBe('/adv');
    expect(r.search).toMatchObject({ tab: 'harnesses' });
  });
});
