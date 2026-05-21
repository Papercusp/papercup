/**
 * Shared helpers for the migrated `/api/mobile/*` routes.
 *
 * Phase E4 (endpoint-unification-2026-05-21) — these routes were ported
 * off the legacy `_hono/mobile.ts` Hono router. There the JWT was
 * verified by the `deviceAuth()` middleware which stashed `deviceClaims`
 * on the Hono context; here the route-stack's auth step resolves the
 * mobile `Principal` via `requirePrincipal`, and the handler reads it
 * off `ctx.principal`.
 *
 * Claim → Principal field map:
 *   claims.sub          → principal.slug        (the device id)
 *   claims.workspace_id → principal.workspaceId
 *   claims.user_email   → principal.label
 */

import type { Principal } from '@papercusp/agent-mcp';
import type { PrincipalRequirements } from '@/lib/auth/require-principal';
import type { RouteContext } from '../../define-route';

/**
 * Auth gate for a JWT-authenticated mobile route. The route-stack's
 * auth step rejects anything that doesn't resolve to `kind: 'mobile'`,
 * so the handler can treat `ctx.principal` as a present mobile principal.
 */
export const MOBILE_AUTH: PrincipalRequirements = { kind: ['mobile'] };

/**
 * Narrow a mobile-gated route's principal to non-null. Safe because
 * `MOBILE_AUTH` makes the route-stack throw a 403 before the handler
 * runs if the principal isn't a mobile device — this is just the
 * type-level assertion of that runtime guarantee.
 */
export function mobilePrincipal(ctx: RouteContext<unknown>): Principal {
  if (!ctx.principal) {
    throw new Error('mobile route handler reached without a resolved principal');
  }
  return ctx.principal;
}

/** Loopback host names — for the desktop-only `/mobile/desktop/*` gate. */
export const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** True when the request's Host header resolves to a loopback name. */
export function isLoopbackHost(req: Request): boolean {
  const host = (req.headers.get('host') ?? '').split(':')[0].toLowerCase();
  return LOOPBACK_HOSTS.has(host);
}
