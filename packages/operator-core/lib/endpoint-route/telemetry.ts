/**
 * Route-invocation telemetry — R2.
 *
 * Writes one `harness_shared.route_invocations` row per `defineTool`
 * call (migration 077). Best-effort + fire-and-forget: the route-stack
 * calls `recordRouteInvocation` from its `finally` and does not await —
 * a telemetry failure must never affect the response.
 *
 * Honors `def.sampleRate` (0..1, default 1). High-frequency polled
 * routes set it < 1; pure transport routes set it 0 (never recorded).
 *
 * Plan: apps/operator/docs/plans/endpoint-route-migration-2026-05-20.md §6 R2
 */

import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../workspace-registry';
import type { RouteExecution } from './route-stack';

/**
 * Record one route invocation. Fire-and-forget — kicks off the PG write
 * and returns immediately. Sampling + all failure handling are internal.
 */
export function recordRouteInvocation(exec: RouteExecution): void {
  const sampleRate = exec.def.sampleRate ?? 1;
  if (sampleRate <= 0) return;
  if (sampleRate < 1 && Math.random() >= sampleRate) return;

  // Snapshot everything off `exec` synchronously — `exec` is mutable and
  // the caller's `finally` may clear timers etc. right after this returns.
  const row = {
    method: exec.def.method,
    path: exec.def.path,
    status: exec.status,
    durationMs: Date.now() - exec.startedAt,
    principalKind: exec.principal?.kind ?? null,
    principalAuthMethod: exec.principal?.authMethod ?? null,
    principalTrust: exec.principal?.trust ?? null,
    errorMessage: exec.status === 'error' || exec.status === 'timeout' ? exec.status : null,
  };

  void (async () => {
    try {
      const workspaceId = activeWorkspaceId();
      const { sql } = getOrgPg();
      await sql.begin(async (tx) => {
        await tx.unsafe(`SELECT set_config('app.workspace_id', $1, true)`, [workspaceId]);
        await tx.unsafe(
          `INSERT INTO harness_shared.route_invocations
             (workspace_id, method, path, status, duration_ms,
              principal_kind, principal_auth_method, principal_trust, error_message)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            workspaceId,
            row.method,
            row.path,
            row.status,
            row.durationMs,
            row.principalKind,
            row.principalAuthMethod,
            row.principalTrust,
            row.errorMessage,
          ],
        );
      });
    } catch (err) {
      // Best-effort: a telemetry write failure (PG down, table missing
      // on a not-yet-migrated dev DB) is logged once and swallowed.
      console.warn(
        `[route-telemetry] write failed for ${row.method} ${row.path}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  })();
}
