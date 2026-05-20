/**
 * Mobile JWT → Principal resolver.
 *
 * Reads the `Authorization: Bearer <token>` header (or any `*-token`
 * header the mobile WS / SSE path uses), validates the HS256 signature
 * via `verifyDeviceToken`, and produces a `Principal` with
 * `kind: 'mobile'`, `authMethod: 'jwt'`, `trust: 'verified'`.
 *
 * `kind: 'mobile'` (vs `'user', authMethod: 'jwt'`) is the RFC's Q2
 * answer — surfaces the device dimension. "Mobile-only" / "desktop-only"
 * gates are real and easier expressed kind-shaped.
 *
 * Phase 3b step 2 (principal-rfc-2026-05-20.md §5c).
 */

import type { Principal } from '@papercusp/agent-mcp';
import { verifyDeviceToken } from '../../mobile-jwt';

export function principalFromMobileJwt(headers: Headers): Principal | null {
  const auth = headers.get('authorization');
  if (!auth) return null;
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : auth;
  if (!token) return null;
  const claims = verifyDeviceToken(token);
  if (!claims) return null;
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
