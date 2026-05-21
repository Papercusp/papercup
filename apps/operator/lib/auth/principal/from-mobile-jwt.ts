/**
 * Mobile JWT → Principal resolver.
 *
 * Reads the `Authorization: Bearer <token>` header, validates the HS256
 * signature via `verifyDeviceToken`, checks the device has not been
 * revoked, and produces a `Principal` with `kind: 'mobile'`,
 * `authMethod: 'jwt'`, `trust: 'verified'`.
 *
 * `kind: 'mobile'` (vs `'user', authMethod: 'jwt'`) is the RFC's Q2
 * answer — surfaces the device dimension. "Mobile-only" / "desktop-only"
 * gates are real and easier expressed kind-shaped.
 *
 * Async + revocation-aware as of Phase E4 (endpoint-unification-2026-05-21):
 * the legacy `deviceAuth()` Hono middleware checked `isRevoked` before
 * admitting a device. As the 33 mobile routes migrate off that middleware
 * onto `requirePrincipal`, the revocation check has to live here or a
 * revoked device would still resolve to a valid principal. The
 * `.catch(() => false)` fail-open on a transient PG error matches the
 * legacy middleware's behavior exactly.
 *
 * Phase 3b step 2 (principal-rfc-2026-05-20.md §5c).
 */

import type { Principal } from '@papercusp/agent-mcp';
import { verifyDeviceToken } from '../../mobile-jwt';
import { isRevoked } from '../../mobile-device-store';

export async function principalFromMobileJwt(headers: Headers): Promise<Principal | null> {
  const auth = headers.get('authorization');
  if (!auth) return null;
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : auth;
  if (!token) return null;
  const claims = verifyDeviceToken(token);
  if (!claims) return null;
  // Revocation check — parity with the legacy `deviceAuth()` middleware.
  // Fail-open on a PG hiccup (`.catch(() => false)`), exactly as the
  // legacy middleware did; a transient DB outage must not lock out
  // every paired device.
  if (await isRevoked(claims.sub).catch(() => false)) return null;
  return {
    kind: 'mobile',
    slug: claims.sub,
    workspaceId: claims.workspace_id,
    authMethod: 'jwt',
    trust: 'verified',
    // Mobile devices carry a fixed capability set in v1 — Track A will
    // mint per-device capabilities when the data model supports it. For
    // now they get the mobile UX surface (voice, pair, harness read).
    capabilities: new Set(['mobile:*', 'voice:*', 'harness:read']),
    ...(claims.user_email ? { label: claims.user_email } : {}),
  };
}
