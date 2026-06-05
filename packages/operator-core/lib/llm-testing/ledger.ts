/**
 * Claim ledger for parallel llm-test runners.
 *
 * Plan §0 / handoff §D item 3. Coordinates parallel runners so two
 * processes don't double-spend on the same (scenario × identity ×
 * matrix_index) tuple.
 *
 * Semantics:
 *   - `tryClaim()` inserts a row with a TTL. If the natural key is
 *     already held, returns { ok: false, holder }.
 *   - `heartbeat()` extends an existing claim's expires_at. Caller
 *     should heartbeat at least every TTL/2.
 *   - `release()` deletes the claim. Must be called from a finally
 *     block; if the process crashes, the TTL expires and the next
 *     `tryClaim()` reaps the row first.
 *   - `reapExpired()` removes claims whose expires_at < now(). Called
 *     opportunistically at acquire time.
 *
 * Schema lives in libs/papercusp/libs/db/sql/074-llm-test-claims.sql.
 */

import { hostname } from 'node:os';

import postgres from 'postgres';

import { getHarnessAdminUrl } from '../embedded-pg-discovery';

let pool: ReturnType<typeof postgres> | null = null;
function db() {
  if (!pool) pool = postgres(getHarnessAdminUrl(), { max: 2, prepare: false });
  return pool;
}

const DEFAULT_TTL_SEC = 600; // 10 min — covers a slow 6-turn scenario

/** Stable default owner id when callers don't pass one. */
export function defaultOwnerId(): string {
  return `${hostname()}:${process.pid}`;
}

export interface ClaimKeyInput {
  scenarioId: string;
  identityHash: string;
  matrixIndex?: number;
}

export function buildClaimKey(input: ClaimKeyInput): string {
  return `${input.scenarioId}@${input.identityHash.slice(0, 16)}#${input.matrixIndex ?? 0}`;
}

export interface ClaimHolder {
  ownerId: string;
  acquiredAt: Date;
  expiresAt: Date;
}

export type ClaimResult =
  | { ok: true; claimKey: string; ownerId: string; expiresAt: Date }
  | { ok: false; reason: 'busy'; holder: ClaimHolder };

export interface TryClaimOpts extends ClaimKeyInput {
  ownerId?: string;
  ttlSec?: number;
  metadata?: Record<string, unknown>;
}

export async function tryClaim(opts: TryClaimOpts): Promise<ClaimResult> {
  const sql = db();
  const ownerId = opts.ownerId ?? defaultOwnerId();
  const ttlSec = opts.ttlSec ?? DEFAULT_TTL_SEC;
  const claimKey = buildClaimKey(opts);
  const expiresAt = new Date(Date.now() + ttlSec * 1000);

  // Reap any expired holders first so we don't block on a dead claim.
  await sql`DELETE FROM harness_shared.llm_test_claims WHERE expires_at < now()`;

  // INSERT ... ON CONFLICT DO NOTHING returns 0 rows when a holder
  // already exists. We RETURNING the row we wanted to learn whether it
  // was actually inserted vs. existing.
  const rows = await sql<Array<{ owner_id: string; acquired_at: Date; expires_at: Date }>>`
    INSERT INTO harness_shared.llm_test_claims
      (claim_key, owner_id, scenario_id, identity_hash, matrix_index, expires_at, metadata_json)
    VALUES
      (${claimKey}, ${ownerId}, ${opts.scenarioId}, ${opts.identityHash},
       ${opts.matrixIndex ?? null}, ${expiresAt}, ${sql.json(opts.metadata ?? {})})
    ON CONFLICT (claim_key) DO NOTHING
    RETURNING owner_id, acquired_at, expires_at
  `;

  if (rows.length > 0) {
    return { ok: true, claimKey, ownerId, expiresAt };
  }

  // Conflict — fetch holder for the error envelope.
  const holders = await sql<Array<{ owner_id: string; acquired_at: Date; expires_at: Date }>>`
    SELECT owner_id, acquired_at, expires_at
    FROM harness_shared.llm_test_claims
    WHERE claim_key = ${claimKey}
  `;
  const holder = holders[0];
  if (!holder) {
    // Race: holder expired between our reap and our select. One retry.
    return tryClaim(opts);
  }
  return {
    ok: false,
    reason: 'busy',
    holder: {
      ownerId: holder.owner_id,
      acquiredAt: holder.acquired_at,
      expiresAt: holder.expires_at,
    },
  };
}

export async function heartbeat(claimKey: string, ownerId: string, ttlSec = DEFAULT_TTL_SEC): Promise<boolean> {
  const sql = db();
  const expiresAt = new Date(Date.now() + ttlSec * 1000);
  const rows = await sql<Array<{ claim_key: string }>>`
    UPDATE harness_shared.llm_test_claims
       SET expires_at = ${expiresAt}
     WHERE claim_key = ${claimKey}
       AND owner_id = ${ownerId}
    RETURNING claim_key
  `;
  return rows.length > 0;
}

export async function release(claimKey: string, ownerId: string): Promise<void> {
  const sql = db();
  await sql`
    DELETE FROM harness_shared.llm_test_claims
     WHERE claim_key = ${claimKey}
       AND owner_id = ${ownerId}
  `;
}

/** Manual reap entry point — usually not needed; tryClaim reaps inline. */
export async function reapExpired(): Promise<number> {
  const sql = db();
  const rows = await sql<Array<{ claim_key: string }>>`
    DELETE FROM harness_shared.llm_test_claims
     WHERE expires_at < now()
    RETURNING claim_key
  `;
  return rows.length;
}
