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

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { getOrgPg, generated } from '@papercusp/db-org';
import { eq, sql as dsql } from 'drizzle-orm';
// The signing PRIMITIVES (allowlist + canonicalize + HMAC) live in ONE shared
// module the orchestrator process imports too — so the rule can't drift between
// the two signers (unify-launch-mechanics follow-on, signing dedup). Only the
// per-process PG key-loading (below) stays local.
import { canonicalizeSpawnParams, hmacSpawnBytes } from '@papercusp/orchestrator/spawn-signing-core';

const os = generated.operatorSecretsInHarnessShared;
const sf = generated.spawnSigVerificationFailuresInHarnessShared;

const KEY_NAME = 'spawn-signing-key';

interface KeyCache {
  buf: Buffer;
  /** rotated_at from PG; cache invalidates when PG's value advances. */
  rotatedAt: number;
  loadedAt: number;
}

const __g = globalThis as unknown as { __papercuspSpawnSigningKey?: KeyCache | null };

/** Force a key reload on next signSpawnParams/verifySpawnParams. */
export function _resetSpawnSigningKeyCache(): void {
  __g.__papercuspSpawnSigningKey = null;
}

/**
 * Read the current key from PG. Honors PG's rotated_at so a rotate on
 * any other operator process invalidates this process's cache on the
 * next call. One extra PG row per signing/verifying call — negligible
 * compared to the rest of the MCP-call cost, and necessary to avoid
 * the multi-instance cache-coherence bug surfaced by the audit (any
 * concurrent admin-rotate from a sibling process would otherwise leave
 * this process serving a stale key for up to 5 minutes).
 *
 * The 5-minute TTL is kept as a safety net in case rotated_at can't be
 * read for some reason — but the rotated_at check is the primary
 * mechanism.
 */
async function loadOrCreateKey(): Promise<Buffer> {
  const { db } = getOrgPg();
  const rows = await db
    .select({ value_b64: os.valueB64, rotated_at: os.rotatedAt })
    .from(os)
    .where(eq(os.name, KEY_NAME))
    .limit(1);
  if (rows.length > 0) {
    const rotatedAt = new Date(rows[0].rotated_at as never).getTime();
    const cached = __g.__papercuspSpawnSigningKey;
    if (
      cached &&
      cached.rotatedAt === rotatedAt &&
      Date.now() - cached.loadedAt < 5 * 60 * 1000
    ) {
      return cached.buf;
    }
    const buf = Buffer.from(rows[0].value_b64, 'base64');
    __g.__papercuspSpawnSigningKey = { buf, rotatedAt, loadedAt: Date.now() };
    return buf;
  }

  // First run: mint a new key and persist. INSERT … ON CONFLICT
  // (which can race if two operator processes start simultaneously).
  const fresh = randomBytes(32);
  const fresh_b64 = fresh.toString('base64');
  await db.insert(os).values({ name: KEY_NAME, valueB64: fresh_b64 }).onConflictDoNothing();
  // Re-read to win-or-lose deterministically.
  const after = await db
    .select({ valueB64: os.valueB64, rotated_at: os.rotatedAt })
    .from(os)
    .where(eq(os.name, KEY_NAME))
    .limit(1);
  const rotatedAt = new Date(after[0]!.rotated_at as never).getTime();
  const buf = Buffer.from(after[0]!.valueB64, 'base64');
  __g.__papercuspSpawnSigningKey = { buf, rotatedAt, loadedAt: Date.now() };
  return buf;
}

// canonicalize + hmac now come from the shared `@papercusp/orchestrator/spawn-signing-core`
// (imported above) — `canonicalizeSpawnParams` + `hmacSpawnBytes` — so this signer and the
// orchestrator's spawn-time signer use byte-identical rules. Local aliases keep the call
// sites below unchanged.
const canonicalize = canonicalizeSpawnParams;
const hmac = hmacSpawnBytes;

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
  // PERMANENT by default (exp=0 sentinel) — no time-based re-minting (owner directive
  // 2026-07-01). A POSITIVE ttlSec still mints a bounded URL for callers that explicitly want one.
  const ttlSec = opts.ttlSec ?? 0;
  const nowMs = opts.nowMs ?? Date.now();
  const exp = ttlSec > 0 ? Math.floor(nowMs / 1000) + ttlSec : 0;

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
  // exp === 0 is the PERMANENT sentinel (no time-based expiry). The sig still covers exp, so a
  // role-escalation rewrite still fails verification; only the TIME check is skipped. (2026-07-01:
  // the 24h TTL made agents' MCP URLs die daily and forced a re-mint that churned .mcp.json →
  // Claude Code re-approval → dark sessions. Revocation is now key-rotation, not expiry.)
  if (!Number.isFinite(exp) || exp < 0) return { ok: false, reason: 'invalid_exp' };
  if (exp !== 0 && exp < Math.floor(Date.now() / 1000)) return { ok: false, reason: 'expired' };

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
    const { db } = getOrgPg();
    await db.insert(sf).values({
      reason: rec.reason,
      claimedRole: rec.claimedRole ?? null,
      claimedHarness: rec.claimedHarness ?? null,
      claimedWorkspace: rec.claimedWorkspace ?? null,
      claimedSpawn: rec.claimedSpawn ?? null,
      expClaim: rec.expClaim ?? null,
      remoteAddr: rec.remoteAddr ?? null,
      userAgent: rec.userAgent ?? null,
    });
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
  const { db } = getOrgPg();
  const fresh_b64 = randomBytes(32).toString('base64');
  await db
    .insert(os)
    .values({ name: KEY_NAME, valueB64: fresh_b64, rotatedAt: dsql`now()` as any })
    .onConflictDoUpdate({
      target: os.name,
      set: { valueB64: dsql`EXCLUDED.value_b64`, rotatedAt: dsql`now()` },
    });
  _resetSpawnSigningKeyCache();
}
