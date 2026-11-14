/**
 * Same-turn proof for file-read claims in work-item carry notes.
 *
 * A successful `capability:read` ledger row proves only the exact absolute
 * `file_path` it was called with. Nested reads need two additional links: the
 * successful `code:run` invocation must own a successful execution-trace row,
 * and that trace's settled child dispatch id must match the child's telemetry
 * row. Missing or ambiguous evidence is unavailable, never proof.
 */

import { isAbsolute } from 'node:path';
import { boundedPgReadTxn } from './pg-read-query';

export const READ_PROOF_SCAN_ROWS = 64;
export const READ_PROOF_READ_TIMEOUT_MS = 5_000;
export const READ_PROOF_READ_ACQUIRE_TIMEOUT_MS = 2_000;
export const READ_PROOF_READ_LOCK_TIMEOUT_MS = 1_000;

export interface SuccessfulReadProof {
  path: string;
  source: 'direct' | 'nested-code-run';
}

export interface ReadProofOptions {
  workspaceId?: string | null;
  coordOwnerId?: string | null;
  /** The current transcript turn ref, resolved by the host rather than authored by the caller. */
  turnRef?: string | null;
  limit?: number;
}

function normalizeToolName(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/^mcp__.+?__/, '').replace(/_/g, ':');
}

function parseObject(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'string') {
    try {
      return parseObject(JSON.parse(value));
    } catch {
      return null;
    }
  }
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function absoluteReadPath(toolName: unknown, rawArgs: unknown): string | null {
  if (normalizeToolName(toolName) !== 'capability:read') return null;
  const args = parseObject(rawArgs);
  const path = args?.file_path;
  if (typeof path !== 'string' || path.includes('\0') || !isAbsolute(path)) return null;
  return path;
}

function turnStartIso(turnRef: string | null | undefined): string | null {
  if (!turnRef) return null;
  const match = /^\[turn:[^@\]\r\n]+@([^\]\r\n]+)\]$/.exec(turnRef.trim());
  if (!match) return null;
  const timestamp = Date.parse(match[1]);
  if (!Number.isFinite(timestamp) || timestamp > Date.now()) return null;
  return new Date(timestamp).toISOString();
}

/**
 * Return successful, exact-path reads since the host-resolved current turn.
 * `null` means the bounded ledger read was unavailable; callers must keep the
 * advisory in that case. An empty array is a successful read with no proof.
 */
export async function readSuccessfulReadProofs(
  options: ReadProofOptions,
): Promise<SuccessfulReadProof[] | null> {
  const workspaceId = options.workspaceId?.trim();
  const coordOwnerId = options.coordOwnerId?.trim();
  const since = turnStartIso(options.turnRef);
  if (!workspaceId || !coordOwnerId || !since) return null;

  const limit = Math.min(Math.max(options.limit ?? READ_PROOF_SCAN_ROWS, 1), READ_PROOF_SCAN_ROWS);
  try {
    const { getOrgPg } = await import('@papercusp/db-org');
    const { sql } = getOrgPg();
    const rows = await boundedPgReadTxn(async (tx) => await tx<
      Array<{ source: string; args_json: unknown }>
    >`
      WITH invocation_window AS MATERIALIZED (
        SELECT workspace_id, coord_owner_id, spawn_id, tool_name, status,
               args_json, metadata_json, invoked_at
          FROM harness_shared.tool_invocations
         WHERE workspace_id = ${workspaceId}
           AND coord_owner_id = ${coordOwnerId}
           AND invoked_at >= ${since}::timestamptz
           AND tool_name = ANY(${['capability:read', 'code:run']})
         ORDER BY invoked_at DESC
         LIMIT ${limit}
      ), direct_reads AS (
        SELECT 'direct'::text AS source, args_json
          FROM invocation_window
         WHERE tool_name = 'capability:read'
           AND status = 'ok'
           AND COALESCE(metadata_json->>'spillFailed', 'false') <> 'true'
           AND COALESCE(metadata_json->>'spillPending', 'false') <> 'true'
      ), unambiguous_code_run_receipts AS MATERIALIZED (
        SELECT run.execution_trace #>> '{runEvidence,invocationId}' AS parent_call_id
          FROM harness_shared.code_recipe_runs run
         WHERE run.workspace_id = ${workspaceId}
           AND run.ts >= ${since}::timestamptz
           AND NULLIF(run.execution_trace #>> '{runEvidence,invocationId}', '') IS NOT NULL
         GROUP BY run.execution_trace #>> '{runEvidence,invocationId}'
        HAVING COUNT(DISTINCT run.execution_trace) = 1
           AND bool_and(run.success)
           AND bool_and(run.execution_trace #>> '{runEvidence,executed}' = 'true')
      ), successful_code_runs AS MATERIALIZED (
        SELECT DISTINCT parent.spawn_id, run.execution_trace
          FROM invocation_window parent
          JOIN unambiguous_code_run_receipts receipts
            ON receipts.parent_call_id = parent.metadata_json->'otel'->>'callId'
          JOIN harness_shared.code_recipe_runs run
            ON run.workspace_id = parent.workspace_id
           AND run.execution_trace #>> '{runEvidence,invocationId}' = receipts.parent_call_id
           AND run.ts >= ${since}::timestamptz
         WHERE parent.tool_name = 'code:run'
           AND parent.status = 'ok'
           AND parent.metadata_json->>'effectiveStatus' = 'ok'
      ), nested_dispatches AS (
        SELECT parent.spawn_id, calls.runtime_call->>'dispatchCallId' AS child_call_id
          FROM successful_code_runs parent
          CROSS JOIN LATERAL jsonb_array_elements(
            COALESCE(parent.execution_trace #> '{toolGraph,runtimeCalls}', '[]'::jsonb)
          ) AS calls(runtime_call)
         WHERE calls.runtime_call->>'tool' = 'capability:read'
           AND calls.runtime_call->>'disposition' = 'settled'
           AND NULLIF(calls.runtime_call->>'dispatchCallId', '') IS NOT NULL
      ), nested_reads AS (
        SELECT 'nested-code-run'::text AS source, child.args_json
          FROM nested_dispatches linked
          JOIN invocation_window child
            ON child.spawn_id = linked.spawn_id
           AND child.metadata_json->'otel'->>'callId' = linked.child_call_id
         WHERE child.tool_name = 'capability:read'
           AND child.status = 'ok'
           AND COALESCE(child.metadata_json->>'spillFailed', 'false') <> 'true'
           AND COALESCE(child.metadata_json->>'spillPending', 'false') <> 'true'
      )
      SELECT source, args_json FROM direct_reads
      UNION ALL
      SELECT source, args_json FROM nested_reads
      LIMIT ${limit}
    `, {
      client: sql,
      timeoutMs: READ_PROOF_READ_TIMEOUT_MS,
      acquireTimeoutMs: READ_PROOF_READ_ACQUIRE_TIMEOUT_MS,
      lockTimeoutMs: READ_PROOF_READ_LOCK_TIMEOUT_MS,
      acquirePool: 'org-admin',
    });

    const proofs = new Map<string, SuccessfulReadProof>();
    for (const row of rows) {
      const path = absoluteReadPath('capability:read', row.args_json);
      if (!path || (row.source !== 'direct' && row.source !== 'nested-code-run')) continue;
      proofs.set(`${row.source}\0${path}`, { path, source: row.source });
    }
    return [...proofs.values()];
  } catch {
    return null;
  }
}
