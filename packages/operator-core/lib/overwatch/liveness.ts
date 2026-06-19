/**
 * overwatch/liveness — the overwatch wake-state + liveness primitives
 * (overwatch-role-2026-06-15 B-09: the who-watches-the-watcher floor).
 *
 * Overwatch rides the SAME autonomous-loop shape as the Queen (a precomputed
 * brief, a self-declared next wake, a deterministic liveness backstop) but on
 * its OWN wake channel — it does NOT ride the Queen's `hive-wake` (that would
 * collide). This module owns that channel's durable state + the pure liveness
 * read, mirroring the hive's `wake.ts` + `watchdog.ts` split:
 *
 *   - `declareOverwatchTimeWake` / `getOverwatchTimeWake` / `clearOverwatchTimeWake`
 *     — the one-shot `overwatch-wake` routine row. This is the SHARED SEAM: B-09's
 *     watchdog (./watchdog.ts) re-arms through `declareOverwatchTimeWake`, and
 *     B-04's loop reuses the SAME primitive for its declare-next-wake (mirroring
 *     how `armFallbackHiveWake` and `hive:declare-wake` both call
 *     `declareHiveTimeWake`). Routine NAME + TARGET ACTION are the contract.
 *   - `overwatchLivenessCheck` — the one-row "is overwatch alive?" read the
 *     watchdog (re-wake when stalled) + the cross-monitor (the Queen's
 *     `overwatchAlive` signal) both rest on. Mirrors `hiveLivenessCheck`.
 *
 * Liveness derives PURELY from the `overwatch-wake` routine row (active +
 * next_fire_at = armed; last_fired_at = last wake activity) — no new
 * operator-state table, so B-09 needs no migration.
 *
 * The routine FIRE → launch-of-role=overwatch wiring is B-04's (`C-3`): the
 * `overwatch-wake` routine targets `OVERWATCH_WAKE_TARGET_ACTION`, which B-04
 * registers to invoke role=overwatch with the computed brief. Until B-04 lands
 * (and the `papercusp-overwatch` flag flips — B-10/D-009), the whole channel is
 * flag-gated dark, so a re-armed wake never fires a half-wired launch.
 */
import type { Sql } from 'postgres';
import { clampToFloor } from '@papercusp/debounce-coalesce';
import { upsertRoutine, setRoutineActive, deleteRoutine } from '@papercusp/db-org';
import { computeNextFireAt } from '../harness/routines/cron';

/** The overwatch role id (C-2, B-01). */
export const OVERWATCH_ROLE = 'overwatch';

/** The hive blueprint overwatch monitors (D-005 per-hive scope; v1 = one hive). */
export const OVERWATCH_BLUEPRINT_ID = 'coding';

/** The one-shot wake routine's name (per-harness unique with install_slug).
 *  Deliberately distinct from `hive-wake` so the two wake channels never
 *  collide (the architecture's hard requirement). */
export const OVERWATCH_WAKE_ROUTINE_NAME = 'overwatch-wake';

/**
 * The system-action the `overwatch-wake` routine fires when due — the CONTRACT
 * with B-04 (C-3). B-04 registers this action to launch role=overwatch with the
 * computed `OverwatchBrief` injected. It is intentionally NOT `system:blueprint-run`
 * (that fires the blueprint's DECIDER — the Queen — which would wake the wrong
 * role). If B-04 prefers a different action name, change it HERE (one constant)
 * and the watchdog re-arm follows.
 */
export const OVERWATCH_WAKE_TARGET_ACTION = 'system:overwatch-launch';

/** The self-wake floor in seconds — env-tunable, hard min 5s (mirrors the hive). */
export function overwatchWakeFloorSec(): number {
  const n = Number(process.env.PAPERCUSP_OVERWATCH_WAKE_FLOOR_SEC ?? 60);
  return Number.isFinite(n) && n >= 5 ? n : 60;
}

/** Clamp a requested wake time to ≥ now + the floor (delegates to the shared
 *  debounce-coalesce core, like the hive's `clampWakeAt`). */
export function clampOverwatchWakeAt(requested: Date, now: Date = new Date()): { at: Date; clamped: boolean } {
  const { at, clamped } = clampToFloor({
    requestedAt: requested.getTime(),
    minSleepMs: overwatchWakeFloorSec() * 1_000,
    now: now.getTime(),
  });
  return { at: new Date(at), clamped };
}

/**
 * Declare (or replace) overwatch's one-shot TIME wake: upsert the `overwatch-wake`
 * routine with an explicit clamped `next_fire_at` and no cron (one-shot —
 * `claimDueRoutine` deactivates it on fire). Returns the effective time.
 *
 * Shared by B-09's watchdog re-arm and B-04's declare-next-wake.
 */
export async function declareOverwatchTimeWake(
  sql: Sql,
  opts: { workspaceId: string; installSlug: string; at: Date; kickoff?: string; now?: Date },
): Promise<{ at: Date; clamped: boolean }> {
  const { at, clamped } = clampOverwatchWakeAt(opts.at, opts.now);
  // EI-1472: the overwatch wake is a SINGLETON keyed by (install_slug, name) — the
  // global routines_install_slug_name_key enforces ONE row per install regardless of
  // workspace. When the per-workspace conflict (workspace-data-isolation-leaks F-E1) is
  // ON, upsertRoutine conflicts on (workspace_id, install_slug, name); if the existing
  // singleton lives under a DIFFERENT workspace_id than the caller's ctx, that conflict
  // target misses and the INSERT collides with the global constraint → duplicate-key
  // throw, so the overwatch can't re-arm (forced onto the liveness backstop). Pin the
  // upsert to the EXISTING row's workspace so it always UPDATEs the singleton in place
  // (harmless under the legacy (install_slug, name) conflict, which updates regardless).
  const existing = await sql<Array<{ workspace_id: string }>>`
    SELECT workspace_id FROM harness_shared.routines
     WHERE install_slug = ${opts.installSlug} AND name = ${OVERWATCH_WAKE_ROUTINE_NAME}
     LIMIT 1
  `;
  await upsertRoutine(
    sql,
    {
      workspaceId: existing[0]?.workspace_id ?? opts.workspaceId,
      installSlug: opts.installSlug,
      name: OVERWATCH_WAKE_ROUTINE_NAME,
      triggerKind: 'cron',
      triggerConfig: {}, // no cron expr ⇒ one-shot
      targetRole: OVERWATCH_WAKE_TARGET_ACTION,
      payloadTemplate: {
        blueprintId: OVERWATCH_BLUEPRINT_ID,
        role: OVERWATCH_ROLE,
        kickoff:
          opts.kickoff ??
          `Self-declared overwatch wake (declared ${new Date().toISOString()}). Survey system health and act on the anomalies.`,
      },
      concurrency: 'skip',
      catchup: 'skip-old',
      active: true,
      nextFireAt: at,
    },
    computeNextFireAt,
  );
  return { at, clamped };
}

/** Clear overwatch's time wake (deactivate the one-shot routine).
 *  EI-1477: DELETE the row (not just deactivate) to avoid duplicate-key conflicts
 *  under concurrency when a stale/orphaned row would collide with a new UPSERT. */
export async function clearOverwatchTimeWake(sql: Sql, installSlug: string): Promise<void> {
  await deleteRoutine(sql, installSlug, OVERWATCH_WAKE_ROUTINE_NAME);
}

/** timestamptz arrives as Date or ISO string depending on the pool's type
 *  parsers (EI-257: the boot-path pool returns strings) — normalise to Date. */
function toDateOrNull(v: Date | string | null): Date | null {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Read overwatch's time-wake routine state (null = never declared). Mirrors
 *  `getHiveTimeWake`. */
export async function getOverwatchTimeWake(
  sql: Sql,
  installSlug: string,
): Promise<{ active: boolean; nextFireAt: Date | null; lastFiredAt: Date | null } | null> {
  const rows = await sql<
    Array<{ active: boolean; next_fire_at: Date | string | null; last_fired_at: Date | string | null }>
  >`
    SELECT active, next_fire_at, last_fired_at
      FROM harness_shared.routines
     WHERE install_slug = ${installSlug} AND name = ${OVERWATCH_WAKE_ROUTINE_NAME}
  `;
  if (rows.length === 0) return null;
  return {
    active: rows[0].active,
    nextFireAt: toDateOrNull(rows[0].next_fire_at),
    lastFiredAt: toDateOrNull(rows[0].last_fired_at),
  };
}

/** The pure liveness read for overwatch (mirrors `HiveLiveness`). */
export interface OverwatchLiveness {
  /** An active `overwatch-wake` routine with a next_fire_at exists. */
  armed: boolean;
  nextFireAt: Date | null;
  lastFiredAt: Date | null;
  /** ms since the last wake fire; null = never fired (no channel yet / brand new). */
  staleForMs: number | null;
}

/**
 * The one-row "is overwatch alive?" check (mirrors `hiveLivenessCheck`): does an
 * active wake row exist, and how long since it last fired if not. Liveness is
 * derived from the routine row alone (no operator-state row), so this read works
 * the moment B-04's loop has declared even one wake.
 */
export async function overwatchLivenessCheck(
  sql: Sql,
  installSlug: string,
  opts: { now?: number } = {},
): Promise<OverwatchLiveness> {
  const now = opts.now ?? Date.now();
  const time = await getOverwatchTimeWake(sql, installSlug);
  const armed = Boolean(time?.active && time.nextFireAt);
  const lastFired = time?.lastFiredAt?.getTime() ?? 0;
  return {
    armed,
    nextFireAt: time?.nextFireAt ?? null,
    lastFiredAt: time?.lastFiredAt ?? null,
    staleForMs: lastFired > 0 ? Math.max(0, now - lastFired) : null,
  };
}
