/**
 * outcome-refresh-sweep.ts — autonomous-loop-prod-audit-2026-07-02 P-006
 * (SPOF 5, deferred items a+b from the WI-4626/AUDIT B follow-up comment):
 * decouple the Scout outcome-ledger refresh from Scout's own cadence, and
 * alert when routed ideas sit pending past a staleness threshold.
 *
 * THE GAP: {@link refreshScoutOutcomes} (routed-ledger.ts) previously ran
 * ONLY inside a Scout CYCLE (scout/scheduler.ts's `refreshOutcomes()` — called
 * once per successful cycle). An idle, backed-off (fire-gate circuit breaker),
 * or dead Scout therefore freezes EVERY routed idea's cached `outcome` at
 * whatever it was during the last cycle: the plan-rail / gym-rail / wi-rail
 * outcome ledger reads as stuck even when the underlying rail artifacts have
 * since resolved, and the per-lens weight learning (P-033) silently stops
 * updating. This mirrors the exact class of bug the signal-accumulator sweep
 * (blender-self-learning-2026-07-12 P-001) already fixed for cadence
 * counting — the fix here is the same shape: a routines-tick sweep
 * independent of the thing it used to be coupled to.
 *
 * (a) DECOUPLE: this sweep calls refreshScoutOutcomes for every started pot's
 *     workspace on its own in-process-throttled cadence (default 15min — much
 *     cheaper than a full Scout cycle, so a much shorter floor is safe),
 *     wholly independent of whether Scout is currently cycling.
 * (b) ESCALATE: after a refresh, count routed ideas whose outcome is STILL
 *     NULL/'pending' with a stale (or absent) `outcome_checked_at` — a refresh
 *     running does not itself guarantee an idea resolves (e.g. an abandoned
 *     draft that never reached ANY rail terminal). When that count is > 0 and
 *     more than the threshold window has passed since the last such alert
 *     (the shared `hive_watchdog_fires` debounce ledger — mirrors
 *     rubric-staleness-watchdog.ts), open ONE escalation naming the count so a
 *     human/Mug investigates instead of the ledger quietly aging forever
 *     (the "12-day-dead-and-nobody-noticed" failure class this whole audit
 *     plan exists to close).
 *
 * Same watchdog-family chassis as signal-accumulator.ts (per-registered-Blender-scope
 * sweep, in-process throttle, workspace-wide corpus) and
 * rubric-staleness-watchdog.ts (fires-ledger debounce + escalation):
 * fail-soft throughout (a sweep must never fail the routines tick it rides),
 * env-tunable kill switches, injectable deps for DB-free unit tests.
 */
import { listBlenderMaintenanceScopes } from '../pot/started';
import { refreshScoutOutcomes, countStalePendingIdeas } from './routed-ledger';
import { recentWatchdogFires, recordFire } from '../pot/watchdog';
import { openEscalation } from '../agent-tools/coordination/escalations';
import type { AgentIdentity } from '../agent-tools/coordination/identity';

// ── tunables (env-overridable, watchdog-family idiom) ─────────────────────────

/** In-process throttle between outcome-refresh sweeps — the routinesTick
 *  fires every ~30s; refreshing every tick buys nothing (a Change-Feed join
 *  + a batched UPDATE per workspace) and is needless PG load. Default 900s
 *  (15min — comfortably below Scout's own hourly cadence floor, so a
 *  cadence-starved Scout is never more than 15min stale). Env
 *  PAPERCUSP_SCOUT_OUTCOME_REFRESH_SEC; `<=0` DISABLES the sweep entirely
 *  (kill switch). */
export function scoutOutcomeRefreshIntervalSec(): number {
  const n = Number(process.env.PAPERCUSP_SCOUT_OUTCOME_REFRESH_SEC ?? 900);
  return Number.isFinite(n) ? n : 900;
}

/** How long a routed idea may sit outcome NULL/'pending' before the
 *  stale-pending alert fires. Default 24h — long enough that a normal
 *  in-flight idea (its rail artifact genuinely not yet terminal) never
 *  trips it, short enough to catch a truly-stuck one well before the
 *  12-day dead-cycle class this audit found. Env
 *  PAPERCUSP_SCOUT_OUTCOME_STALE_PENDING_SEC; `<=0` disables ONLY the
 *  stale-pending alert (the refresh half of the sweep still runs). */
export function scoutOutcomeStalePendingThresholdSec(): number {
  const n = Number(process.env.PAPERCUSP_SCOUT_OUTCOME_STALE_PENDING_SEC ?? 86_400);
  return Number.isFinite(n) ? n : 86_400;
}

// ── pure decider (unit-tested with no DB) ──────────────────────────────────────

/** PURE: should the sweep run this tick? (in-process throttle, mirrors
 *  signal-accumulator's shouldSweepNow). `sweepSec <= 0` never runs (the kill
 *  switch — checked by the caller before this, but defensive here too). */
export function shouldRefreshNow(lastSweepAtMs: number | null, nowMs: number, sweepSec: number): boolean {
  if (sweepSec <= 0) return false;
  if (lastSweepAtMs == null) return true;
  return nowMs - lastSweepAtMs >= sweepSec * 1_000;
}

// ── the sweep ─────────────────────────────────────────────────────────────────

export interface OutcomeRefreshSweepResult {
  workspaceId: string;
  installSlug: string;
  outcome: 'refreshed' | 'error';
  /** Coverage of the registry-backed Blender population evaluated by this tick. */
  evaluatedWorkspaceCount: number;
  evaluatedScopeCount: number;
  eligibleBacklogCount: number;
  stalePendingCount: number;
  alerted: boolean;
  reason: string;
}

let lastSweepAtMs: number | null = null;

/** Test seam: reset the in-process throttle. */
export function __resetOutcomeRefreshThrottleForTests(): void {
  lastSweepAtMs = null;
}

/** Synthetic identity for the background stale-pending escalation (mirrors
 *  the rubric-staleness watchdog's identity). */
const SCOUT_OUTCOME_STALE_IDENTITY: AgentIdentity = {
  ownerId: 'scout-outcome-refresh-sweep',
  ownerLabel: 'system · scout-outcome-refresh-sweep',
  source: 'principal',
  workspaceId: null,
  userId: null,
};

/** Injectable seams so the sweep's orchestration is testable without PG. */
export interface OutcomeRefreshSweepDeps {
  listBlenderMaintenanceScopes?: typeof listBlenderMaintenanceScopes;
  refreshScoutOutcomes?: typeof refreshScoutOutcomes;
  countStalePendingIdeas?: typeof countStalePendingIdeas;
  recentWatchdogFires?: typeof recentWatchdogFires;
  recordFire?: typeof recordFire;
  openEscalation?: typeof openEscalation;
  now?: number;
}

/**
 * The decoupled outcome-refresh sweep. For each registered Blender scope's WORKSPACE
 * (de-duped — refreshScoutOutcomes' corpus read is already workspace-wide,
 * EI-10520, so refreshing once per workspace avoids N redundant refreshes on
 * a multi-pot workspace): refresh outcomes, then count+alert on stale-pending
 * ideas. Never throws — a sweep that crashes its host routine tick guards
 * nothing. Kill switch: PAPERCUSP_SCOUT_OUTCOME_REFRESH_SEC <= 0.
 */
export async function scoutOutcomeRefreshSweep(
  deps: OutcomeRefreshSweepDeps = {},
): Promise<OutcomeRefreshSweepResult[]> {
  const results: OutcomeRefreshSweepResult[] = [];
  const intervalSec = scoutOutcomeRefreshIntervalSec();
  if (intervalSec <= 0) return results; // kill switch
  const now = deps.now ?? Date.now();
  if (!shouldRefreshNow(lastSweepAtMs, now, intervalSec)) return results;
  lastSweepAtMs = now;

  const thresholdSec = scoutOutcomeStalePendingThresholdSec();

  try {
    const scopes = await (deps.listBlenderMaintenanceScopes ?? listBlenderMaintenanceScopes)();
    if (scopes.length === 0) {
      console.warn('[scout-outcome-refresh] ALERT: no registered Blender scopes evaluated');
      return results;
    }
    const evaluatedWorkspaceCount = new Set(scopes.map(({ workspaceId }) => workspaceId)).size;
    const evaluatedScopeCount = scopes.length;
    const seenWorkspaces = new Set<string>();
    for (const { workspaceId, installSlug } of scopes) {
      if (seenWorkspaces.has(workspaceId)) continue;
      seenWorkspaces.add(workspaceId);
      try {
        await (deps.refreshScoutOutcomes ?? refreshScoutOutcomes)({ workspaceId, harnessSlug: installSlug });

        let stalePendingCount = 0;
        let alerted = false;
        if (thresholdSec > 0) {
          stalePendingCount = await (deps.countStalePendingIdeas ?? countStalePendingIdeas)({
            workspaceId,
            staleBeforeMs: now - thresholdSec * 1_000,
          });
          if (stalePendingCount > 0) {
            const windowHours = Math.max(1, Math.round(thresholdSec / 3_600));
            const firedRecently =
              (await (deps.recentWatchdogFires ?? recentWatchdogFires)(
                workspaceId,
                installSlug,
                windowHours,
                'scout-outcome-stale-pending',
              )) > 0;
            if (!firedRecently) {
              const reason =
                `${stalePendingCount} routed idea(s) in workspace '${workspaceId}' have sat ` +
                `outcome NULL/'pending' past the ${windowHours}h staleness threshold, even after an ` +
                `independent (Scout-cadence-decoupled) refresh — their rail artifact likely never ` +
                `reaches a terminal (an abandoned/never-disposed draft), or the refresh itself is ` +
                `failing silently. Investigate via readRoutedIdeas / the ledger's outcome_checked_at.`;
              console.warn(`[scout-outcome-refresh] ALERT: ${reason}`);
              await (deps.recordFire ?? recordFire)({
                workspaceId,
                installSlug,
                source: 'scout-outcome-stale-pending',
                reason,
                wakeAt: null,
              });
              await (deps.openEscalation ?? openEscalation)(SCOUT_OUTCOME_STALE_IDENTITY, {
                severity: 'advisory',
                summary: `${stalePendingCount} Scout-routed idea(s) stuck pending past ${windowHours}h`,
                body: reason,
              });
              alerted = true;
            }
          }
        }
        results.push({
          workspaceId,
          installSlug,
          outcome: 'refreshed',
          evaluatedWorkspaceCount,
          evaluatedScopeCount,
          eligibleBacklogCount: stalePendingCount,
          stalePendingCount,
          alerted,
          reason:
            stalePendingCount > 0
              ? `${stalePendingCount} stale-pending${alerted ? ' (alerted)' : ' (debounced)'}`
              : 'refreshed, no stale-pending',
        });
      } catch (e) {
        results.push({
          workspaceId,
          installSlug,
          outcome: 'error',
          evaluatedWorkspaceCount,
          evaluatedScopeCount,
          eligibleBacklogCount: 0,
          stalePendingCount: 0,
          alerted: false,
          reason: e instanceof Error ? e.message : String(e),
        });
      }
    }
  } catch (e) {
    console.warn(`[scout-outcome-refresh] sweep failed: ${e instanceof Error ? e.message : e}`);
  }
  return results;
}
