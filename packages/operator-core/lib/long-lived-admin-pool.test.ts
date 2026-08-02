import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

/**
 * EI-19306394439939264 / WI-6739 — a cached pool must never outlive the URL that built it.
 *
 * On 2026-08-01 the operator logged 20,144 × `connect ECONNREFUSED 127.0.0.1:20216` for
 * ~100 minutes against a dead embedded-pg port. The outage was self-healable and did not
 * self-heal: `getHarnessAdminUrl()` had already started returning the healthy native
 * `:5432` fallback, but the hand-rolled module pools compared against nothing and stayed
 * bound to what they were built with until a manual restart.
 *
 * These tests pin the rebind, so a refactor that reintroduces a plain `let pool` cache
 * fails here rather than during the next outage.
 */

// The real module opens sockets; we only care about WHICH url each build received.
const built: string[] = [];
const builtOpts: Record<string, unknown>[] = [];
const ended: string[] = [];

vi.mock('postgres', () => ({
  default: (url: string, opts: Record<string, unknown>) => {
    built.push(url);
    builtOpts.push(opts);
    return { __url: url, end: async () => { ended.push(url); } };
  },
}));

let currentUrl = 'postgresql://u:p@127.0.0.1:20216/papercusp';
vi.mock('./embedded-pg-discovery', () => ({
  getHarnessAdminUrl: () => currentUrl,
}));

// Use the REAL endStalePool — the whole point is that this wiring actually invokes the
// primitive, not a stand-in that trivially agrees with the assertion.
vi.mock('@papercusp/db-org', async () => {
  const endStalePool = (client: unknown, builtWith: string | null, url: string) => {
    if (!client || builtWith === url) return false;
    void (client as { end: () => Promise<void> }).end();
    return true;
  };
  return {
    endStalePool,
    longLivedPoolConnectionOptions: (label: string) => ({ onnotice: () => {}, connection: { application_name: label } }),
    poolIdleTimeoutSec: () => 30,
  };
});

let mod: typeof import('./long-lived-admin-pool');
beforeEach(async () => {
  built.length = 0;
  builtOpts.length = 0; // must reset too — else builtOpts[0] is test #1's build, not this test's
  ended.length = 0;
  currentUrl = 'postgresql://u:p@127.0.0.1:20216/papercusp';
  mod = await import('./long-lived-admin-pool');
  mod._resetLongLivedAdminPoolsForTests();
});
afterEach(() => void vi.clearAllMocks());

describe('getLongLivedAdminPool — endpoint rebind (EI-19306394439939264)', () => {
  it('builds once and reuses the SAME instance while the URL is stable', () => {
    const a = mod.getLongLivedAdminPool('probe');
    const b = mod.getLongLivedAdminPool('probe');
    expect(a).toBe(b);
    expect(built).toHaveLength(1);
    expect(ended).toHaveLength(0); // a stable endpoint must never churn the pool
  });

  it('THE 2026-08-01 CASE: rebuilds onto the new endpoint when the resolved URL moves', () => {
    const stale = mod.getLongLivedAdminPool('probe');
    expect(mod.boundAdminPoolUrl('probe')).toContain(':20216');

    // The desktop's embedded PG dies; discovery falls back to healthy native :5432.
    currentUrl = 'postgresql://u:p@localhost:5432/papercusp';

    const fresh = mod.getLongLivedAdminPool('probe');
    expect(fresh).not.toBe(stale); // the bug was returning `stale` here, forever
    expect(mod.boundAdminPoolUrl('probe')).toContain(':5432');
    expect(built).toEqual([
      'postgresql://u:p@127.0.0.1:20216/papercusp',
      'postgresql://u:p@localhost:5432/papercusp',
    ]);
    // and the dead pool is drained rather than leaked
    expect(ended).toEqual(['postgresql://u:p@127.0.0.1:20216/papercusp']);
  });

  it('keeps labels independent — rebinding one pool does not disturb another', () => {
    const other = mod.getLongLivedAdminPool('other');
    mod.getLongLivedAdminPool('probe');
    currentUrl = 'postgresql://u:p@localhost:5432/papercusp';

    mod.getLongLivedAdminPool('probe'); // rebinds
    expect(mod.getLongLivedAdminPool('other')).not.toBe(other); // 'other' re-resolves too
    expect(mod.boundAdminPoolUrl('other')).toContain(':5432');
  });

  it('applies idle_timeout + attribution for the call site, and lets its own options win', () => {
    // Regression guard for the past saturation crit: postgres-js defaults idle_timeout to
    // 0 = never close, so a migrated site must not silently lose the drain. Supplying it
    // centrally is the reason a call site can no longer forget it.
    mod.getLongLivedAdminPool('opts-probe', { max: 4, prepare: false });
    const opts = builtOpts[0];
    expect(opts.idle_timeout).toBe(30);
    expect((opts.connection as Record<string, string>).application_name).toBe('opts-probe');
    expect(opts.max).toBe(4);
    expect(opts.prepare).toBe(false);
  });

  it('a call site may override a centrally-supplied default (extras are spread last)', () => {
    mod.getLongLivedAdminPool('override-probe', { idle_timeout: 5 });
    expect(builtOpts[0].idle_timeout).toBe(5);
  });
});
