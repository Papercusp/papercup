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
}

/** PURE: which rows breach the threshold (highest streak first). */
export function selectChronicFailures(
  rows: readonly AutoloopStateRow[],
  threshold: number,
): AutoloopStateRow[] {
  if (threshold <= 0) return [];
  return rows
    .filter((r) => r.consecutive_errors >= threshold)
    .sort((a, b) => b.consecutive_errors - a.consecutive_errors);
}

export interface ChronicFailureResult {
  harnessSlug: string;
  role: string;
  outcome: 'escalated' | 'debounced' | 'error';
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
    const rows = await sql<AutoloopStateRow[]>`
      SELECT harness_slug, role, consecutive_errors, last_status
        FROM harness_shared.autoloop_state
       WHERE consecutive_errors >= ${threshold}`;
    const breaches = selectChronicFailures(rows, threshold);
    const workspaceId = activeWorkspaceId();
    for (const b of breaches) {
      try {
        const source = 'autoloop-chronic' as never;
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
