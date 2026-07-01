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

type RouteAuth = 'public' | 'loopback' | { trust?: readonly string[] };
const VT = { trust: ['verified', 'trusted'] } as const;
// VT + bare loopback. The D3 rationale above assumed the desktop webview
// holds a verified session from /api/auth/me's auto-login — in practice the
// webview's /api traffic rides the sys:http IPC bridge where cookies don't
// exist (EI-338). On the bridge the injected loopback-superuser bearer
// resolves `trusted` (live-verified 2026-06-12: VT route 200 via socket,
// 403 via bare HTTP) — but during the documented HTTP-FALLBACK windows
// (dev no-sidecar, prod pre-IPC-handshake, IPC down) the webview fetches
// natively with no bearer, resolves `unverified-loopback`, and a VT gate
// silently 403-blanks the settings UI (found 2026-06-11). These families
// admit unverified-loopback for that fallback path, backstopped by the
// requireAllowedOriginOr403 CSRF guard on every mutating handler.
// Re-tighten to VT only when the native-HTTP fallback path is retired —
// NOT on cookie persistence, which can never apply to IPC traffic.
const VTL = { trust: ['verified', 'trusted', 'unverified-loopback'] } as const;
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
  { prefix: '/credentials', expect: VTL },
  { prefix: '/publish-credentials', expect: VTL },
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
  // The /api/tui/* workbench READS stay `auth:'public'` (loopback-protected by
  // the host bind, owner-scoped by an explicit `owner` arg; the intent-result/
  // stream routes additionally gate on `isLoopbackRequest` inline). The
  // MUTATING routes were hardened public → 'loopback' (auth-tier rollout,
  // 2026-06-11: the box is tunnel-exposed, so TUI writes must not ride the
  // public tier). This pins BOTH postures so neither drifts. Handler behavior
  // is covered by `tui-routes.test.ts`.
  {
    prefix: '/tui/',
    expect: 'public',
    exceptions: [
      { method: 'PUT',    path: '/tui/view-state',    auth: 'loopback' },
      { method: 'PUT',    path: '/tui/layouts',       auth: 'loopback' },
      { method: 'DELETE', path: '/tui/layouts/:name', auth: 'loopback' },
      { method: 'PUT',    path: '/tui/crews',         auth: 'loopback' },
      { method: 'DELETE', path: '/tui/crews/:name',   auth: 'loopback' },
      { method: 'POST',   path: '/tui/intents/:id/result',  auth: 'loopback' },
      { method: 'POST',   path: '/tui/plan-item-convert',   auth: 'loopback' },
      { method: 'POST',   path: '/tui/plan-item-release',   auth: 'loopback' },
    ],
  },
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
      // Deploy-accounts powers the settings UI from the cookie-less desktop
      // webview's HTTP-fallback path — admits unverified-loopback (see VTL).
      { method: 'GET',  path: '/admin/deploy-accounts', auth: VTL },
      { method: 'POST', path: '/admin/deploy-accounts/register', auth: VTL },
      // One-click OAuth link start + completion (accounts-pool-tab-2026-06-15 P-002)
      // — both routes declare VTL with the SAME cookie-less desktop-webview rationale
      // (EI-338, "mirrors /register, /reset-rate") as its siblings here.
      { method: 'POST', path: '/admin/deploy-accounts/link-start', auth: VTL },
      { method: 'POST', path: '/admin/deploy-accounts/link-complete', auth: VTL },
      // Session-now account override read/write (accounts-pool-tab P-004) — same
      // cookie-less desktop-webview rationale (EI-338) as its deploy-accounts siblings.
      { method: 'GET', path: '/admin/deploy-accounts/session-override', auth: VTL },
      { method: 'POST', path: '/admin/deploy-accounts/session-override', auth: VTL },
      { method: 'POST', path: '/admin/deploy-accounts/remove', auth: VTL },
      { method: 'POST', path: '/admin/deploy-accounts/reset-rate', auth: VTL },
      // Same cookie-less desktop-webview HTTP-fallback path (EI-338): the
      // gateway rate/headroom stats view admits unverified-loopback (see the
      // route's own auth declaration in admin/inference-gateway-stats.ts).
      { method: 'GET',  path: '/admin/inference-gateway/stats', auth: VTL },
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
  // The desktop dev-wrapper bar's status poll (desktop-build-switcher-
  // wrapper-2026-06-09 P-010) — a native Rust HTTP client with no auth
  // context; tightening it blanks the bar's pipeline readout.
  ['GET',     '/desktop/git-pipeline'],
  ['OPTIONS', '/desktop/git-pipeline'],
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

/**
 * Auth-tier Wave 1 (audit D-007/D-009, owner-approved 2026-06-10; landed
 * 2026-06-11 on WI-99): mutating routes are loopback-or-better, enforced at
 * the route-stack chokepoint. This registry gate is the standing P-038-style
 * lint — a NEW mutating route shipped as `auth: 'public'` fails here unless
 * the owner has confirmed it as a named remote exception (the OWNER rows of
 * apps/operator/docs/auth-tier-rollout-2026-06-10.md).
 */
describe('auth-tier Wave 1 — no public mutating routes (standing gate)', () => {
  const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
  /** The owner-confirmed `public!` mutating exceptions (review 2026-06-11). */
  const OWNER_PUBLIC: ReadonlySet<string> = new Set([
    // change-password + auth/me PATCH were flipped public → 'loopback'
    // (2026-06-11, settings audit): they take the cookie-less-webview
    // default-user fallback (EI-338), so they must NOT also be remote-public.
    // Loopback admits the local webview while blocking off-box; a cross-origin
    // CSRF guard (requireAllowedOriginOr403) blocks foreign browser pages.
    'POST /auth/login',
    'POST /auth/logout',
    // Signup is additionally gated in-handler: first-account bootstrap, then
    // the OPEN_SIGNUP flag (default OFF).
    'POST /auth/signup',
    'DELETE /device/desktop/devices/:deviceId',
    'POST /device/desktop/mint-pair-token',
    'POST /device/pair',
    'POST /elevenlabs/webhook',
    'POST /flags/webhook',
  ]);
  /**
   * Own-auth TRANSPORT surfaces — `auth: 'public'` at the route layer is the
   * design, not a gap: each enforces bearer/principal auth in its own
   * dispatch (the composite resolver / mcpHandler), and remote reachability
   * is intentional (the phone calls built-in tools cross-origin through the
   * tunnel; remote MCP rides /:transport). NOT part of the owner-ratified
   * 16-row table — flagged for owner review on WI-99; do not grow this set
   * without the same own-auth story.
   */
  const OWN_AUTH_TRANSPORTS: ReadonlySet<string> = new Set([
    'POST /agent-tools/*',
    'PUT /agent-tools/*',
    'PATCH /agent-tools/*',
    'DELETE /agent-tools/*',
    'POST /plugins/*',
    'PUT /plugins/*',
    'PATCH /plugins/*',
    'DELETE /plugins/*',
    'POST /:transport',
    'DELETE /:transport',
    // Cross-swarm authority RPC: remote peers POST lease/lock ops here via
    // HttpPeerRpcTransport — loopback would break federated authority.
    // verifyIsAuthority is the app-level check; EI-284 tracks the missing
    // caller-standing hardening.
    'POST /authority/rpc',
  ]);

  it('every mutating HTTP route declares a non-public tier unless owner-allowlisted', () => {
    const offenders = ALL_ROUTES
      .filter((r) => MUTATING.has(r.method))
      .filter((r) => (r.auth as unknown) === 'public')
      .map((r) => `${r.method} ${r.path}`)
      .filter((key) => !OWNER_PUBLIC.has(key) && !OWN_AUTH_TRANSPORTS.has(key));
    expect(
      offenders,
      `PUBLIC mutating route(s) — declare auth: 'loopback' (the Wave-1 rule) or get ` +
      `explicit owner sign-off and add the route to OWNER_PUBLIC here AND to the ` +
      `REMOTE_SURFACES list in scripts/gen-auth-tier-audit.mjs:\n  ${offenders.join('\n  ')}`,
    ).toEqual([]);
  });

  it('the owner allowlist is not stale (every entry still exists and is still public)', () => {
    for (const key of OWNER_PUBLIC) {
      const [method, path] = key.split(' ');
      const def = ALL_ROUTES.find((r) => r.method === method && r.path === path);
      expect(def, `${key} is allowlisted but no longer registered`).toBeDefined();
      expect(def!.auth, `${key} is allowlisted but no longer public — remove it`).toBe('public');
    }
  });

  it('loopback-tier coverage is substantial (the Wave-1 flip actually landed)', () => {
    const loopback = ALL_ROUTES.filter((r) => (r.auth as unknown) === 'loopback');
    expect(loopback.length).toBeGreaterThan(200);
  });
});

/**
 * WI-1388 (security): the harness SSE stream endpoints (routes/harness/streams.ts)
 * read harness run logs / an agent run's "thinking" timeline — tool inputs/RESULTS
 * that can hold file contents + secrets — by raw caller-supplied slug/runId with NO
 * workspace or ownership scoping. Every consumer is the loopback desktop webview via
 * a relative /api URL; the mobile path uses its OWN device-JWT endpoint
 * (/device/harnesses/:slug/log/stream, which re-implements the tail — not a proxy to
 * these). So gate them loopback-only: a network-exposed bind (PAPERCUSP_BIND_HOST=
 * 0.0.0.0) or a cloud-deployed frame can no longer serve these unauthenticated
 * (non-loopback → 403; PAPERCUSP_ALLOW_REMOTE_ADMIN=1 is the deliberate remote opt-out).
 * This pins the tier so none drifts back to 'public'; the /adv/session/thinking sibling
 * was hardened first (the same file's prior pass).
 */
describe('harness SSE stream endpoints are loopback-gated (WI-1388)', () => {
  const STREAMS: ReadonlyArray<[string, string]> = [
    ['GET', '/harness/:slug/agents/:runId/stream'],
    ['GET', '/harness/:slug/stream'],
    ['GET', '/harness/:slug/log/stream'],
    ['GET', '/adv/session/thinking'],
  ];
  it.each(STREAMS)('%s %s is auth: loopback (never public)', (method, path) => {
    const def = ALL_ROUTES.find((r) => r.method === method && r.path === path);
    expect(def, `${method} ${path} not registered`).toBeDefined();
    expect(def!.auth).toBe('loopback');
  });
});
