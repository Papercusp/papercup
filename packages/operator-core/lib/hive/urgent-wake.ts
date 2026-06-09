/**
 * urgent-wake — the URGENT-enqueue brain bypass (swarm-coordination-architecture
 * P-006 / D-005).
 *
 * The Hive operator (the brain) runs a slow self-declared cadence (~30 min). A
 * genuinely-urgent work-item enqueue must NOT wait it out — it wakes the brain
 * immediately. This composes the hive's EXISTING wake substrate (no second pump):
 *
 *   - **Outside the wake floor** → fire the hive launch NOW (the same
 *     `fireLaunchBlueprint` + `recordHiveWake` path `hive:wake` takes), with an
 *     urgent kickoff naming the item.
 *   - **Inside the floor** (a wake fired < floor ago) → **coalesce**: ensure the
 *     hive's one-shot time-wake fires at the floor boundary, ONLY-ADVANCE (an
 *     already-sooner scheduled wake is left alone; a later one is pulled in).
 *     The floor stays the anti-spin guard — a burst of urgent enqueues collapses
 *     to ONE wake at the boundary, and an urgent item is never stranded until
 *     the cadence wake. Worst-case urgent latency = one floor (default 60s),
 *     never one cadence (~30 min).
 *
 * Note on "rides deliver-and-wake": the await-pump's `emitAwaitedEvent` wakes
 * SLEEPING REGISTERED sessions (bees, via their inbox-wake key). The brain is
 * not an await-registered sleeper — its wake IS the hive blueprint launch — so
 * urgent composes the hive's launch+floor machinery, which is the brain-side
 * twin of deliver-and-wake (same floor/coalesce core, @papercusp/debounce-coalesce).
 *
 * Fail-soft by contract: callers (createWorkItem) fire-and-forget — an enqueue
 * must never fail because the wake path failed. Errors are returned, not thrown.
 */
import { getOrgPg } from '@papercusp/db-org';
import { fireLaunchBlueprint } from '../blueprint/launch-blueprint';
import { activeWorkspaceId } from '../workspace-registry';
import {
  HIVE_BLUEPRINT_ID,
  clampWakeAt,
  declareHiveTimeWake,
  getHiveTimeWake,
  hiveWakeFloorSec,
  readHiveWakeState,
  recordHiveWake,
  resolveHiveHomeSlug,
  withinWakeFloor,
} from './wake';

export interface UrgentHiveWakeResult {
  /** A hive launch fired right now. */
  fired: boolean;
  /** The wake was folded into a floor-boundary one-shot time wake. */
  coalesced: boolean;
  /** When the coalesced wake fires (ISO), when coalesced. */
  at?: string;
  /** Why nothing was changed (no fire, no new schedule). */
  skipped?: 'no_home_harness' | 'already_scheduled_sooner';
  /** Swallowed failure (the caller is fire-and-forget; we report, never throw). */
  error?: string;
}

/**
 * Wake the brain for an urgent enqueue: fire now when outside the wake floor,
 * else coalesce to a floor-boundary time wake (only-advance).
 */
export async function requestUrgentHiveWake(opts: {
  /** Why the brain is being woken — becomes the kickoff context. */
  reason: string;
  /** The item's harness — used as the hive home slug (falls back to PAPERCUSP_HIVE_HOME_SLUG). */
  harness?: string | null;
  workspaceId?: string;
  /** Test seam. */
  now?: number;
}): Promise<UrgentHiveWakeResult> {
  const installSlug = resolveHiveHomeSlug(opts.harness ?? undefined, undefined);
  if (!installSlug) return { fired: false, coalesced: false, skipped: 'no_home_harness' };
  const workspaceId = opts.workspaceId ?? activeWorkspaceId();
  const now = opts.now ?? Date.now();
  const kickoff = `Wake (urgent): ${opts.reason}. You are the operator in charge; survey the fleet and figure out what to do — an URGENT item just landed.`;

  try {
    const state = await readHiveWakeState(workspaceId);
    if (!withinWakeFloor(state, now)) {
      await fireLaunchBlueprint(HIVE_BLUEPRINT_ID, { installSlug, workspaceId, kickoff });
      await recordHiveWake(workspaceId);
      return { fired: true, coalesced: false };
    }

    // Inside the floor: coalesce. The boundary is lastWake + floor; the declare
    // clamp (≥ now + floor) may nudge it slightly later — still bounded by one
    // floor from NOW, which is the guarantee that matters.
    const boundary = new Date((state.lastWakeAt ?? now) + hiveWakeFloorSec() * 1_000);
    const target = clampWakeAt(boundary, new Date(now)).at;
    const { sql } = getOrgPg();
    const cur = await getHiveTimeWake(sql, installSlug);
    if (cur?.active && cur.nextFireAt && cur.nextFireAt.getTime() <= target.getTime()) {
      // Only-advance: a wake is already coming at least this soon — leave it.
      return {
        fired: false,
        coalesced: true,
        at: cur.nextFireAt.toISOString(),
        skipped: 'already_scheduled_sooner',
      };
    }
    const { at } = await declareHiveTimeWake(sql, {
      workspaceId,
      installSlug,
      at: target,
      kickoff,
      now: new Date(now),
    });
    return { fired: false, coalesced: true, at: at.toISOString() };
  } catch (e) {
    return { fired: false, coalesced: false, error: e instanceof Error ? e.message : String(e) };
  }
}
