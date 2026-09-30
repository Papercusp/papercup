/**
 * WI-10004174 — what the external-ingress listener serves.
 *
 * The external-ingress listener (`PAPERCUSP_EXTERNAL_INGRESS_PORT`, external-app-access P-004)
 * is the port a user's own tunnel points at. It used to serve the whole app, so every
 * `auth:'public'` route (reachable without credentials because only the local machine could
 * reach the loopback listener) became reachable from the internet through the tunnel.
 *
 * A remote MCP client needs exactly three things: the discovery documents, the OAuth endpoints,
 * and the MCP resource. This module is that list and nothing else. Every other path answers 404
 * on the external-ingress listener. Exact paths only, never a prefix, so a new route under an
 * allowed directory is not exposed by accident.
 *
 * The path constants come from the one discovery map (connected-apps/mcp-oauth-discovery.ts),
 * so the host's well-known mapping and this list cannot drift apart.
 */
import {
  MCP_OAUTH_BASE,
  MCP_OAUTH_WELL_KNOWN,
  MCP_RESOURCE_PATH,
} from '@papercusp/operator-core/lib/connected-apps/mcp-oauth-discovery';
import { isWebhookPath } from '@papercusp/operator-core/lib/external-triggers/webhook-path';

/** The OAuth route verbs a remote client uses (routes/connected-apps/oauth.ts). */
const OAUTH_VERBS = ['protected-resource', 'authorization-server', 'register', 'authorize', 'continue', 'token'] as const;

/**
 * WI-10004269 — the two RFC 8628 device-grant endpoints an app calls from wherever it runs
 * (D-004: a local server offers device-code sign-in with no portal account; D-018: both are
 * own-auth public). `device/code` only opens a PENDING grant, and `device/token` needs the
 * secret device_code. The approval page and the decision route stay loopback-only and are
 * NOT listed here, so a grant can be approved only by the person at the machine.
 */
export const DEVICE_GRANT_PATHS = ['/api/connected-apps/device/code', '/api/connected-apps/device/token'] as const;

export const EXTERNAL_INGRESS_SERVED_PATHS: ReadonlySet<string> = new Set([
  ...Object.keys(MCP_OAUTH_WELL_KNOWN),
  ...OAUTH_VERBS.map((verb) => `${MCP_OAUTH_BASE}/${verb}`),
  MCP_RESOURCE_PATH,
  ...DEVICE_GRANT_PATHS,
]);

/**
 * Whether the external-ingress listener serves this request path. A trailing slash is ignored.
 *
 * Besides the fixed MCP + OAuth set, one path SHAPE is served: a signed webhook,
 * exactly `/api/hooks/<source id>` (P-017, D-032 #4). The route checks the HMAC
 * signature before it writes anything, so it needs no bearer.
 */
export function isServedOnExternalIngress(pathname: string): boolean {
  const normalized = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  return EXTERNAL_INGRESS_SERVED_PATHS.has(normalized) || isWebhookPath(normalized);
}

/** The refusal for any other path: a plain 404, so the listener does not advertise what exists. */
export function notServedOnExternalIngress(): Response {
  return Response.json(
    {
      error: {
        code: 'not_served_on_external_ingress',
        message: 'This address serves only the MCP endpoint and its OAuth sign-in.',
      },
    },
    { status: 404 },
  );
}
