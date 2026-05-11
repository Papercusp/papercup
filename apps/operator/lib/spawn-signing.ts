/**
 * HMAC signing + verification for per-spawn MCP URLs.
 *
 * Today, the per-spawn URL bakes (workspace, harness, role, run, spawn,
 * feature?, chunk?, parent_spawn?) into query params, and the dispatcher
 * trusts them. That makes role escalation a one-liner — a worker that
 * wants operator-tier access just rewrites `?role=worker` to
 * `?role=operator` and calls. See docs/endpoint-system/superuser-mode.mdx
 * for the doc-level threat acknowledgement.
 *
 * This module adds:
 *   1. A 32-byte signing key in harness_shared.operator_secrets
 *      (auto-created on first use). PG storage instead of a flat file
 *      so the agent can't `cat ~/.papercusp/<file>` it.
 *   2. `signSpawnParams(params)` — appends `exp` + `sig` (base64url
 *      HMAC-SHA256) to a canonicalized param set.
 *   3. `verifySpawnParams(url)` — returns ok / failure with reason.
 *
 * Threat model (what this defends against):
 *   - Prompt-injected worker that ATTEMPTS to rewrite URL params to
 *     claim a higher role. Verification fails because the sig is over
 *     the original params. **This is the realistic threat.**
 *
 * Threat model (what this does NOT defend against):
 *   - Same-UID code that knows enough to query PG for the key and
 *     re-sign arbitrary params. The agent runs as the operator's UID
 *     and has libpq access; HMAC is friction, not enforcement.
 *   - Reading another spawn's `.mcp.json` and replaying it. Each
 *     `.mcp.json` is fully valid for its `exp` window. Mitigations:
 *     per-spawn worktree dir mode 0700, short exp windows.
 *   - Long replay window. Default `exp` is 24h; for short-lived spawns
 *     pass a smaller `ttlSec`.
 *
 * Coarse revocation: UPDATE the row in operator_secrets with a new
 * value and bump the in-process cache (or restart the operator). Every
 * in-flight signed URL fails its next call. Use sparingly — the
 * orchestrator will need to re-spawn anything affected.
 *
 * Spec: see also docs/endpoint-system/superuser-mode.mdx and the
 * spawn-mcp.ts side in libs/papercusp/packages/orchestrator (the
 * minting end).
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { getOrgPg } from '@restart/db-org';
import {
  ensureOperatorSecretsTable,
  ensureSpawnSigVerificationFailuresTable,
} from './ensure-schema';

const KEY_NAME = 'spawn-signing-key';

/** Params that are part of the signed envelope. Order doesn't matter — */
/** the canonicalization sorts them. */
const SIGNED_PARAM_ALLOWLIST = new Set([
  'harness',
  'workspace',
  'role',
  'run',
  'spawn',
  'feature',
  'chunk',
  'parent_spawn',
  'exp',
]);

interface KeyCache {
  buf: Buffer;
  loadedAt: number;
}

const __g = globalThis as unknown as { __papercuspSpawnSigningKey?: KeyCache | null };

/** Force a key reload on next signSpawnParams/verifySpawnParams. */
export function _resetSpawnSigningKeyCache(): void {
  __g.__papercuspSpawnSigningKey = null;
}

async function loadOrCreateKey(): Promise<Buffer> {
  const cached = __g.__papercuspSpawnSigningKey;
  // Cache for 5 minutes so rotation propagates without restart.
  if (cached && Date.now() - cached.loadedAt < 5 * 60 * 1000) return cached.buf;

  await ensureOperatorSecretsTable();
  const { sql } = getOrgPg();
  const rows = await sql<{ value_b64: string }[]>`
    SELECT value_b64 FROM harness_shared.operator_secrets WHERE name = ${KEY_NAME} LIMIT 1
  `;
  if (rows.length > 0) {
    const buf = Buffer.from(rows[0].value_b64, 'base64');
    __g.__papercuspSpawnSigningKey = { buf, loadedAt: Date.now() };
    return buf;
  }

  // First run: mint a new key and persist. INSERT … ON CONFLICT
  // (which can race if two operator processes start simultaneously).
  const fresh = randomBytes(32);
  const fresh_b64 = fresh.toString('base64');
  await sql`
    INSERT INTO harness_shared.operator_secrets (name, value_b64)
    VALUES (${KEY_NAME}, ${fresh_b64})
    ON CONFLICT (name) DO NOTHING
  `;
  // Re-read to win-or-lose deterministically.
  const after = await sql<{ value_b64: string }[]>`
    SELECT value_b64 FROM harness_shared.operator_secrets WHERE name = ${KEY_NAME} LIMIT 1
  `;
  const buf = Buffer.from(after[0]!.value_b64, 'base64');
  __g.__papercuspSpawnSigningKey = { buf, loadedAt: Date.now() };
  return buf;
}

/**
 * Canonical string built from the signed-allowlist params (sorted by
 * name, joined with `&`, value-encoded with `encodeURIComponent`).
 * Ignores `sig` itself and any param not in the allowlist — a forger
 * can't sneak in extra signed params, and a verifier can't be tricked
 * by reordering. Rejects duplicate keys (would otherwise let a forger
 * append `&role=operator` AFTER the signed one and have the parser
 * pick the later value).
 */
function canonicalize(params: URLSearchParams): { ok: true; canonical: string } | { ok: false; reason: string } {
  const seen = new Set<string>();
  const pairs: Array<[string, string]> = [];
  for (const [k, v] of params.entries()) {
    if (k === 'sig') continue;
    if (!SIGNED_PARAM_ALLOWLIST.has(k)) continue;
    if (seen.has(k)) return { ok: false, reason: `duplicate_param:${k}` };
    seen.add(k);
    pairs.push([k, v]);
  }
  pairs.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return {
    ok: true,
    canonical: pairs.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&'),
  };
}

function hmac(key: Buffer, msg: string): Buffer {
  return createHmac('sha256', key).update(msg).digest();
}

export interface SignedSpawnParams {
  exp: number;
  sig: string;
}

/**
 * Sign a spawn URL's param set in place: appends `exp` and `sig` to
 * the URLSearchParams instance. `ttlSec` defaults to 24h. Returns the
 * appended values for callers that want to log them.
 */
export async function signSpawnParams(
  params: URLSearchParams,
  opts: { ttlSec?: number; nowMs?: number } = {},
): Promise<SignedSpawnParams> {
  const ttlSec = opts.ttlSec ?? 24 * 60 * 60;
  const nowMs = opts.nowMs ?? Date.now();
  const exp = Math.floor(nowMs / 1000) + ttlSec;

  params.set('exp', String(exp));
  // Strip any inbound `sig` before canonicalizing.
  params.delete('sig');

  const c = canonicalize(params);
  if (!c.ok) throw new Error(`spawn-signing: ${c.reason}`);

  const key = await loadOrCreateKey();
  const sig = hmac(key, c.canonical).toString('base64url');
  params.set('sig', sig);
  return { exp, sig };
}

export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * Verify a per-spawn URL's signature. Pass the whole URL (string or
 * URL); returns ok or a structured failure. On failure, callers should
 * log to spawn_sig_verification_failures (via `logVerificationFailure`)
 * and reject the request.
 */
export async function verifySpawnParams(input: URL | string): Promise<VerifyResult> {
  const u = typeof input === 'string' ? new URL(input) : input;
  const sig = u.searchParams.get('sig');
  const expRaw = u.searchParams.get('exp');
  if (!sig) return { ok: false, reason: 'missing_sig' };
  if (!expRaw) return { ok: false, reason: 'missing_exp' };

  const exp = Number(expRaw);
  if (!Number.isFinite(exp) || exp <= 0) return { ok: false, reason: 'invalid_exp' };
  if (exp < Math.floor(Date.now() / 1000)) return { ok: false, reason: 'expired' };

  const c = canonicalize(u.searchParams);
  if (!c.ok) return { ok: false, reason: c.reason };

  const key = await loadOrCreateKey();
  const expected = hmac(key, c.canonical);
  let provided: Buffer;
  try {
    provided = Buffer.from(sig, 'base64url');
  } catch {
    return { ok: false, reason: 'invalid_sig_encoding' };
  }
  if (provided.length !== expected.length) return { ok: false, reason: 'invalid_signature' };
  if (!timingSafeEqual(provided, expected)) return { ok: false, reason: 'invalid_signature' };
  return { ok: true };
}

export interface VerificationFailureRecord {
  reason: string;
  claimedRole?: string | null;
  claimedHarness?: string | null;
  claimedWorkspace?: string | null;
  claimedSpawn?: string | null;
  expClaim?: number | null;
  remoteAddr?: string | null;
  userAgent?: string | null;
}

/** Persist a verification failure for the dashboard / on-call review. */
export async function logVerificationFailure(rec: VerificationFailureRecord): Promise<void> {
  try {
    await ensureSpawnSigVerificationFailuresTable();
    const { sql } = getOrgPg();
    await sql`
      INSERT INTO harness_shared.spawn_sig_verification_failures
        (reason, claimed_role, claimed_harness, claimed_workspace, claimed_spawn, exp_claim, remote_addr, user_agent)
      VALUES
        (${rec.reason}, ${rec.claimedRole ?? null}, ${rec.claimedHarness ?? null}, ${rec.claimedWorkspace ?? null},
         ${rec.claimedSpawn ?? null}, ${rec.expClaim ?? null}, ${rec.remoteAddr ?? null}, ${rec.userAgent ?? null})
    `;
  } catch (err) {
    // Never fail the request because of audit-write failure; but log loud.
    // eslint-disable-next-line no-console
    console.warn('[spawn-signing] audit write failed', err);
  }
}

/**
 * Rotate the signing key. Every in-flight signed URL fails its next
 * call after this returns; the orchestrator will need to re-spawn.
 * Loopback + superuser-bearer gated at the route level.
 */
export async function rotateSpawnSigningKey(): Promise<void> {
  await ensureOperatorSecretsTable();
  const { sql } = getOrgPg();
  const fresh_b64 = randomBytes(32).toString('base64');
  await sql`
    INSERT INTO harness_shared.operator_secrets (name, value_b64, rotated_at)
    VALUES (${KEY_NAME}, ${fresh_b64}, now())
    ON CONFLICT (name) DO UPDATE
      SET value_b64 = EXCLUDED.value_b64, rotated_at = now()
  `;
  _resetSpawnSigningKeyCache();
}
