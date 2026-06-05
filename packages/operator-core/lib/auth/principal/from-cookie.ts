/**
 * Cookie-session → Principal resolver.
 *
 * Reads the `papercusp_session` cookie from the request's `Headers`,
 * validates against the PG session row, and produces a `Principal` with
 * `kind: 'user'`, `authMethod: 'cookie-session'`, `trust: 'verified'`.
 *
 * Returns null when there is no cookie, the cookie is expired, the user
 * is inactive, or the row is missing — every "no principal" outcome
 * resolves to null without throwing so the composite `requirePrincipal()`
 * helper can fall through to the next resolver.
 *
 * Phase 3b step 2 (principal-rfc-2026-05-20.md §5a). The `headers`
 * parameter (added with the endpoint-route migration) makes this
 * Next-free: the session token comes from the passed `Cookie` header,
 * not `next/headers` `cookies()`.
 */

import type { Principal } from '@papercusp/agent-mcp';
import { getSessionUser } from '../../auth';
import { activeWorkspaceId } from '../../workspace-registry';

export async function principalFromCookie(headers: Headers): Promise<Principal | null> {
  const user = await getSessionUser(headers);
  if (!user) return null;
  // Cookie sessions in v1 are workspace-scoped via the desktop's
  // active-workspace concept. When the webapp ships (Phase 8) sessions
  // carry their own workspace claim and this falls away.
  const workspaceId = activeWorkspaceId();
  // v1 capability surface for user sessions: the wildcard cap. Real
  // capability rows for users land alongside Track A (auth +
  // multi-tenancy); until then a logged-in user has trust-level access
  // to every desktop-side operation the host exposes — the same as
  // the loopback fallback today, just with a verified identity behind it.
  return {
    kind: 'user',
    slug: user.id,
    workspaceId,
    authMethod: 'cookie-session',
    trust: 'verified',
    capabilities: new Set(['*']),
    label: user.display_name || user.username,
  };
}
