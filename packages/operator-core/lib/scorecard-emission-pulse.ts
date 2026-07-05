/**
 * scorecard-emission-pulse — the SCHEDULED rubric-emission floor
 * (rubric-scorecard adoption step 1, WI-2374, 2026-07-04).
 *
 * overwatch/scorecard-backstop.ts guarantees a `hive-coordination-health`
 * scorecard per overwatch TURN — but it is a turn-END seam: it only fires when an
 * overwatch launch finishes. When the supervisor is STOPPED (kettle:pause) or
 * its wake loop dies, no turns end → no agent cards AND no floors, and the
 * freshness interpreter reads 'overwatch-not-started' as benign ("Ignore") — so
 * rubric emission died SILENTLY when overwatch stopped on 2026-07-02 and nothing
 * noticed (WI-2374: 198/199 scorecards ever filed were overwatch-emitted; the
 * data layer was a monoculture coupled to overwatch aliveness).
 *
 * This pulse DECOUPLES the data layer from the agent: an in-process periodic
 * check that files the same deterministic synthesized floor when NO scorecard —
 * agent OR floor — has landed within the window. Zero LLM tokens
 * (computeSystemHealth + one PG write), so it is safe through a capacity crunch
 * and while the supervisor is deliberately paused. Gated ONLY on the
 * `papercusp-overwatch` flag (the owner kill switch) — deliberately NOT on the
 * started bit: that coupling was the defect. When overwatch runs normally, cards
 * land every wake (agent, or the turn-end backstop) so the window is never empty
 * and the pulse no-ops.
 *
 * Floors stay marked `synthesized: true` (excluded by default from
 * agent-freshness and the trend, same contract as the backstop) with a distinct
 * `synthSource: 'scheduled-pulse'`, and every filing records a
 * hive_watchdog_fires row (source `scorecard-pulse`) — the countable "the data
 * layer is running on the floor pulse" signal. Fail-soft by contract: never
 * throws into the periodic scheduler.
 *
 * ## Coalescing (WI-2977)
 * Each pulse pass is its own `improvements:capture` in the `observation` lane,
 * which by design (D-005) skips search-first dedup — recurrence is meant to be
 * the clustering signal for a genuine friction observation. But a pulse floor
 * isn't a friction finding; it's the SAME "the window was empty" fact re-filed
 * every tick a stopped supervisor stays stopped, so a multi-day outage piled up
 * one new open EI per hour (9 re-accumulated 07-04..07-05 after a sweep closed
 * the previous batch). Before filing, this now looks up the standing pulse-floor
 * item for this hive by a stable `watchdogKey` (`pulseWatchdogKey`, reuses the
 * indexed `findIssuesByWatchdogKeys` lookup the improvement watchdog already
 * uses) — an OPEN match bumps its `payload.pulseRepeat` counter instead of
 * filing a new issue; only the FIRST pulse for a given outage creates one.
 */
import { getOrgPg } from '@papercusp/db-org';
import { overwatchEnabled } from './overwatch/watchdog';
import { getOverwatchControlState } from './overwatch/snapshot';
import { checkScorecardFreshness } from './scorecard-freshness';
import { computeSystemHealth } from './system-health/compute';
import { captureImprovement } from './harness/improvements/capture-core';
import { findIssuesByWatchdogKeys, mergeIssuePayload } from './issues-engineer';
import {
  COORDINATION_RUBRIC_REF,
  synthesizeCoordinationScorecard,
  defaultToolUtilizationGrade,
  type ScorecardRating,
} from './overwatch/scorecard-backstop';
import type { SystemHealth } from './system-health/types';

/** Stable cross-tick dedup key for this hive's pulse floor (WI-2977). Same shape
 *  convention as `watchdogKeyOf` elsewhere: `<source>:<key>`. */
export function pulseWatchdogKey(sourceHive: string): string {
  return `scorecard-pulse:${sourceHive}`;
}

/** The `payload.pulseRepeat` stamp coalesced pulses bump instead of re-filing. */
export interface PulseRepeatStamp {
  /** Total pulse fires coalesced onto this item, INCLUDING the one that created it. */
  count: number;
  firstFiredAt: string;
  lastFiredAt: string;
}

/** Pure: defensively parse `payload.pulseRepeat` (absent/malformed → never fired before). */
export function readPulseRepeatCount(payload: unknown): number {
  if (payload == null || typeof payload !== 'object') return 0;
  const raw = (payload as Record<string, unknown>).pulseRepeat;
  if (raw == null || typeof raw !== 'object') return 0;
  const n = (raw as Record<string, unknown>).count;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0;
}

/** The window in which SOME scorecard (agent or floor) must exist, else the pulse files one.
 *  1h — generous vs the overwatch cadence (10min) so a live loop always wins, tight enough
 *  that a stopped monitor leaves at most a 1h hole in the data layer instead of days. */
export const PULSE_WINDOW_MS = 60 * 60 * 1000;

export interface PulseResult {
  /** 'filed' = the window was empty and a floor was filed; 'skipped' = nothing to do
   *  (flag off / no hive / a scorecard already in-window); 'error' = the pulse itself
   *  failed (recorded, never thrown). */
  outcome: 'filed' | 'skipped' | 'error';
  reason: string;
}

/** Record a "the data layer ran on the pulse floor" fire — countable in the shared
 *  watchdog-fires table under its own source so drill-back separates pulse floors
 *  from turn-end backstop floors. Best-effort; never throws. */
async function recordPulseFire(workspaceId: string, installSlug: string, reason: string): Promise<void> {
  try {
    const { sql } = getOrgPg();
    await sql`
      INSERT INTO harness_shared.hive_watchdog_fires
        (workspace_id, install_slug, source, reason, wake_at, demand)
      VALUES (${workspaceId}, ${installSlug}, ${'scorecard-pulse'}, ${reason}, ${null}, ${'{}'}::text::jsonb)`;
  } catch (e) {
    console.warn(`[scorecard-emission-pulse] fire record failed: ${e instanceof Error ? e.message : e}`);
  }
}

/** Dependency seam — defaults to the real impls; injectable so the whole pulse is
 *  unit-testable without PG / flags (same pattern as the turn-end backstop). */
export interface ScorecardEmissionPulseDeps {
  enabled?: () => Promise<boolean>;
  controlState?: (opts: { workspaceId?: string }) => Promise<{ hiveSlug: string | null }>;
  freshness?: typeof checkScorecardFreshness;
  computeHealth?: (workspaceId?: string) => Promise<SystemHealth>;
  capture?: typeof captureImprovement;
  recordFire?: (workspaceId: string, installSlug: string, reason: string) => Promise<void>;
  toolUtilizationGrade?: () => Promise<ScorecardRating | undefined>;
}

/**
 * One pulse pass for one workspace: if the `papercusp-overwatch` flag is on and NO
 * scorecard (agent or synthesized) landed within {@link PULSE_WINDOW_MS}, synthesize
 * the deterministic floor and file it. The overwatch `started` bit is deliberately
 * NOT consulted — emission must survive a stopped/dead supervisor.
 */
export async function runScorecardEmissionPulse(
  opts: { workspaceId: string },
  deps: ScorecardEmissionPulseDeps = {},
): Promise<PulseResult> {
  const { workspaceId } = opts;
  const enabled = deps.enabled ?? overwatchEnabled;
  const controlState = deps.controlState ?? getOverwatchControlState;
  const freshness = deps.freshness ?? checkScorecardFreshness;
  const computeHealth = deps.computeHealth ?? computeSystemHealth;
  const capture = deps.capture ?? captureImprovement;
  const recordFire = deps.recordFire ?? recordPulseFire;
  const toolUtilizationGrade = deps.toolUtilizationGrade ?? defaultToolUtilizationGrade;
  try {
    if (!(await enabled())) return { outcome: 'skipped', reason: 'papercusp-overwatch flag off' };

    const cs = await controlState({ workspaceId });
    const sourceHive = cs.hiveSlug;
    if (!sourceHive) return { outcome: 'skipped', reason: 'no hive configured for this workspace' };

    // ANY card in-window counts — agent, turn-end backstop floor, or a prior pulse
    // floor — so floors never stack and a live overwatch makes this a cheap no-op.
    const f = await freshness({
      rubricRef: COORDINATION_RUBRIC_REF,
      sourceHive,
      lookbackMs: PULSE_WINDOW_MS,
      includeSynthesized: true,
    });
    if (f.emitted) {
      return { outcome: 'skipped', reason: `scorecard already in-window (${f.count}, newest ${f.lastEmittedAt})` };
    }

    const health = await computeHealth(workspaceId);
    const toolUtil = await toolUtilizationGrade();
    const ratings = synthesizeCoordinationScorecard(health, toolUtil);
    await capture({
      title: 'hive-coordination-health scorecard (scheduled pulse floor)',
      kind: 'change',
      lane: 'observation',
      sourceRole: 'system',
      filedByRole: 'overwatch-watchdog',
      scope: `harness:${sourceHive}`,
      createdBy: 'system:scorecard-emission-pulse',
      payloadExtra: {
        observation: {
          kind: 'reinforce',
          scope: 'papercusp',
          sourceHive,
          rubricRef: COORDINATION_RUBRIC_REF,
          ratings,
          synthesized: true,
          synthSource: 'scheduled-pulse',
        },
      },
    });
    await recordFire(
      workspaceId,
      sourceHive,
      `no scorecard (agent or floor) in ${Math.round(PULSE_WINDOW_MS / 60_000)}m — scheduled pulse filed the deterministic floor`,
    );
    return { outcome: 'filed', reason: 'window empty; pulse floor filed' };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[scorecard-emission-pulse] pulse failed (${workspaceId}): ${msg}`);
    return { outcome: 'error', reason: msg };
  }
}
