/**
 * P-008 (gate-verdict-liveness-and-repair-reliability-2026-08-31 / WI-1961441): the durable,
 * bounded ledger behind `maxCandidateEscapes` — the owner-ratified recut hatch for an
 * exhausted frozen candidate.
 *
 * `decideExhaustedPin` (frozen-candidate-repair-queue.ts) may answer `recut-at-tip` only while
 * `observation.priorEscapes < limits.maxCandidateEscapes`. This module is where those escapes
 * durably LIVE: `gate_health.candidateEscapes` on the same green-checkpoint routine row that
 * carries the queue itself — the established episode-bookkeeping idiom (see
 * `gate_health.verdictlessRefire`, D-003). The rolling window is measured HERE, by the reader,
 * so the model's limit stays a plain count ("escapes within the window") and the day boundary
 * cannot drift between writer and reader.
 *
 * WHY ITS OWN MODULE (not release-actions.ts): the same reason fixer-liveness.ts was split out
 * — release-actions registers system actions at module scope, and this surface is also needed
 * by the gate engine's deps wiring, which should not import that side effect. (It also keeps
 * this P-008 lane physically disjoint from the concurrently-held retire-path work in
 * release-actions.ts, EI-22026318885195355.)
 */
import type { GateVerdictTarget } from './gate-verdict-target';

/** One taken escape: the recorded half of the "bounded, recorded recut option". */
export interface FrozenCandidateEscapeRecord {
  /** When the escape was taken (epoch ms). The window predicate reads this field. */
  atMs: number;
  /** The exhausted, abandoned frozen candidate sha. */
  abandonedCandidate: string;
  /** The repair head the abandoned queue had reached (progress is preserved per D-007). */
  repairHead: string;
  /** The exhaustion class that triggered the escape ('attempts-exhausted' | 'wall-clock-exhausted'). */
  reason: string;
  /** 1-based ordinal within the window at decision time (decision.escapeOrdinal). */
  ordinal: number;
}

/**
 * The owner decision is "maxCandidateEscapes 0 → 1/day" (P-008 item text): the budget window
 * is one rolling day, measured at read time.
 */
export const FROZEN_REPAIR_ESCAPE_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Bounded history: enough to audit several days at 1/day without unbounded growth. */
export const FROZEN_REPAIR_ESCAPE_HISTORY_CAP = 10;

/**
 * How many escapes the rolling window already holds. Throw-transparent by design: the engine
 * caller fails CLOSED on any error (treats the budget as spent), so a broken ledger can only
 * ever produce the pre-P-008 behaviour (hold-exhausted), never an unbounded recut loop.
 */
export async function readRecentFrozenCandidateEscapes(
  target: GateVerdictTarget,
  windowMs = FROZEN_REPAIR_ESCAPE_WINDOW_MS,
  nowMs = Date.now(),
): Promise<number> {
  const { getOrgPg } = await import('@papercusp/db-org');
  const { sql } = getOrgPg();
  const rows = (await sql.unsafe(
    `SELECT COUNT(*)::int AS escapes
       FROM harness_shared.routines r,
            jsonb_array_elements(COALESCE(r.metadata->'gate_health'->'candidateEscapes', '[]'::jsonb)) e
      WHERE r.workspace_id = $1
        AND r.install_slug = $2
        AND r.target_role = 'system:green-checkpoint'
        AND e->>'atMs' ~ '^[0-9]+$'
        AND (e->>'atMs')::bigint > $3::bigint`,
    [target.workspaceId, target.installSlug, nowMs - windowMs],
  )) as Array<{ escapes: number | string }>;
  return Number(rows[0]?.escapes ?? 0);
}

/**
 * Durably record a taken escape, newest-first, trimmed to the history cap — ONE statement, so
 * the record cannot lag the recut it authorizes. The caller (the gate engine's recut branch)
 * records BEFORE abandoning the pin: a crash between record and retire burns budget but keeps
 * the queue, so the next tick re-decides with the spent budget and can only hold, never
 * double-recut.
 */
export async function recordFrozenCandidateEscape(
  target: GateVerdictTarget,
  entry: FrozenCandidateEscapeRecord,
): Promise<void> {
  const { getOrgPg } = await import('@papercusp/db-org');
  const { sql } = getOrgPg();
  await sql.unsafe(
    `UPDATE harness_shared.routines
        SET metadata = jsonb_set(
              jsonb_set(
                COALESCE(metadata, '{}'::jsonb),
                '{gate_health}',
                COALESCE(metadata->'gate_health', '{}'::jsonb),
                true
              ),
              '{gate_health,candidateEscapes}',
              (SELECT COALESCE(jsonb_agg(t.val ORDER BY t.ord), '[]'::jsonb)
                 FROM (SELECT val, ord
                         FROM jsonb_array_elements(
                                $3::jsonb || COALESCE(metadata->'gate_health'->'candidateEscapes', '[]'::jsonb)
                              ) WITH ORDINALITY AS x(val, ord)
                        ORDER BY ord
                        LIMIT ${FROZEN_REPAIR_ESCAPE_HISTORY_CAP}) t),
              true
            ),
            updated_at = now()
      WHERE workspace_id = $1
        AND install_slug = $2
        AND target_role = 'system:green-checkpoint'`,
    [target.workspaceId, target.installSlug, JSON.stringify([entry])],
  );
}
