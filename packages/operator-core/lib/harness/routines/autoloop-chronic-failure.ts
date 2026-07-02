/**
 * autoloop-chronic-failure — the CHRONIC-FAILURE ESCALATOR
 * (gym-unwedge-scout-novelty-2026-07-02 GYM-2, generalized across roles).
 *
 * THE GAP THIS CLOSES: a routine-driven cycle can fail EVERY fire and nothing
 * escalates — the gym-cycle sat at consecutive_errors=72 (12 days dead) and the
 * only witness was a bare `gym-cycle:error` literal nobody read. The fire-gate's
 * error backoff correctly SLOWS a failing cycle, but slowing is not surfacing:
 * a chronically-red autoloop row must become a visible, owned artifact.
 *
 * MECHANISM (the watchdog-sweep house pattern — pure decider + debounced
 * fail-soft PG sweep on the routines tick): any `autoloop_state` row with
 * `consecutive_errors >= threshold` files ONE improvements OBSERVATION
 * (kind bug, carrying the verbatim last_status) per breach, debounced 24h per
 * (harness, role) via the `hive_watchdog_fires` ledger. The observation enters
 * the SAME triage pipeline scout/queen already consume — no parallel alerting
 * system. Kill switch: PAPERCUSP_AUTOLOOP_CHRONIC_THRESHOLD <= 0.
 *
 * SKIP AN ALREADY-PAUSED ROUTINE (found live: EI-6760/6761/6762 — a loop-arm
 * loop whose owner session died was correctly auto-paused by the pre-existing
 * stuck-park backstop / the WI-1399 dead-owner guard — `harness_shared.routines
 * .active = false` — 13+ hours before this sweep next ran, yet the sweep kept
 * re-escalating it as if it were still actively failing, because it only reads
 * `autoloop_state.consecutive_errors` and never checks whether the underlying
 * routine is still armed). A `consecutive_errors` streak is a STALE watermark —
 * it is only meaningfully "chronic" while the routine is still trying (and
 * failing) to fire. So this LEFT JOINs `harness_shared.routines` on
 * `(name, workspace_id)` and drops a row whose matching routine is explicitly
 * `active = false` — a resolved (already-paused) condition, not a live one.
 * A role with NO matching routines row (director/gym-cycle/overwatch/
 * scout-cycle — fixed system roles, not `loop:arm` rows) has nothing to join
 * against and is treated as still-live (fail-open: an unknown routine state
 * must never SUPPRESS a genuine chronic-failure alert).
 */
import { getOrgPg } from '@papercusp/db-org';
import { recentWatchdogFires, recordFire } from '../../hive/watchdog';
import { activeWorkspaceId } from '../../workspace-registry';

/** Breach threshold (env-overridable; <=0 disables the sweep). */
export function chronicErrorThreshold(): number {
  const n = Number(process.env.PAPERCUSP_AUTOLOOP_CHRONIC_THRESHOLD ?? 6);
  return Number.isFinite(n) ? n : 6;
}

export interface AutoloopStateRow {
  harness_slug: string;
  role: string;
  consecutive_errors: number;
  last_status: string | null;
  /** The matching `harness_shared.routines.active` for this (workspace, role) — from a LEFT
   *  JOIN, so `null` means no matching routine row exists (a fixed system role, not a
   *  loop:arm-materialized routine). `false` is the ONLY value that suppresses escalation —
   *  the routine engine itself has already resolved this condition (auto-paused). */
  routine_active: boolean | null;
}

/** PURE: which rows breach the threshold (highest streak first), EXCLUDING any row whose
 *  matching routine is already `active:false` (auto-paused — a resolved condition, not a
 *  live chronic failure; see this module's header comment). `routine_active: null` (no
 *  matching routine) is NOT excluded — fail-open, never silently suppress an unknown state. */
export function selectChronicFailures(
  rows: readonly AutoloopStateRow[],
  threshold: number,
): AutoloopStateRow[] {
  if (threshold <= 0) return [];
  return rows
    .filter((r) => r.consecutive_errors >= threshold && r.routine_active !== false)
    .sort((a, b) => b.consecutive_errors - a.consecutive_errors);
}

export interface ChronicFailureResult {
  harnessSlug: string;
  role: string;
  outcome: 'escalated' | 'debounced' | 'skipped-paused' | 'error';
  reason: string;
}

/**
 * The sweep. Fail-soft by contract; debounced 24h per (harness, role) so a
 * still-red row escalates once a day, not every 30s tick.
 */
export async function autoloopChronicFailureSweep(): Promise<ChronicFailureResult[]> {
  const results: ChronicFailureResult[] = [];
  const threshold = chronicErrorThreshold();
  if (threshold <= 0) return results;
  try {
    const { sql } = getOrgPg();
    const workspaceId = activeWorkspaceId();
    const allRows = await sql<AutoloopStateRow[]>`
      SELECT s.harness_slug, s.role, s.consecutive_errors, s.last_status, r.active AS routine_active
        FROM harness_shared.autoloop_state s
   LEFT JOIN harness_shared.routines r
          ON r.name = s.role AND r.workspace_id = s.workspace_id
       WHERE s.consecutive_errors >= ${threshold}`;
    const pausedSkipped = allRows.filter((r) => r.consecutive_errors >= threshold && r.routine_active === false);
    const breaches = selectChronicFailures(allRows, threshold);
    for (const p of pausedSkipped) {
      results.push({
        harnessSlug: p.harness_slug,
        role: p.role,
        outcome: 'skipped-paused',
        reason: `routine already auto-paused (active:false) — resolved, not a live chronic failure`,
      });
    }
    for (const b of breaches) {
      try {
        const source = 'autoloop-chronic' as const;
        const alreadyFired =
          (await recentWatchdogFires(workspaceId, `${b.harness_slug}::${b.role}`, 24, source)) > 0;
        if (alreadyFired) {
          results.push({ harnessSlug: b.harness_slug, role: b.role, outcome: 'debounced', reason: 'escalated within 24h' });
          continue;
        }
        const { captureImprovement } = await import('../improvements/capture-core');
        const reason = `${b.role}@${b.harness_slug}: ${b.consecutive_errors} consecutive errors — last_status: ${(b.last_status ?? '').slice(0, 200)}`;
        await captureImprovement({
          title: `CHRONIC autoloop failure: ${b.role}@${b.harness_slug} red ${b.consecutive_errors} consecutive fires`,
          kind: 'bug',
          severity: 'major',
          body:
            `${reason}\n\nThe fire-gate backoff is slowing this cycle but nothing was surfacing it — ` +
            `a chronically-red autoloop row is dead capability (the gym ran 12 days dead this way, WI plan ` +
            `gym-unwedge-scout-novelty-2026-07-02). Read the recorded last_status verbatim FIRST ` +
            `(runbook driving-the-autonomous-hive-loop), fix the root cause, then autoloop:control reset-errors.`,
          scope: `harness:${b.harness_slug}`,
          foundDuring: 'autoloop-chronic-failure sweep (routines tick)',
        });
        await recordFire({ workspaceId, installSlug: `${b.harness_slug}::${b.role}`, source, reason, wakeAt: null });
        results.push({ harnessSlug: b.harness_slug, role: b.role, outcome: 'escalated', reason });
      } catch (e) {
        results.push({
          harnessSlug: b.harness_slug,
          role: b.role,
          outcome: 'error',
          reason: e instanceof Error ? e.message : String(e),
        });
      }
    }
  } catch (e) {
    console.warn(`[autoloop-chronic] sweep failed: ${e instanceof Error ? e.message : e}`);
  }
  return results;
}
