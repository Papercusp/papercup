/**
 * overwatch/snapshot — the read surface for the Overwatch UI pane
 * (overwatch-role-2026-06-15 B-08).
 *
 * Two reads, one per sync resolver the pane subscribes to:
 *
 *   - `getOverwatchSnapshot()` → the current `OverwatchBrief` (health panels +
 *     anomalies). Per D-006 ("one health aggregation, two consumers") it does NOT
 *     re-aggregate — it reuses the SAME cached `SystemHealth` the Health tab
 *     serves (`lastSystemHealth` / `runSystemHealthTick`) and maps it onto the
 *     actionable C-1 subset via the pure `mapSystemHealthToBrief` + `withAnomalies`
 *     (B-03). Reading the shared cache keeps the pane cheap and consistent with the
 *     Health tab; on a cold/stale cache it warms it with one tick.
 *
 *   - `getOverwatchControlState()` → the persisted Start/Pause bit + cadence
 *     (B-07 control-state.ts) + the live wake liveness (B-09 liveness.ts) + the
 *     `papercusp-overwatch` activation flag (D-009). This is what the pane's header
 *     renders and what `overwatch:start` / `overwatch:pause` invalidate
 *     (`overwatch.controlState`, already wired in B-07).
 *
 * This is the DB-touching read surface — the SPA never imports it; it imports
 * only the pure `OverwatchBrief` / `OverwatchControlState` types from
 * `./brief-types`.
 */
import { getOrgPg } from '@papercusp/db-org';
import { FLAGS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';
import { activeWorkspaceId } from '../workspace-registry';
import { resolveHiveHomeSlug } from '../hive/wake';
import { lastSystemHealth, runSystemHealthTick } from '../system-health';
import { mapSystemHealthToBrief, withAnomalies } from './compute-brief';
import { emptyOverwatchBrief, type OverwatchBrief, type OverwatchControlState } from './brief-types';
import {
  getOverwatchStarted,
  getOverwatchCadenceSec,
  listStartedOverwatches,
  DEFAULT_OVERWATCH_CADENCE_SEC,
} from './control-state';
import { overwatchLivenessCheck } from './liveness';

/** Reuse the shared SystemHealth cache when it is at most this fresh (matches the
 *  Health tab's read floor); past it, warm the cache with one tick. */
const SNAPSHOT_MAX_AGE_MS = 30_000;

/**
 * The current `OverwatchBrief` for the overwatch's hive — the actionable subset
 * of the shared `SystemHealth` model (D-006). Fail-soft: a catastrophic compute
 * failure (or a cold cache that can't warm) degrades to the neutral
 * `emptyOverwatchBrief` (healthy + no anomalies) rather than erroring the pane.
 */
export async function getOverwatchSnapshot(opts?: {
  workspaceId?: string;
  hiveSlug?: string;
  maxAgeMs?: number;
}): Promise<OverwatchBrief> {
  const ws = opts?.workspaceId ?? activeWorkspaceId();
  const maxAgeMs = opts?.maxAgeMs ?? SNAPSHOT_MAX_AGE_MS;

  // D-006: ONE health aggregation, TWO consumers. Read the SAME cache the Health
  // tab serves; recompute on a cold/stale miss. We deliberately do NOT gate on
  // SYSTEM_HEALTH_TAB here (that gates the tab/getSystemHealth) — the overwatch
  // brief stays on its OWN flag, surfaced via the pane's flag gate + control state.
  let health = lastSystemHealth(ws);
  if (!health || Date.now() - health.evaluatedAt > maxAgeMs) {
    health = await runSystemHealthTick(ws).catch(() => null);
  }

  const hiveSlug = opts?.hiveSlug ?? health?.panels.queen.data?.hiveSlug ?? resolveHiveHomeSlug() ?? ws;
  if (!health) return emptyOverwatchBrief(hiveSlug);
  return withAnomalies(mapSystemHealthToBrief(health, hiveSlug));
}

/** Resolve the hive the overwatch supervises (v1 single-hive, D-005): an explicit
 *  slug → the env home slug → the first started overwatch (this workspace first). */
async function resolveOverwatchInstallSlug(ws: string, explicit?: string): Promise<string | null> {
  const direct = explicit ?? resolveHiveHomeSlug();
  if (direct) return direct;
  const started = await listStartedOverwatches().catch(() => []);
  return started.find((s) => s.workspaceId === ws)?.installSlug ?? started[0]?.installSlug ?? null;
}

/**
 * The overwatch's persisted control state + liveness — the pane header's data.
 * `started && !flagEnabled` means PRE-ARMED (the bit is set, awaiting the flag
 * flip, B-12). Every read is independently fail-soft so a degraded source greys
 * its field instead of erroring the whole pane.
 */
export async function getOverwatchControlState(opts?: {
  workspaceId?: string;
  hiveSlug?: string;
}): Promise<OverwatchControlState> {
  const ws = opts?.workspaceId ?? activeWorkspaceId();
  const installSlug = await resolveOverwatchInstallSlug(ws, opts?.hiveSlug);
  const flagEnabled = await getFlag(FLAGS.OVERWATCH, `overwatch:${ws}`).catch(() => false);

  if (!installSlug) {
    return {
      hiveSlug: null,
      started: false,
      cadenceSec: DEFAULT_OVERWATCH_CADENCE_SEC,
      flagEnabled,
      armed: false,
      nextWakeAt: null,
      lastWakeAt: null,
      staleForMs: null,
    };
  }

  const { sql } = getOrgPg();
  const [started, cadenceSec, liveness] = await Promise.all([
    getOverwatchStarted(ws, installSlug).catch(() => false),
    getOverwatchCadenceSec(ws, installSlug).catch(() => DEFAULT_OVERWATCH_CADENCE_SEC),
    overwatchLivenessCheck(sql, installSlug).catch(() => ({
      armed: false,
      nextFireAt: null,
      lastFiredAt: null,
      staleForMs: null,
    })),
  ]);

  return {
    hiveSlug: installSlug,
    started,
    cadenceSec,
    flagEnabled,
    armed: liveness.armed,
    nextWakeAt: liveness.nextFireAt ? liveness.nextFireAt.toISOString() : null,
    lastWakeAt: liveness.lastFiredAt ? liveness.lastFiredAt.toISOString() : null,
    staleForMs: liveness.staleForMs,
  };
}
