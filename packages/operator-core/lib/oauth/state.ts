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
 * Storage: `harness_shared.oauth_nonces` (PG, migration 030). Was
 * previously a process-local Map, lost across restarts and incompatible
 * with multi-instance deploys. Per the prior module doc's V1.1 TODO.
 *
 * Both helpers are now async because the nonce read/write is a PG
 * round-trip; callers in the two oauth routes were updated.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { getOrgPg } from '@papercusp/db-org';

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

async function rememberNonce(nonce: string, exp: number): Promise<void> {
  const { sql } = getOrgPg();
  const now = Date.now();
  await sql`
    INSERT INTO harness_shared.oauth_nonces (nonce, exp_ms, consumed, created_at)
    VALUES (${nonce}, ${exp}, false, ${now})
    ON CONFLICT (nonce) DO NOTHING
  `;
  // Opportunistic GC: if the table is larger than 1000 rows, sweep expired
  // entries. Cheap because of the exp_ms index.
  const cnt = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM harness_shared.oauth_nonces`;
  if ((cnt[0]?.n ?? 0) > 1000) {
    await sql`DELETE FROM harness_shared.oauth_nonces WHERE exp_ms < ${now}`;
  }
}

/**
 * Sign a state token. The returned string is opaque from a security
 * perspective — caller treats it as a single token, not parseable.
 */
export async function signState(claims: StateClaims, ttlMs = DEFAULT_TTL_MS): Promise<string> {
  const payload: SignedState = {
    ...claims,
    v: STATE_VERSION,
    exp: Date.now() + ttlMs,
    nonce: b64url(randomBytes(16)),
  };
  const body = b64url(Buffer.from(JSON.stringify(payload), 'utf8'));
  const sig = b64url(createHmac('sha256', getSecret()).update(body).digest());
  await rememberNonce(payload.nonce, payload.exp);
  return `${body}.${sig}`;
}

export interface VerifyStateResult {
  ok: boolean;
  claims?: StateClaims;
  error?: 'malformed' | 'bad-signature' | 'expired' | 'unknown-nonce' | 'already-consumed';
}

/**
 * Verify a state token AND consume its nonce. A successful verify is
 * destructive — calling it twice with the same token returns
 * `already-consumed`. The consumption is a single transactional
 * UPDATE … WHERE consumed = false RETURNING — atomic against concurrent
 * callbacks racing to claim the same nonce.
 */
export async function verifyAndConsumeState(token: string): Promise<VerifyStateResult> {
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

  const { sql } = getOrgPg();
  // Single round-trip atomic claim. CTE first checks existence; UPDATE
  // claims if not yet consumed. The two RETURNING paths let us
  // distinguish unknown-nonce from already-consumed.
  const claimed = await sql<{ status: 'claimed' | 'already' | 'unknown' }[]>`
    WITH lookup AS (
      SELECT consumed FROM harness_shared.oauth_nonces WHERE nonce = ${payload.nonce}
    ),
    upd AS (
      UPDATE harness_shared.oauth_nonces
         SET consumed = true
       WHERE nonce = ${payload.nonce} AND consumed = false
       RETURNING true AS ok
    )
    SELECT CASE
      WHEN NOT EXISTS (SELECT 1 FROM lookup) THEN 'unknown'::text
      WHEN EXISTS (SELECT 1 FROM upd) THEN 'claimed'::text
      ELSE 'already'::text
    END AS status
  `;
  const status = claimed[0]?.status ?? 'unknown';
  if (status === 'unknown') return { ok: false, error: 'unknown-nonce' };
  if (status === 'already') return { ok: false, error: 'already-consumed' };

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

/**
 * Test-only: drop the in-process secret-key cache and DELETE all rows
 * in oauth_nonces. The DELETE is destructive across the whole table,
 * so don't use this in any non-test path.
 */
export async function __resetForTest(): Promise<void> {
  secretKey = null;
  const { sql } = getOrgPg();
  await sql`DELETE FROM harness_shared.oauth_nonces`;
}
