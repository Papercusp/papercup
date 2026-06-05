/**
 * Curation dedup-memory — the curator-operator's "already surfaced" record
 * (plan `curator-operator-2026-06-04`, P0).
 *
 * Backs the salience policy's idempotency overlay: a `FleetSignal` whose id is
 * here (within the window) is suppressed so the operator doesn't re-nag the
 * SAME fact every tick. PG-backed (`harness_shared.operator_curation_log`,
 * migration 150) so it's multi-tab / cross-machine safe, mirroring
 * the old operator-dismissed-cache (retired with the scanner, D-005).
 *
 * This is de-dup memory, NOT a suppression list — a NEW escalation/blocker is
 * always surfaced (it just won't repeat). The raw item is always reachable via
 * the coord inbox + the drill-in `ref` (D-005).
 */
import { withWorkspace } from '@papercusp/db-org';
import { activeWorkspaceId } from '../workspace-registry';

/** How far back "already surfaced" looks. Beyond this, a still-relevant signal
 *  may re-surface as a reminder (the source still emits it). */
export const DEFAULT_SURFACED_WINDOW_MS = 24 * 60 * 60 * 1000; // 24h

export interface SurfacedEntry {
  /** The FleetSignal id that was surfaced/batched. */
  id: string;
  /** The signal kind (for audit / the reactive-graph view). */
  kind: string;
}

/**
 * The set of signal ids surfaced within `windowMs`. Passed to the salience
 * policy as `SalienceState.alreadySurfaced`.
 */
export async function loadRecentSurfaced(
  windowMs: number = DEFAULT_SURFACED_WINDOW_MS,
): Promise<Set<string>> {
  const workspaceId = activeWorkspaceId();
  const cutoffMs = Math.max(1, Math.floor(windowMs));
  const rows = await withWorkspace(workspaceId, async (tx) => {
    return tx<{ signal_id: string }[]>`
      SELECT signal_id
        FROM harness_shared.operator_curation_log
       WHERE workspace_id = ${workspaceId}
         AND surfaced_at > now() - (${cutoffMs}::bigint * interval '1 millisecond')
    `;
  });
  return new Set(rows.map((r) => r.signal_id));
}

/**
 * Record that these signals were surfaced/batched this tick. Idempotent upsert
 * (re-surfacing refreshes `surfaced_at`). `policyVersion` is stamped for the
 * "why did this surface?" audit.
 */
export async function recordSurfaced(
  entries: readonly SurfacedEntry[],
  policyVersion: string,
): Promise<void> {
  if (entries.length === 0) return;
  const workspaceId = activeWorkspaceId();
  await withWorkspace(workspaceId, async (tx) => {
    for (const e of entries) {
      await tx`
        INSERT INTO harness_shared.operator_curation_log
          (workspace_id, signal_id, kind, policy_version, surfaced_at)
        VALUES (${workspaceId}, ${e.id}, ${e.kind}, ${policyVersion}, now())
        ON CONFLICT (workspace_id, signal_id) DO UPDATE
          SET surfaced_at = EXCLUDED.surfaced_at,
              kind = EXCLUDED.kind,
              policy_version = EXCLUDED.policy_version
      `;
    }
  });
}

/** Diagnostic: recent curation-log rows (newest first), for the audit view. */
export async function listRecentCuration(limit = 50): Promise<
  { id: string; kind: string; policyVersion: string; surfacedAt: string }[]
> {
  const workspaceId = activeWorkspaceId();
  const cap = Math.max(1, Math.min(limit, 500));
  const rows = await withWorkspace(workspaceId, async (tx) => {
    return tx<{ signal_id: string; kind: string; policy_version: string; surfaced_at: string }[]>`
      SELECT signal_id, kind, policy_version, surfaced_at::text
        FROM harness_shared.operator_curation_log
       WHERE workspace_id = ${workspaceId}
       ORDER BY surfaced_at DESC
       LIMIT ${cap}
    `;
  });
  return rows.map((r) => ({
    id: r.signal_id,
    kind: r.kind,
    policyVersion: r.policy_version,
    surfacedAt: new Date(r.surfaced_at).toISOString(),
  }));
}
