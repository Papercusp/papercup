/**
 * OAuth state token — HMAC-signed URL parameter, single-use server-side nonce.
 *
 * Spec: /docs/snapshots/oauth-integration#state-design.
 *
 * State lives in the URL `state` param end-to-end (no cookies). Each
 * concurrent OAuth flow has independent state. The state token claims:
 *   { plugin, harness, field, providerHost, exp, nonce }
 *
 * The nonce is server-side single-use: the first callback consumes it
 * and subsequent callbacks with the same nonce are rejected.
 *
 * V1 substrate stores the nonce table in-memory (the operator is a
 * single-process server). V1.1 will move to PG so multi-instance
 * deployments work.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const STATE_VERSION = 1 as const;
const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 min

export interface StateClaims {
  plugin: string;
  harness: string;
  field: string;
  providerHost: string;
  /** Provider id (e.g. `github`). */
  provider: string;
}

interface SignedState extends StateClaims {
  v: typeof STATE_VERSION;
  exp: number;
  nonce: string;
}

let secretKey: Buffer | null = null;

function getSecret(): Buffer {
  if (secretKey) return secretKey;
  const env = process.env.PAPERCUSP_OAUTH_STATE_SECRET;
  if (env && env.length >= 32) {
    secretKey = Buffer.from(env, 'utf8');
  } else {
    // Dev fallback: process-lifetime random key. Restarting the process
    // invalidates in-flight states; that is acceptable for dev.
    secretKey = randomBytes(32);
  }
  return secretKey;
}

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(s: string): Buffer {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

/**
 * Sign a state token. The returned string is opaque from a security
 * perspective — caller treats it as a single token, not parseable.
 */
export function signState(claims: StateClaims, ttlMs = DEFAULT_TTL_MS): string {
  const payload: SignedState = {
    ...claims,
    v: STATE_VERSION,
    exp: Date.now() + ttlMs,
    nonce: b64url(randomBytes(16)),
  };
  const body = b64url(Buffer.from(JSON.stringify(payload), 'utf8'));
  const sig = b64url(createHmac('sha256', getSecret()).update(body).digest());
  rememberNonce(payload.nonce, payload.exp);
  return `${body}.${sig}`;
}

interface NonceRecord {
  exp: number;
  consumed: boolean;
}

const nonceTable = new Map<string, NonceRecord>();

function rememberNonce(nonce: string, exp: number): void {
  nonceTable.set(nonce, { exp, consumed: false });
  // Opportunistic GC.
  if (nonceTable.size > 1000) sweepNonces();
}

function sweepNonces(): void {
  const now = Date.now();
  for (const [k, v] of nonceTable) {
    if (v.exp < now) nonceTable.delete(k);
  }
}

export interface VerifyStateResult {
  ok: boolean;
  claims?: StateClaims;
  error?: 'malformed' | 'bad-signature' | 'expired' | 'unknown-nonce' | 'already-consumed';
}

/**
 * Verify a state token AND consume its nonce. A successful verify is
 * destructive — calling it twice with the same token returns
 * `already-consumed`.
 */
export function verifyAndConsumeState(token: string): VerifyStateResult {
  if (!token || typeof token !== 'string' || !token.includes('.')) {
    return { ok: false, error: 'malformed' };
  }
  const [body, sig] = token.split('.', 2);
  if (!body || !sig) return { ok: false, error: 'malformed' };

  const expectedSig = b64url(createHmac('sha256', getSecret()).update(body).digest());
  const a = Buffer.from(sig);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, error: 'bad-signature' };
  }

  let payload: SignedState;
  try {
    payload = JSON.parse(b64urlDecode(body).toString('utf8'));
  } catch {
    return { ok: false, error: 'malformed' };
  }
  if (payload.v !== STATE_VERSION) return { ok: false, error: 'malformed' };
  if (payload.exp < Date.now()) return { ok: false, error: 'expired' };

  const nonce = nonceTable.get(payload.nonce);
  if (!nonce) return { ok: false, error: 'unknown-nonce' };
  if (nonce.consumed) return { ok: false, error: 'already-consumed' };
  nonce.consumed = true;

  return {
    ok: true,
    claims: {
      plugin: payload.plugin,
      harness: payload.harness,
      field: payload.field,
      providerHost: payload.providerHost,
      provider: payload.provider,
    },
  };
}

/** Test-only: clear all in-memory state. */
export function __resetForTest(): void {
  nonceTable.clear();
  secretKey = null;
}
