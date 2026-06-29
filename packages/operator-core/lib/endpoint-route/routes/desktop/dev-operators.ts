/**
 * GET /api/desktop/dev-operators  (+ OPTIONS preflight)
 *
 * The data feed for the cross-platform in-webview env switcher (EnvSwitcherBar) —
 * dogfood-silent-canonical-hive-join P-012..P-014 / P-017, D-006/D-008. Returns the
 * canonical env targets (dev/prod/staging/local) PLUS the "release" env (the immutable
 * bundled package code) with SERVER-SIDE reachability + which one is serving this
 * request (active), so the switcher renders the same envs as the native Linux GTK
 * dev-wrapper bar, but on every platform.
 *
 * Reachability is probed server-side (operator → localhost) because a webview on one
 * origin can't cross-origin fetch a sibling operator's /version (CORS); the switch
 * itself is a top-level window.location navigation (not CORS-bound).
 *
 * auth: {} — the standard cookie-less desktop-webview read posture (same as
 * setup-wizard-state / git-identity). Read-only, loopback-bound, non-secret (ports +
 * reachability + shas, same class as desktop/version).
 */
import { defineTool } from '@papercusp/agent-mcp';
import { resolveDevOperators } from '../../../harness/dev-operators';

const CORS_HEADERS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, OPTIONS',
  'access-control-allow-headers': 'content-type',
};

export default [
  defineTool({
    method: 'GET',
    path: '/desktop/dev-operators',
    auth: {},
    async handler() {
      const { operators, selfPort } = await resolveDevOperators();
      return new Response(JSON.stringify({ ok: true, operators, selfPort }), {
        headers: { 'content-type': 'application/json', ...CORS_HEADERS },
      });
    },
  }),
  defineTool({
    method: 'OPTIONS',
    path: '/desktop/dev-operators',
    auth: {},
    handler() {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    },
  }),
];
