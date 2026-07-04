/**
 * overwatch/scorecard-backstop — the SCORECARD-EMISSION backstop
 * (hive-loop-supervision 2026-06-21, su-f76c85 — the sibling of watchdog.ts).
 *
 * The Overwatch's every-wake `hive-coordination-health` scorecard is Owner
 * requirement #1, but emission is PROMPT-driven: a turn that ends without it
 * (instruction drift, a turn that died mid-flight, a budget-exhausted turn) leaves
 * the monitor SILENT — and, unlike the forgotten `overwatch:declare-wake` (which
 * watchdog.ts already backstops with a fallback SLEEP), NOTHING recovered it. Live
 * evidence (2026-06-21): ~1 complete scorecard in 7.5h while the `overwatch-wake`
 * routine fired every ~30 min — the supervisor was launched reliably but its turns
 * silently emitted nothing, and the loop had no eyes. An agent cannot fix its own
 * turn-completion fragility from inside a turn that does not complete; the recovery
 * must live in the launch machinery, exactly as the wake backstop does.
 *
 * This is that symmetric backstop. At overwatch turn-end (spawn.ts B-04 seam), if
 * the AGENT emitted no COMPLETE scorecard since its last wake, we SYNTHESIZE a
 * conservative baseline scorecard from the system-health brief (the same panels the
 * agent rates) and file it — so the monitor is never silent and Scout/monitoring
 * always have a grounded data point.
 *
 * It does NOT mask the agent's own skip (which a louder prompt + the model must
 * still fix):
 *   - the floor is marked `payload.observation.synthesized = true` and is EXCLUDED
 *     by default from `listScorecards` (so the agent-emission freshness detector in
 *     compute.ts `collectOverwatch`, the trend, the staleness signal, and Scout's
 *     digest all stay AGENT-ONLY — the floor never satisfies the agent's mandate
 *     nor pollutes the trend), and
 *   - every synthesis records a `hive_watchdog_fires` row (source
 *     `overwatch-scorecard`) — a countable "the agent skipped its scorecard" signal.
 *
 * Gated on the `papercusp-overwatch` flag (via `overwatchEnabled`) — fully inert
 * while the role is dark. Fail-soft by contract: it NEVER throws into the turn-end
 * path (every caller is a fire-and-forget seam).
 */
import { getOrgPg } from '@papercusp/db-org';
import { overwatchEnabled } from './watchdog';
import { getOverwatchStarted } from './control-state';
import { getOverwatchControlState } from './snapshot';
import { checkScorecardFreshness } from '../scorecard-freshness';
import { computeSystemHealth } from '../system-health/compute';
import { captureImprovement } from '../harness/improvements/capture-core';
import type { SystemHealth } from '../system-health/types';
import {
  readCodeRunAdoption,
  rollupAdoption,
  gradeToolUtilization,
  type RunQuery,
} from '../code-run-adoption';

/** The rubric the Overwatch scorecards against (Owner requirement #1). */
export const COORDINATION_RUBRIC_REF = 'hive-coordination-health';

/** The 14 hive-coordination-health rubric criterion keys (must cover the rubric —
 *  the capture completeness gate rejects an omitted key). Kept here so the pure
 *  synthesizer is self-contained + unit-testable without a rubric read.
 *  `scheduler-usage` (14th) added by hybrid-bee-scheduler-work-stealing-2026-06-22
 *  P-004 (rubric mig 371) — the within-hive scheduler-usage health characteristic. */
export const COORDINATION_CRITERIA = [
  'end-to-end-flow',
  'ideation-quality',
  'queen-workitem-selection',
  'queen-plan-selection',
  'parallel-distribution',
  'bee-execution',
  'bee-observation-quality',
  'overwatch-observation-quality',
  'watchdog-determinism',
  'coordination-comms',
  'chatter-economy',
  'coordination-utilization',
  'tool-utilization',
  'scheduler-usage',
] as const;

export interface ScorecardRating {
  rating: string;
  evidence: string;
}

export interface OverwatchScorecardCheckResult {
  /** 'synthesized' = the agent skipped and a floor was filed; 'skipped' = nothing
   *  to do (flag off / not started / agent emitted a complete scorecard);
   *  'error' = the check itself failed (recorded, never thrown). */
  outcome: 'synthesized' | 'skipped' | 'error';
  reason: string;
}

const UNKNOWN_EVIDENCE =
  'auto-synth floor — the Overwatch agent turn emitted no scorecard; this criterion needs a live agent turn to assess';

const unknown = (): ScorecardRating => ({ rating: 'unknown', evidence: UNKNOWN_EVIDENCE });

/**
 * PURE: derive a conservative baseline `hive-coordination-health` scorecard from the
 * system-health brief. Only the MECHANICALLY-derivable criteria are rated from panel
 * data (end-to-end-flow, queen-workitem/plan-selection, watchdog-determinism,
 * bee-execution, ideation-quality's transport-death); every judgment-only criterion
 * is honestly 'unknown' (a deterministic floor cannot assess nuance). All 14 keys are
 * present, each with non-empty evidence (the capture completeness + evidence gates
 * require it). DB-free → unit-tested exhaustively.
 *
 * `toolUtilization` (code-run-adoption directive 2026-06-29): when the caller supplies a
 * data-derived grade (the fleet code:run adoption rate → rating, computed from
 * tool_invocations), it grounds the `tool-utilization` criterion with REAL data instead of
 * the deterministic floor's honest 'unknown'. Omitted ⇒ 'unknown' as before (the floor stays
 * DB-free + purely health-derived when no adoption read is wired in).
 */
export function synthesizeCoordinationScorecard(
  health: SystemHealth,
  toolUtilization?: ScorecardRating,
): Record<string, ScorecardRating> {
  const p = health.panels;
  const wf = p.workFeed?.data ?? null;
  const bees = p.bees?.data ?? null;
  const queen = p.queen?.data ?? null;
  const wd = p.watchdog?.data ?? null;
  const scout = p.scout?.data ?? null;
  const plans = p.plans?.data ?? null;

  const r: Record<string, ScorecardRating> = {};

  // end-to-end-flow — is work flowing queue→bee→done? (broken = input present, output absent)
  if (wf) {
    const stuck = wf.autoEligibleStuck;
    const running = bees?.running ?? 0;
    const rating = stuck >= 50 ? 'broken' : stuck > 0 ? 'degraded' : 'healthy';
    r['end-to-end-flow'] = {
      rating,
      evidence: `auto-synth: ${stuck} auto-eligible items stuck at attempts:0, ${running} bees running, ${
        bees?.placements.workingTracked ?? 0
      } placements tracked, ${wf.frontier} ready frontier, ${wf.deadRoutines} dead routines`,
    };
  } else r['end-to-end-flow'] = unknown();

  // ideation-quality — transport-death is mechanical; idea QUALITY is judgment
  if (scout) {
    r['ideation-quality'] = scout.transportDeath
      ? {
          rating: 'broken',
          evidence: `auto-synth: Scout TRANSPORT-DEATH — ${scout.ranInWindow} cycles ran but 0 ideas generated in-window`,
        }
      : {
          rating: 'unknown',
          evidence: `auto-synth: ${scout.ideasInWindow} ideas across ${scout.ranInWindow} cycles in-window; idea QUALITY/diversity needs a live agent turn`,
        };
  } else r['ideation-quality'] = unknown();

  // queen-workitem-selection — placing the ready backlog, or leaving it stuck?
  if (wf || queen) {
    const stuck = wf?.autoEligibleStuck ?? 0;
    const tracked = queen?.workingTracked ?? 0;
    const rating = stuck > 0 && tracked === 0 ? 'degraded' : 'unknown';
    r['queen-workitem-selection'] = {
      rating,
      evidence: `auto-synth: Queen workingTracked=${tracked}, ${stuck} auto-eligible items unplaced, queen ${
        queen?.stalled ? 'STALLED' : 'not stalled'
      }; selection QUALITY needs a live agent turn`,
    };
  } else r['queen-workitem-selection'] = unknown();

  // queen-plan-selection — only the "force-started a draft" anti-pattern is mechanical
  if (plans) {
    r['queen-plan-selection'] =
      plans.startedDraft > 0
        ? {
            rating: 'degraded',
            evidence: `auto-synth: ${plans.startedDraft} plan(s) force-started while still draft (the queen-plan-selection anti-pattern); ${plans.stalledPlans} stalled plans`,
          }
        : {
            rating: 'unknown',
            evidence: `auto-synth: 0 draft-force-starts (the one mechanical signal is clean); selection priority/quality needs a live agent turn`,
          };
  } else r['queen-plan-selection'] = unknown();

  // watchdog-determinism — armed + fire-volume (excessive noise = degraded)
  if (wd) {
    const fires = wd.fires24h;
    const rating = !wd.livenessArmed ? 'degraded' : fires >= 40 ? 'degraded' : 'healthy';
    r['watchdog-determinism'] = {
      rating,
      evidence: `auto-synth: watchdog ${wd.livenessArmed ? 'armed' : 'NOT armed'}, ${fires} fallback fires/24h, ${wd.recentErrors} recent errors`,
    };
  } else r['watchdog-determinism'] = unknown();

  // bee-execution — only assessable when bees exist
  if (bees) {
    r['bee-execution'] =
      bees.running === 0
        ? { rating: 'unknown', evidence: 'auto-synth: 0 bees running this wake — not assessable' }
        : {
            rating: bees.stale > 0 || bees.orphanedClaims > 0 ? 'degraded' : 'healthy',
            evidence: `auto-synth: ${bees.running} running, ${bees.stale} stale, ${bees.orphanedClaims} orphaned claims`,
          };
  } else r['bee-execution'] = unknown();

  // judgment-only criteria — honest 'unknown' (a deterministic floor can't assess them).
  // scheduler-usage (per-bee spec authorship + get_next pickup + dedup-floor health) is a
  // claim-path read the floor doesn't make, so it is honest 'unknown' here too.
  for (const k of [
    'parallel-distribution',
    'bee-observation-quality',
    'coordination-comms',
    'chatter-economy',
    'coordination-utilization',
    'scheduler-usage',
  ]) {
    r[k] = unknown();
  }

  // tool-utilization — DATA-GROUNDED when an adoption grade is supplied (code:run adoption rate
  // → rating), else 'unknown'. This is the one judgment criterion the metric makes mechanical.
  r['tool-utilization'] = toolUtilization ?? unknown();

  // This scorecard IS the synthesized floor — its own emission quality is "no agent turn".
  r['overwatch-observation-quality'] = {
    rating: 'unknown',
    evidence:
      'auto-synth floor — the Overwatch agent turn emitted no scorecard, so this is the deterministic backstop, NOT an agent self-assessment (a synth-floor turn is a habit bug for the agent to fix)',
  };

  return r;
}

/**
 * Record a "the agent skipped its scorecard; floor synthesized" fire — a countable
 * signal in the shared watchdog-fires table. Replicated (not imported from
 * watchdog.ts) on purpose: it keeps the load-bearing wake path untouched and uses a
 * distinct `overwatch-scorecard` source so a drill-back can separate scorecard
 * skips from forgot-wake fires. Best-effort; never throws.
 */
async function recordScorecardFire(workspaceId: string, installSlug: string, reason: string): Promise<void> {
  try {
    const { sql } = getOrgPg();
    await sql`
      INSERT INTO harness_shared.hive_watchdog_fires
        (workspace_id, install_slug, source, reason, wake_at, demand)
      VALUES (${workspaceId}, ${installSlug}, ${'overwatch-scorecard'}, ${reason}, ${null}, ${'{}'}::jsonb)`;
  } catch (e) {
    console.warn(`[overwatch-scorecard-backstop] fire record failed: ${e instanceof Error ? e.message : e}`);
  }
}

/**
 * Default `tool-utilization` grade: read the fleet code:run adoption rollup (last 7 days) from PG
 * and grade it. Best-effort — any failure (no table, slow query) returns undefined so the floor
 * falls back to honest 'unknown' rather than breaking the backstop. Mirrors the RunQuery prod
 * wiring (sql.unsafe(query, params)). Exported for the scheduled emission pulse
 * (scorecard-emission-pulse.ts), which grounds the same criterion the same way.
 */
export async function defaultToolUtilizationGrade(): Promise<ScorecardRating | undefined> {
  try {
    const { sql } = getOrgPg();
    const runQuery: RunQuery = async <T = unknown>(query: string, params: unknown[]) =>
      (await sql.unsafe(query, params as never)) as unknown as T[];
    const summaries = await readCodeRunAdoption(runQuery, { sinceDays: 7 });
    return gradeToolUtilization(rollupAdoption(summaries));
  } catch (e) {
    console.warn(`[overwatch-scorecard-backstop] adoption grade failed: ${e instanceof Error ? e.message : e}`);
    return undefined;
  }
}

/** Dependency seam — defaults to the real impls; injectable so the whole check is
 *  unit-testable without PG / flags / vi.mock. */
export interface OverwatchScorecardEndCheckDeps {
  enabled?: () => Promise<boolean>;
  started?: (workspaceId: string, installSlug: string) => Promise<boolean>;
  controlState?: (opts: {
    workspaceId?: string;
    hiveSlug?: string;
  }) => Promise<{ lastWakeAt: string | null; hiveSlug: string | null }>;
  freshness?: typeof checkScorecardFreshness;
  computeHealth?: (workspaceId?: string) => Promise<SystemHealth>;
  capture?: typeof captureImprovement;
  recordFire?: (workspaceId: string, installSlug: string, reason: string) => Promise<void>;
  /** Data-derived `tool-utilization` grade (code:run adoption). undefined ⇒ floor uses 'unknown'. */
  toolUtilizationGrade?: () => Promise<ScorecardRating | undefined>;
}

/**
 * The turn-end seam (wired in spawn.ts alongside `overwatchTurnEndCheck`): after an
 * overwatch launch finishes, if the AGENT left no COMPLETE scorecard since its last
 * wake, synthesize + file the baseline floor and record the skip. Fully gated +
 * fail-soft — mirrors watchdog.ts `armFallbackOverwatchWake`.
 */
export async function overwatchScorecardEndCheck(
  opts: { workspaceId: string; installSlug: string },
  deps: OverwatchScorecardEndCheckDeps = {},
): Promise<OverwatchScorecardCheckResult> {
  const { workspaceId, installSlug } = opts;
  const enabled = deps.enabled ?? overwatchEnabled;
  const started = deps.started ?? getOverwatchStarted;
  const controlState = deps.controlState ?? getOverwatchControlState;
  const freshness = deps.freshness ?? checkScorecardFreshness;
  const computeHealth = deps.computeHealth ?? computeSystemHealth;
  const capture = deps.capture ?? captureImprovement;
  const recordFire = deps.recordFire ?? recordScorecardFire;
  const toolUtilizationGrade = deps.toolUtilizationGrade ?? defaultToolUtilizationGrade;
  try {
    if (!(await enabled())) return { outcome: 'skipped', reason: 'overwatch flag off' };
    if (!(await started(workspaceId, installSlug))) return { outcome: 'skipped', reason: 'overwatch not started' };

    const cs = await controlState({ workspaceId, hiveSlug: installSlug });
    const sourceHive = cs.hiveSlug ?? installSlug;
    const f = await freshness({
      rubricRef: COORDINATION_RUBRIC_REF,
      sourceHive,
      ...(cs.lastWakeAt ? { since: cs.lastWakeAt } : {}),
      // AGENT-only: the floor must never satisfy the agent's own mandate.
      includeSynthesized: false,
    });
    if (f.status === 'fresh') {
      return { outcome: 'skipped', reason: 'agent emitted a complete scorecard since last wake' };
    }

    // The turn ended with no complete agent scorecard — synthesize the floor. Ground
    // tool-utilization in real code:run adoption data (best-effort; undefined ⇒ 'unknown').
    const health = await computeHealth(workspaceId);
    const toolUtil = await toolUtilizationGrade();
    const ratings = synthesizeCoordinationScorecard(health, toolUtil);
    await capture({
      title: 'hive-coordination-health scorecard (synthesized floor)',
      kind: 'change',
      lane: 'observation',
      sourceRole: 'system',
      filedByRole: 'overwatch-watchdog',
      scope: `harness:${sourceHive}`,
      createdBy: 'system:overwatch-scorecard-backstop',
      payloadExtra: {
        observation: {
          kind: 'reinforce',
          scope: 'papercusp',
          sourceHive,
          rubricRef: COORDINATION_RUBRIC_REF,
          ratings,
          synthesized: true,
          synthSource: 'scorecard-backstop',
        },
      },
    });
    await recordFire(
      workspaceId,
      installSlug,
      `agent emitted ${f.status === 'partial-only' ? 'only a PARTIAL' : 'NO'} scorecard since last wake; synthesized floor`,
    );
    return { outcome: 'synthesized', reason: `agent scorecard ${f.status}; floor synthesized` };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[overwatch-scorecard-backstop] end-check failed (${installSlug}): ${msg}`);
    return { outcome: 'error', reason: msg };
  }
}
