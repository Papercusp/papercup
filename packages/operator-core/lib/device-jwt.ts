/**
 * Mobile device JWTs. Signed HS256 with MOBILE_JWT_SECRET.
 *
 * Claims shape:
 *   sub:           device_id (uuid)
 *   workspace_id:  bound workspace (matches PG-RLS app.workspace_id GUC)
 *   device_kind:   'mobile' (drives row visibility in libs/zero-harness/queries.ts)
 *   user_email:    optional; set when device is paired with an authenticated session
 *   iat / exp:     standard
 *
 * Secret rotation: change MOBILE_JWT_SECRET, all current device tokens become invalid.
 * Acceptable: phones re-pair via QR. No graceful key rotation in v1.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Resolve the JWT secret lazily, on first use.
 *
 * Module-load throw was breaking `next build`: Next 16's "Collecting page
 * data" phase imports every route's module under `NODE_ENV=production`,
 * including this one — even though the build host doesn't need to *sign*
 * tokens. The throw aborted page-data collection and the build skipped
 * standalone bundle generation. Deferring the check until a token is
 * actually signed/verified keeps the module side-effect-free at import
 * time so build hosts (and any route that imports this transitively but
 * doesn't actually use it) don't need MOBILE_JWT_SECRET.
 */
let _secret: string | null = null;
function getSecret(): string {
  if (_secret) return _secret;
  const s = process.env.MOBILE_JWT_SECRET;
  if (s && s.length >= 32) {
    _secret = s;
    return _secret;
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error('MOBILE_JWT_SECRET must be set (>=32 chars) in production');
  }
  // Dev: derive a stable per-process secret. Rotates on restart, fine for dev.
  _secret = randomBytes(32).toString('base64url');
  return _secret;
}

export interface DeviceClaims {
  sub: string;
  workspace_id: string;
  device_kind: 'mobile';
  user_email?: string;
  iat: number;
  exp: number;
}

const TTL_DAYS = 365;
const TTL_MS = TTL_DAYS * 24 * 3600 * 1000;

const b64 = (b: Buffer | string) =>
  Buffer.from(b).toString('base64url');

export function signDeviceToken(
  partial: Omit<DeviceClaims, 'iat' | 'exp'>,
): string {
  const header = b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const now = Math.floor(Date.now() / 1000);
  const claims: DeviceClaims = {
    ...partial,
    iat: now,
    exp: now + Math.floor(TTL_MS / 1000),
  };
  const payload = b64(JSON.stringify(claims));
  const sig = b64(
    createHmac('sha256', getSecret()).update(`${header}.${payload}`).digest(),
  );
  return `${header}.${payload}.${sig}`;
}

export function verifyDeviceToken(token: string): DeviceClaims | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, payload, sig] = parts;
  const expected = b64(
    createHmac('sha256', getSecret()).update(`${header}.${payload}`).digest(),
  );
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  let claims: DeviceClaims;
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
  } catch {
    return null;
  }
  if (claims.exp < Math.floor(Date.now() / 1000)) return null;
  if (claims.device_kind !== 'mobile') return null;
  return claims;
}

// The `deviceAuth()` Hono middleware was deleted in Phase E5
// (endpoint-unification-2026-05-21) along with `_hono/mobile.ts`. The
// device JWT is now resolved by `requirePrincipal` via the
// `principalFromDeviceJwt` resolver, which carries the same
// signature-verify + `isRevoked` check the middleware did.
// `signDeviceToken` / `verifyDeviceToken` above remain — the resolver
// and the `/device/*` `defineTool`s use them.
