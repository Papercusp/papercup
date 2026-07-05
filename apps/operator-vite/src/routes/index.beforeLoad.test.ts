// @vitest-environment jsdom
/**
 * The `/` entry-route `beforeLoad` — the first-run gateway that used to HANG
 * forever on a wedged backend (bare `fetch`, no timeout) and freeze the desktop
 * blank on launch (WI-2817). These lock the post-fix contract:
 *   - backend answers, wizard finished  → /adv
 *   - backend answers, wizard unfinished → first-run target (never /adv)
 *   - backend answers non-2xx            → first-run target
 *   - backend UNREACHABLE (retries exhausted) → /adv (recoverable surface,
 *     NOT a hang and NOT onboarding) — the core resilience change.
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

  it('non-2xx response → a first-run target', async () => {
    stubFetch((async () => new Response('nope', { status: 500 })) as typeof fetch);
    const r = await landing();
    expect(['/setup', '/onboarding']).toContain(r.to);
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
