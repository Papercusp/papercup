/**
 * learning-frontier-read.ts — the read behind the Learning tab's "Frontier"
 * view (learning-tab-visibility-2026-07-18 P-003/P-004).
 *
 * One row per workspace-singleton learning loop, answering the three-gate
 * question the relight audit codified (a loop is live only when ALL of:
 * routine active + flag ON + governor budget):
 *
 *   1. **Liveness** — the SAME shared reader improvements:learning_loops
 *      renders from ({@link readLearningLoopHealth}) — firing / pending /
 *      stale / dark-by-design / should-be-on-but-dark / absent.
 *   2. **Flag gate** — each lane's feature flag, resolved live. The
 *      lane→flag map is pinned here and asserted complete against
 *      LEARNING_SINGLETONS by the unit test, so a new loop cannot be added
 *      without deciding its flag column.
 *   3. **Governor budget** — the FB-01 registration (READ-ONLY by owner
 *      decision 2026-07-18): budget / spent / enabled / enforcement. Rows
 *      that match no lane are surfaced in `unmatchedGovernor`, never hidden.
 *
 * Every leg fails soft (a missing migration blanks that leg, never a 500) —
 * the sibling learning.* reads' posture.
 */
import type { Sql } from 'postgres';
import { FLAGS, type FlagKey } from '@papercusp/flags';
import type { LearningLoopHealth } from '../blueprint/learning-loop-health';

/**
 * blueprintId → the feature flag gating that lane's behavior, or null for a
 * lane with no flag gate (always-on by construction). Kept as data so the
 * grid's flag column derives from the flag registry, never a hardcoded
 * boolean. Completeness vs LEARNING_SINGLETONS is unit-asserted.
 */
export const FRONTIER_LANE_FLAGS: Record<string, FlagKey | null> = {
  graduation: FLAGS.GRADUATION_TRACKER,
  'negative-space': FLAGS.NEGATIVE_SPACE_MINER,
  neologism: FLAGS.NEOLOGISM_MINER,
  'fleet-ekg': FLAGS.FLEET_EKG,
  calibration: FLAGS.CALIBRATION_MARKETS,
  'deferral-interest': FLAGS.DEFERRAL_INTEREST,
  'prompt-ablation': FLAGS.PROMPT_ABLATION,
  regret: FLAGS.REGRET_MINING,
  transfer: FLAGS.TRANSFER_HARNESS,
  'red-queen': FLAGS.RED_QUEEN,
  'change-ledger': FLAGS.CHANGE_LEDGER,
  scout: null, // always-on by construction (ALWAYS_ON_LEARNING_LOOPS)
  'iq-battery': null, // always-on by construction
  'memory-precision': FLAGS.MEMORY_PRECISION_BENCH,
  'memory-live-recall-canary': FLAGS.MEMORY_LIVE_RECALL_CANARY,
};

/** The governor registration slice the grid renders (read-only). */
export interface FrontierGovernorInfo {
  loopId: string;
  budgetUsd: number | null;
  spentUsd: number;
  budgetKind: string;
  enabled: boolean;
  enforcement: string;
  priority: number;
}

export interface FrontierLaneSnapshot {
  blueprintId: string;
  alwaysOn: boolean;
  /** firing | pending | stale | dark-by-design | should-be-on-but-dark | absent */
  status: LearningLoopHealth['status'];
  active: boolean;
  collision: boolean;
  expectedMaterialized: boolean;
  lastFiredAt: string | null;
  daysSinceFire: number | null;
  activityLastAt: string | null;
  activitySource: string | null;
  /** The lane's gating feature flag key, or null when always-on/no gate. */
  flagKey: string | null;
  /** Resolved flag state; null when the lane has no flag or the read degraded. */
  flagOn: boolean | null;
  /** FB-01 governor registration (read-only), when one matches this lane. */
  governor: FrontierGovernorInfo | null;
}

export interface FrontierSnapshot {
  lanes: FrontierLaneSnapshot[];
  /** Governor rows matching no lane — surfaced, never silently dropped. */
  unmatchedGovernor: FrontierGovernorInfo[];
  generatedAt: string;
}

/** Tolerant lane↔registration match: exact id, `<id>:…` (the gym:/blender:
 *  per-harness convention), or an id embedded in a longer loopId. */
export function governorRowMatchesLane(loopId: string, blueprintId: string): boolean {
  if (loopId === blueprintId) return true;
  if (loopId.startsWith(`${blueprintId}:`)) return true;
  // scout registers under the blender: prefix (scoutLoopId), not its blueprint id.
  if (blueprintId === 'scout' && loopId.startsWith('blender:')) return true;
  return loopId.includes(blueprintId);
}

export async function readFrontierSnapshot(sql: Sql, workspaceId: string): Promise<FrontierSnapshot> {
  // Leg 1 — liveness, from the shared reader (never re-derived).
  let health: LearningLoopHealth[] = [];
  try {
    const { readLearningLoopHealth } = await import('../blueprint/learning-loop-read');
    health = await readLearningLoopHealth(sql, workspaceId);
  } catch (err) {
    console.warn('[learning.frontier] loop-health read failed:', err instanceof Error ? err.message : err);
  }

  // Leg 2 — flag gates, resolved live; a failed resolution reads null (unknown).
  const flagStates = new Map<string, boolean>();
  try {
    const { getFlag } = await import('@papercusp/flags/server');
    const keys = [...new Set(Object.values(FRONTIER_LANE_FLAGS).filter((k): k is FlagKey => k != null))];
    await Promise.all(
      keys.map(async (key) => {
        try {
          flagStates.set(key, await getFlag(key, 'system'));
        } catch {
          /* leave unknown */
        }
      }),
    );
  } catch (err) {
    console.warn('[learning.frontier] flag read failed:', err instanceof Error ? err.message : err);
  }

  // Leg 3 — governor registrations (read-only slice).
  let governorRows: FrontierGovernorInfo[] = [];
  try {
    const { listLearningLoops } = await import('../learning-governor/store');
    const regs = await listLearningLoops(sql, { workspaceId });
    governorRows = regs.map((r) => ({
      loopId: r.loopId,
      budgetUsd: r.budgetUsd,
      spentUsd: r.spentUsd,
      budgetKind: r.budgetKind,
      enabled: r.enabled,
      enforcement: r.enforcement,
      priority: r.priority,
    }));
  } catch (err) {
    console.warn('[learning.frontier] governor read failed:', err instanceof Error ? err.message : err);
  }

  const matched = new Set<string>();
  const lanes: FrontierLaneSnapshot[] = health.map((h) => {
    const flagKey = FRONTIER_LANE_FLAGS[h.blueprintId] ?? null;
    const gov = governorRows.find((g) => governorRowMatchesLane(g.loopId, h.blueprintId)) ?? null;
    if (gov) matched.add(gov.loopId);
    return {
      blueprintId: h.blueprintId,
      alwaysOn: h.alwaysOn,
      status: h.status,
      active: h.active,
      collision: h.collision,
      expectedMaterialized: h.expectedMaterialized,
      lastFiredAt: h.lastFiredAt,
      daysSinceFire: h.daysSinceFire,
      activityLastAt: h.activityLastAt,
      activitySource: h.activitySource,
      flagKey,
      flagOn: flagKey == null ? null : (flagStates.get(flagKey) ?? null),
      governor: gov,
    };
  });

  return {
    lanes,
    unmatchedGovernor: governorRows.filter((g) => !matched.has(g.loopId)),
    generatedAt: new Date().toISOString(),
  };
}
