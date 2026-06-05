/**
 * Regression guard for the D3 auth-tightening pass.
 *
 * The migration ported every route at its "current posture" (D3 of
 * `endpoint-route-migration-2026-05-20`); the D3 pass tightened
 * sensitive routes that had no auth check pre-migration. The desktop
 * UI auto-establishes a passwordless `verified` session via the first
 * `/api/auth/me` hit (auth.ts → auth/me.ts), so `verified` is the
 * real-world UI trust level — gating to `{trust:['verified','trusted']}`
 * defends sensitive surfaces against CSRF / DNS-rebinding from cookie-
 * less origins while still letting the chrome's same-origin fetches
 * and the SU bearer through.
 *
 * This test pins the resulting tiering. It fails if any route in a
 * sensitive family drifts back to `'public'`, and it fails if a route
 * that MUST stay public (OAuth redirects, unauth probes) is tightened.
 */
import { describe, it, expect } from 'vitest';
import { ALL_ROUTES } from '../routes';

type RouteAuth = 'public' | { trust?: readonly string[] };
const VT = { trust: ['verified', 'trusted'] } as const;
const T_ONLY = { trust: ['trusted'] } as const;

function describeAuth(a: RouteAuth): string {
  if (a === 'public') return "'public'";
  if (!a || Object.keys(a).length === 0) return '{}';
  return JSON.stringify(a);
}

/**
 * Per-family expected tier. Routes whose path starts with `prefix` must
 * have an `auth` equal to `expect` — unless the (method, path) appears
 * in `exceptions` (rare pre-existing tiers that D3 didn't reconcile).
 */
const RULES: ReadonlyArray<{
  prefix: string;
  expect: RouteAuth;
  exceptions?: ReadonlyArray<{ method: string; path: string; auth: RouteAuth }>;
}> = [
  { prefix: '/dev/', expect: VT },
  { prefix: '/credentials', expect: VT },
  { prefix: '/publish-credentials', expect: VT },
  {
    prefix: '/agent-tokens/',
    expect: VT,
    exceptions: [
      // The refresh token (Authorization: Bearer) IS the credential, read in
      // the handler — and during refresh the access token has expired by
      // definition, so there's no verified/trusted transport principal to gate
      // on. `auth: {}` per the route's doc-comment; VT 403'd every legitimate
      // refresh (the same Authorization header can't be both a trusted-principal
      // bearer and the refresh token).
      { method: 'POST', path: '/agent-tokens/power-user/refresh', auth: {} },
    ],
  },
  { prefix: '/provision/', expect: VT },
  { prefix: '/internal/', expect: {} },
  // The /api/tui/* workbench routes are intentionally `auth:'public'` — same
  // posture as the sibling /api/coord/* routes (loopback-protected by the host
  // bind, owner-scoped by an explicit `owner` arg; the intent-result/stream
  // routes additionally gate on `isLoopbackRequest` inline). This pins that
  // posture so a /tui/ route can't silently drift off public. Behaviour of the
  // handlers themselves is covered by `tui-routes.test.ts`. (Decision recorded
  // in the route's doc-comment + BRIEF-test-coverage-fu-tui-routes.)
  { prefix: '/tui/', expect: 'public' },
  {
    prefix: '/admin/',
    expect: VT,
    exceptions: [
      // Pre-existing tier — faithful ports of routes that already required SU.
      { method: 'POST', path: '/admin/backup-orphan-cleanup', auth: T_ONLY },
      { method: 'POST', path: '/admin/embed-backfill', auth: T_ONLY },
      { method: 'GET',  path: '/admin/spawn-signing/failures', auth: T_ONLY },
      { method: 'POST', path: '/admin/spawn-signing/rotate', auth: T_ONLY },
      // dbos/pipeline/start intentionally requires the stricter `trusted` tier
      // (not verified) — a deliberate stricter gate, like spawn-signing.
      { method: 'POST', path: '/admin/dbos/pipeline/start', auth: T_ONLY },
      // (admin/plans.ts is now committed + gated to VT, so its prior deferred
      // 'public' exception was removed.)
    ],
  },
];

/**
 * Routes that MUST stay `'public'`. Tightening them breaks OAuth
 * (external-provider redirect) or pre-login health probes.
 */
const MUST_BE_PUBLIC: ReadonlyArray<[string, string]> = [
  ['GET',     '/oauth/start'],
  ['GET',     '/oauth/callback'],
  ['GET',     '/desktop/version'],
  ['OPTIONS', '/desktop/version'],
  ['GET',     '/desktop/preflight'],
  ['OPTIONS', '/desktop/preflight'],
];

describe('D3 auth posture', () => {
  for (const rule of RULES) {
    it(`every route under ${rule.prefix} has the expected tier`, () => {
      const inFamily = ALL_ROUTES.filter((r) => r.path.startsWith(rule.prefix));
      expect(inFamily.length, `no routes found under ${rule.prefix}`).toBeGreaterThan(0);
      const wrong: string[] = [];
      for (const r of inFamily) {
        const exc = rule.exceptions?.find(
          (e) => e.method === r.method && e.path === r.path,
        );
        const expected = exc ? exc.auth : rule.expect;
        const actual = r.auth as unknown as RouteAuth;
        if (JSON.stringify(actual) !== JSON.stringify(expected)) {
          wrong.push(
            `  [${r.method}] ${r.path}  expected ${describeAuth(expected)}, got ${describeAuth(actual)}`,
          );
        }
      }
      expect(wrong, `auth-tier drift under ${rule.prefix}:\n${wrong.join('\n')}`).toEqual([]);
    });
  }

  it.each(MUST_BE_PUBLIC)('%s %s must remain public', (method, path) => {
    const def = ALL_ROUTES.find((r) => r.method === method && r.path === path);
    expect(def, `${method} ${path} not registered`).toBeDefined();
    expect(def!.auth).toBe('public');
  });

  it('oauth/verify-paste is gated (browser-posted by a logged-in user)', () => {
    const def = ALL_ROUTES.find((r) => r.method === 'POST' && r.path === '/oauth/verify-paste');
    expect(def).toBeDefined();
    expect(def!.auth).toEqual(VT);
  });
});
