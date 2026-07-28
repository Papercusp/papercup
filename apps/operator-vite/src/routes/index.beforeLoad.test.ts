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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

import { Route, resolveLanding } from './index';

const beforeLoad = (Route as unknown as { beforeLoad: () => Promise<never> }).beforeLoad;

let fetchImpl: typeof fetch;
/** Every sleep is instant and counted: no test waits out a real settle budget. */
let slept: number[];

/**
 * Resolve a landing against the stubbed fetch, with time INJECTED.
 *
 * `now` advances by whatever was slept, so "the budget expired" is exercised
 * deterministically rather than by wall-clock — a 30s real wait is not a test
 * anyone runs twice, and a branch nobody runs is a branch nobody checks.
 */
async function landing(budgetMs = 30_000): Promise<{ to?: string }> {
  let clock = 0;
  return {
    to: await resolveLanding({
      fetchImpl,
      budgetMs,
      now: () => clock,
      sleep: async (ms: number) => {
        slept.push(ms);
        clock += ms;
      },
    }),
  };
}

function stubFetch(fn: typeof fetch) {
  fetchImpl = fn;
  vi.stubGlobal('fetch', fn);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

beforeEach(() => {
  slept = [];
  fetchImpl = (async () => new Response('{}', { status: 200 })) as typeof fetch;
});

describe('/ entry beforeLoad (WI-2817 resilience)', () => {
  it('finished wizard → /adv', async () => {
    stubFetch((async () =>
      new Response(JSON.stringify({ finished_at: '2026-01-01T00:00:00Z' }), { status: 200 })) as typeof fetch);
    const r = await landing();
    expect(r.to).toBe('/adv');
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

  it('a 5xx that NEVER recovers → /adv once the budget expires, never first-run', async () => {
    let calls = 0;
    stubFetch((async () => {
      calls += 1;
      return new Response('still booting', { status: 503 });
    }) as typeof fetch);
    const r = await landing(3_000);
    expect(r.to).toBe('/adv');
    // It really waited (rather than giving up on the first answer) and really
    // stopped (rather than spinning forever on a dead backend).
    expect(calls).toBeGreaterThan(1);
    expect(slept.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(3_000);
  });

  it('4xx response → /adv, NEVER first-run, and does NOT burn the budget', async () => {
    // A 4xx will not fix itself, so waiting on it is pure latency — but it is
    // still not a statement about the user.
    stubFetch((async () => new Response('nope', { status: 404 })) as typeof fetch);
    const r = await landing();
    expect(r.to).toBe('/adv');
    expect(slept).toEqual([]);
  });

  it('2xx with an unreadable body → /adv, NEVER first-run', async () => {
    stubFetch((async () => new Response('<html>not json</html>', { status: 200 })) as typeof fetch);
    const r = await landing();
    expect(r.to).toBe('/adv');
    expect(slept).toEqual([]);
  });

  it('UNREACHABLE backend (fetch keeps failing) → /adv, not a hang', async () => {
    // Every attempt rejects (network error). fetchWithTimeout exhausts its
    // retries and throws → treated as transient-inconclusive, waited out, then
    // /adv. The pre-fix code hung here forever.
    stubFetch((async () => {
      throw new TypeError('Failed to fetch');
    }) as typeof fetch);
    const r = await landing(3_000);
    expect(r.to).toBe('/adv');
  });

  it('beforeLoad turns the resolved landing into a real redirect (wiring)', async () => {
    // The resolver decides; this proves beforeLoad still THROWS that decision —
    // and carries the harnesses tab, which the resolver's bare '/adv' cannot.
    stubFetch((async () =>
      new Response(JSON.stringify({ finished_at: '2026-01-01T00:00:00Z' }), {
        status: 200,
      })) as typeof fetch);
    const thrown = await beforeLoad().then(
      () => null,
      (e: unknown) => e as { to?: string; search?: Record<string, unknown> },
    );
    expect(thrown?.to).toBe('/adv');
    expect(thrown?.search).toMatchObject({ tab: 'harnesses' });
  });
});
