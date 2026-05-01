/**
 * PG-backed operator claim — distributed lock for `(harness, plugin)`
 * provision lifecycle. Prevents two operators (laptop + desktop) from
 * concurrently running setup against the same target.
 *
 * Contract:
 *   - acquire() returns ok=true if no claim exists or prior claim has
 *     expired (call sites prompt user about possible orphans in that case).
 *   - heartbeat() must be called every 30s while setup runs.
 *   - release() drops the claim on clean exit.
 *
 * Spec: /docs/snapshots/build-scripts#operator-claims.
 */

import { createHash, randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import { getOrgPg } from '@restart/db-org';

const CLAIM_TTL_SEC = 90;

function machineId(): string {
  return process.env.PAPERCUSP_MACHINE_ID ?? hostname();
}

function advisoryLockKey(harness: string, plugin: string): bigint {
  // Postgres advisory locks take a bigint key. We hash (harness, plugin)
  // and take 8 bytes worth — collisions are rare and benign (false-positive
  // serialization, never a missed mutex).
  const h = createHash('sha256').update(`${harness}:${plugin}`).digest();
  return h.readBigInt64BE(0);
}

export interface ClaimAcquisitionResult {
  ok: boolean;
  /** When `ok=false`, info about the claim holding us back. */
  conflict?: {
    machineId: string;
    pid: number;
    runId: string;
    scriptHash: string;
    claimedAt: string;
    secondsSinceHeartbeat: number;
    /** True when prior claim was expired — caller should prompt about orphans. */
    expired: boolean;
  };
  /** When `ok=true`, the run id the caller must pass to heartbeat()/release(). */
  runId?: string;
}

export async function ensureClaimsTable(): Promise<void> {
  const { sql } = getOrgPg();
  await sql`
    CREATE TABLE IF NOT EXISTS harness_shared.operator_claims (
      harness_slug TEXT NOT NULL,
      plugin_slug  TEXT NOT NULL,
      machine_id   TEXT NOT NULL,
      pid          INT  NOT NULL,
      run_id       TEXT NOT NULL,
      script_hash  TEXT NOT NULL,
      claimed_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at   TIMESTAMPTZ NOT NULL,
      PRIMARY KEY (harness_slug, plugin_slug)
    )
  `;
}

export async function acquireClaim(
  harness: string,
  plugin: string,
  scriptHash: string,
): Promise<ClaimAcquisitionResult> {
  await ensureClaimsTable();
  const { sql } = getOrgPg();
  const lockKey = advisoryLockKey(harness, plugin);
  const runId = randomBytes(8).toString('hex');
  const me = machineId();
  const pid = process.pid;

  // Acquire advisory xact lock (released at txn end automatically).
  return (await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(${lockKey.toString()}::bigint)`;
    const existing = (await tx`
      SELECT machine_id, pid, run_id, script_hash, claimed_at, expires_at
      FROM harness_shared.operator_claims
      WHERE harness_slug = ${harness} AND plugin_slug = ${plugin}
    `) as unknown as Array<{
      machine_id: string;
      pid: number;
      run_id: string;
      script_hash: string;
      claimed_at: Date;
      expires_at: Date;
    }>;
    const now = Date.now();
    if (existing.length > 0) {
      const e = existing[0];
      const expiresMs = e.expires_at.getTime();
      const expired = expiresMs <= now;
      if (!expired) {
        return {
          ok: false,
          conflict: {
            machineId: e.machine_id,
            pid: e.pid,
            runId: e.run_id,
            scriptHash: e.script_hash,
            claimedAt: e.claimed_at.toISOString(),
            secondsSinceHeartbeat: Math.round((now - (expiresMs - CLAIM_TTL_SEC * 1000)) / 1000),
            expired: false,
          },
        };
      }
      // Expired — caller wants to know orphans may exist.
      await tx`
        DELETE FROM harness_shared.operator_claims
        WHERE harness_slug = ${harness} AND plugin_slug = ${plugin}
      `;
      await tx`
        INSERT INTO harness_shared.operator_claims (
          harness_slug, plugin_slug, machine_id, pid, run_id, script_hash, expires_at
        ) VALUES (
          ${harness}, ${plugin}, ${me}, ${pid}, ${runId}, ${scriptHash},
          now() + (${CLAIM_TTL_SEC} || ' seconds')::interval
        )
      `;
      return {
        ok: true,
        runId,
        conflict: {
          machineId: e.machine_id,
          pid: e.pid,
          runId: e.run_id,
          scriptHash: e.script_hash,
          claimedAt: e.claimed_at.toISOString(),
          secondsSinceHeartbeat: Math.round((now - expiresMs) / 1000) + CLAIM_TTL_SEC,
          expired: true,
        },
      };
    }
    await tx`
      INSERT INTO harness_shared.operator_claims (
        harness_slug, plugin_slug, machine_id, pid, run_id, script_hash, expires_at
      ) VALUES (
        ${harness}, ${plugin}, ${me}, ${pid}, ${runId}, ${scriptHash},
        now() + (${CLAIM_TTL_SEC} || ' seconds')::interval
      )
    `;
    return { ok: true, runId };
  })) as ClaimAcquisitionResult;
}

export async function heartbeatClaim(harness: string, plugin: string, runId: string): Promise<void> {
  const { sql } = getOrgPg();
  await sql`
    UPDATE harness_shared.operator_claims
    SET expires_at = now() + (${CLAIM_TTL_SEC} || ' seconds')::interval
    WHERE harness_slug = ${harness}
      AND plugin_slug = ${plugin}
      AND run_id = ${runId}
  `;
}

export async function releaseClaim(harness: string, plugin: string, runId: string): Promise<void> {
  const { sql } = getOrgPg();
  await sql`
    DELETE FROM harness_shared.operator_claims
    WHERE harness_slug = ${harness}
      AND plugin_slug = ${plugin}
      AND run_id = ${runId}
  `;
}

/**
 * Schedule background heartbeats for the lifetime of the script run.
 * Returns a cancel function.
 */
export function startHeartbeatLoop(harness: string, plugin: string, runId: string): () => void {
  const interval = setInterval(() => {
    heartbeatClaim(harness, plugin, runId).catch(() => {
      // Heartbeat failures are tolerated — the claim TTL gives a 60s grace.
    });
  }, 30_000);
  return () => clearInterval(interval);
}
