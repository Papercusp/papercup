/**
 * The Hive's self-declared wake — autoloop-hive-operator-rebuild-2026-06-05 P0
 * (D-002/D-003).
 *
 * The hive's "loop" is the operator deciding its OWN next wake before ending a
 * turn — a time, an event-subscription, or nothing. No timer drives it:
 *
 *   - **Time wake** — a ONE-SHOT `hive-wake` routine row (`harness_shared.routines`,
 *     cron-kind with NO cron expr + an explicit `next_fire_at`). The shipped
 *     durable `routinesTick` claims it once (deactivating it — see
 *     `claimDueRoutine`) and fires `system:blueprint-run { blueprintId: 'hive' }`,
 *     which launches the hive blueprint's decider (the operator role) via the
 *     launch-blueprint primitive. Durable: a host restart never loses the wake.
 *
 *   - **Event wake** — persisted subscriptions (`operator-state key hive_wake`, one
 *     row per workspace) projected into LIVE event-reaction rules
 *     (`registerReactionRule`) that fire the `hive:wake` tool when the subscribed
 *     tool-event matches. Re-registered at boot (`registerHiveWakeRules`) since
 *     the rule registry is in-memory.
 *
 *   - **Nothing** — both cleared; the hive sleeps until the user (or a manual
 *     `hive:wake`) wakes it.
 *
 * A **wake floor** (D-002's clamp) stops a confused operator from spinning: a
 * declared time is clamped to ≥ now+floor, and `hive:wake` skips a fire that
 * lands within the floor of the previous one (the event-burst debounce).
 */
import type { Sql } from 'postgres';
import type { DataCondition } from '@papercusp/rules';
import { clampToFloor, withinFloor } from '@papercusp/debounce-coalesce';
import { getOrgPg, upsertRoutine, setRoutineActive } from '@papercusp/db-org';
import { computeNextFireAt } from '../harness/routines/cron';
import { readOperatorState, updateOperatorState } from '../operator-state-pg';
import { activeWorkspaceId } from '../workspace-registry';
import { registerReactionRule, unregisterReactionRule, listReactionRules } from '../events/registry';

/** The hive launch blueprint id (blueprints/hive/blueprint.yaml). */
export const HIVE_BLUEPRINT_ID = 'hive';
/** The one-shot wake routine's name (per-harness unique with install_slug). */
export const HIVE_WAKE_ROUTINE_NAME = 'hive-wake';

/** One persisted event-wake subscription. Serializable (PG JSONB) — so `when`
 *  is the declarative DataCondition form only, never a JS predicate. */
export interface HiveEventSubscription {
  /** Trigger tool name(s) — the event-reaction `on` key (e.g. 'coord:escalate'). */
  on: string | string[];
  /** Optional declarative condition over the tool event ({args,result,ctx}). */
  when?: DataCondition;
  /** Why the hive subscribed — surfaced in hive:status + the wake kickoff. */
  note?: string;
}

/** The per-workspace hive_wake state row payload. */
export interface HiveWakeState {
  subscriptions: HiveEventSubscription[];
  /** ms epoch of the last hive launch fire — the hive:wake floor-debounce input. */
  lastWakeAt?: number;
  /** ms epoch of the last declare-wake call (observability). */
  declaredAt?: number;
  /**
   * The Queen's self-authored CARRY-NOTE for her NEXT wake
   * (queen-brief-cache-assembly-2026-06-13 P-015 / B-04). Replace-semantics
   * (set fresh each declare-wake, any length / no fixed cap, omitted ⇒ cleared);
   * injected into the next wake's brief tail as the additive second half of the
   * brief (the deterministic floor is the first half — `renderQueenBrief`).
   * Her subjective in-flight intention, NOT objective world-state. Empty/absent
   * ⇒ the next wake re-derives from the floor alone (graceful degradation).
   */
  carryNote?: string;
}

const EMPTY_STATE: HiveWakeState = { subscriptions: [] };

/** The self-wake floor in seconds (D-002's clamp). Env-tunable, hard min 5s. */
export function hiveWakeFloorSec(): number {
  const n = Number(process.env.PAPERCUSP_HIVE_WAKE_FLOOR_SEC ?? 60);
  return Number.isFinite(n) && n >= 5 ? n : 60;
}

/**
 * The effective wake floor in seconds: MAX(system floor, owner override). The owner
 * cadence-floor knob (queen-steering-panel P-006) can only RAISE the interval (slow
 * the loop) — never drop below the system minimum. `ownerFloorSec` undefined/≤0 ⇒
 * the system floor unchanged (today's behaviour). Pure; the async resolver below
 * reads the owner value and calls this.
 */
function effectiveWakeFloorSec(ownerFloorSec?: number): number {
  return Math.max(hiveWakeFloorSec(), ownerFloorSec && ownerFloorSec > 0 ? ownerFloorSec : 0);
}

/** Clamp a requested wake time to ≥ now + the floor. Delegates the floor math to the
 *  shared `@papercusp/debounce-coalesce` core (the hive is no longer a special case —
 *  unify-watch-primitive-2026-06-06 P-006/D-009). `ownerFloorSec` (queen-steering-panel
 *  P-006) RAISES the floor when the owner set a wake-cadence floor — MAX(system, owner). */
export function clampWakeAt(
  requested: Date,
  now: Date = new Date(),
  ownerFloorSec?: number,
): { at: Date; clamped: boolean } {
  const { at, clamped } = clampToFloor({
    requestedAt: requested.getTime(),
    minSleepMs: effectiveWakeFloorSec(ownerFloorSec) * 1_000,
    now: now.getTime(),
  });
  return { at: new Date(at), clamped };
}

/**
 * Resolve the EFFECTIVE wake floor for a Hive — MAX(system floor, the owner's
 * `cadence-floor-sec` steering knob), fail-soft to the system floor (P-006, D-005).
 * The single async read the cadence-aware seams (declareHiveTimeWake, urgent-wake,
 * the hive:wake debounce) call once, then thread the number into the pure
 * clampWakeAt / withinWakeFloor below.
 */
export async function effectiveHiveWakeFloorSec(workspaceId: string, installSlug: string): Promise<number> {
  try {
    const { getOwnerSteering, effectiveCadenceFloorSec } = await import('../owner-steering');
    const s = await getOwnerSteering(workspaceId, installSlug);
    return effectiveCadenceFloorSec(s, hiveWakeFloorSec());
  } catch {
    return hiveWakeFloorSec();
  }
}

/**
 * Declare (or replace) the hive's one-shot TIME wake: upsert the `hive-wake`
 * routine with an explicit clamped `next_fire_at` and no cron (one-shot —
 * `claimDueRoutine` deactivates it on fire). Returns the effective time.
 */
export async function declareHiveTimeWake(
  sql: Sql,
  opts: {
    workspaceId: string;
    installSlug: string;
    at: Date;
    kickoff?: string;
    now?: Date;
    blueprintId?: string;
    /** Pre-resolved effective wake floor (seconds) — pass it when the caller
     *  already read owner-steering (urgent-wake) to avoid a second read; omitted ⇒
     *  resolved here via effectiveHiveWakeFloorSec (queen-steering-panel P-006). */
    floorSec?: number;
  },
): Promise<{ at: Date; clamped: boolean }> {
  // Owner cadence-floor (P-006): the Queen's self-declared wake is clamped up to the
  // owner's floor. Resolve it here (so every declare-wake path — incl. the hive:declare-wake
  // tool — is owner-aware with no call-site change) unless the caller pre-resolved it.
  const floorSec = opts.floorSec ?? (await effectiveHiveWakeFloorSec(opts.workspaceId, opts.installSlug));
  const { at, clamped } = clampWakeAt(opts.at, opts.now, floorSec);
  // EI-1477 (sibling of EI-1472): the hive wake is a SINGLETON keyed by (install_slug,
  // name) — the global routines_install_slug_name_key enforces ONE row per install
  // regardless of workspace. With per-workspace ON CONFLICT (F-E1) on, upsertRoutine
  // conflicts on (workspace_id, install_slug, name); if the existing singleton lives
  // under a DIFFERENT workspace_id than the caller's ctx, that target misses and the
  // INSERT collides with the global constraint → duplicate-key throw, so the Queen
  // can't re-arm her wake. Pin the upsert to the EXISTING row's workspace (UPDATE in
  // place; harmless under the legacy (install_slug, name) conflict).
  const existing = await sql<Array<{ workspace_id: string }>>`
    SELECT workspace_id FROM harness_shared.routines
     WHERE install_slug = ${opts.installSlug} AND name = ${HIVE_WAKE_ROUTINE_NAME}
     LIMIT 1
  `;
  await upsertRoutine(
    sql,
    {
      workspaceId: existing[0]?.workspace_id ?? opts.workspaceId,
      installSlug: opts.installSlug,
      name: HIVE_WAKE_ROUTINE_NAME,
      triggerKind: 'cron',
      triggerConfig: {}, // no cron expr ⇒ one-shot
      targetRole: 'system:blueprint-run',
      payloadTemplate: {
        blueprintId: opts.blueprintId ?? HIVE_BLUEPRINT_ID,
        kickoff:
          opts.kickoff ??
          `Self-declared wake (declared ${new Date().toISOString()}). You are the operator in charge; survey the fleet and figure out what to do.`,
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

/** Clear the hive's time wake (mode 'none', or a declare with no time). */
export async function clearHiveTimeWake(sql: Sql, installSlug: string): Promise<void> {
  await setRoutineActive(sql, installSlug, HIVE_WAKE_ROUTINE_NAME, false);
}

/** timestamptz arrives as Date or ISO string depending on the pool's type
 *  parsers (EI-257: the boot-path pool returns strings — `.getTime()` on one
 *  threw in every watchdog liveness check and flooded the console). */
function toDateOrNull(v: Date | string | null): Date | null {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Read the hive's time-wake routine state (null = never declared). */
export async function getHiveTimeWake(
  sql: Sql,
  installSlug: string,
): Promise<{ active: boolean; nextFireAt: Date | null; lastFiredAt: Date | null } | null> {
  const rows = await sql<
    Array<{ active: boolean; next_fire_at: Date | string | null; last_fired_at: Date | string | null }>
  >`
    SELECT active, next_fire_at, last_fired_at
      FROM harness_shared.routines
     WHERE install_slug = ${installSlug} AND name = ${HIVE_WAKE_ROUTINE_NAME}
  `;
  if (rows.length === 0) return null;
  return {
    active: rows[0].active,
    nextFireAt: toDateOrNull(rows[0].next_fire_at),
    lastFiredAt: toDateOrNull(rows[0].last_fired_at),
  };
}

// ── event-wake subscriptions ─────────────────────────────────────────────────

const RULE_PREFIX = 'hive-wake';
const ruleId = (workspaceId: string, i: number): string => `${RULE_PREFIX}:${workspaceId}#${i}`;

/** Read the persisted hive wake state for a workspace. */
export async function readHiveWakeState(workspaceId?: string): Promise<HiveWakeState> {
  return (await readOperatorState<HiveWakeState>('hive_wake', workspaceId)) ?? EMPTY_STATE;
}

/**
 * Project a workspace's persisted subscriptions into LIVE reaction rules.
 * Idempotent: removes every `hive-wake:<ws>#*` rule first, then registers the
 * current set. Each rule fires the `hive:wake` tool (the floor-debounce lives
 * there) with static args carrying the subscription's provenance.
 */
export function syncHiveWakeRules(workspaceId: string, subs: HiveEventSubscription[]): number {
  for (const r of listReactionRules()) {
    if (r.id.startsWith(`${RULE_PREFIX}:${workspaceId}#`)) unregisterReactionRule(r.id);
  }
  let n = 0;
  for (const [i, sub] of subs.entries()) {
    registerReactionRule({
      id: ruleId(workspaceId, i),
      on: sub.on,
      when: sub.when,
      fire: 'hive:wake',
      args: {
        reason: `subscribed event (${Array.isArray(sub.on) ? sub.on.join(', ') : sub.on})${sub.note ? ` — ${sub.note}` : ''}`,
        source: 'event',
      },
      // Durable would survive a restart, but a wake is cheap to lose and MUST
      // not retry-storm the hive — in-process fire-and-forget is right here.
      mode: 'sync',
      onlyOnSuccess: true,
      source: 'hive-wake',
    });
    n++;
  }
  return n;
}

/**
 * Replace the persisted event subscriptions (+ live rules) for a workspace.
 * REPLACE semantics, like coord:declare-intent: each declare describes the
 * whole wake; omitted ⇒ cleared.
 */
export async function setHiveEventSubscriptions(
  workspaceId: string,
  subs: HiveEventSubscription[],
): Promise<number> {
  await updateOperatorState<HiveWakeState>('hive_wake', EMPTY_STATE, (cur) => ({
    ...cur,
    subscriptions: subs,
    declaredAt: Date.now(),
  }), workspaceId);
  return syncHiveWakeRules(workspaceId, subs);
}

/**
 * Set (or clear) the Queen's self-authored carry-note for her next wake
 * (P-015 / B-04). REPLACE-semantics, like the wake declaration itself: a
 * non-empty string replaces the stored note; `null`/`undefined`/blank clears it
 * (she chose not to carry anything — the next wake re-derives from the floor).
 * Stored in the same `hive_wake` operator-state row, so it rides the existing
 * PG-backed store (no migration). Returns the stored note (trimmed) or null.
 */
export async function setHiveCarryNote(
  workspaceId: string,
  note: string | null | undefined,
): Promise<string | null> {
  const trimmed = (note ?? '').trim();
  const carryNote = trimmed.length > 0 ? trimmed : undefined;
  await updateOperatorState<HiveWakeState>('hive_wake', EMPTY_STATE, (cur) => ({
    ...cur,
    carryNote,
  }), workspaceId);
  return carryNote ?? null;
}

/**
 * Read the Queen's carry-note stored for the current wake (P-015 / B-04) — the
 * additive second half of her brief. Null when she carried nothing. The brief
 * builder (B-05 / the wake-invocation seam) passes this to
 * `renderQueenBrief({ carryNote })`.
 */
export async function getHiveCarryNote(workspaceId?: string): Promise<string | null> {
  const state = await readHiveWakeState(workspaceId);
  const note = (state.carryNote ?? '').trim();
  return note.length > 0 ? note : null;
}

/**
 * Boot-time re-registration: the rule registry is in-memory, so persisted
 * subscriptions must be projected again on every host start. Fail-soft (a
 * missing table pre-migration must never block boot).
 */
export async function registerHiveWakeRules(workspaceId?: string): Promise<number> {
  const ws = workspaceId ?? activeWorkspaceId();
  try {
    const state = await readHiveWakeState(ws);
    return syncHiveWakeRules(ws, state.subscriptions);
  } catch (e) {
    console.warn(`[hive] wake-rule registration skipped: ${e instanceof Error ? e.message : e}`);
    return 0;
  }
}

// ── the fire-side floor debounce ─────────────────────────────────────────────

/** Whether a hive fire at `now` falls inside the floor window of the last one. Delegates
 *  to the shared `@papercusp/debounce-coalesce` floor (P-006/D-009): the hive consumes the
 *  SAME core every other wake-subscription now uses, rather than a bespoke comparison. */
export function withinWakeFloor(state: HiveWakeState, now: number = Date.now(), ownerFloorSec?: number): boolean {
  return withinFloor({
    lastWokenAt: state.lastWakeAt ?? null,
    minSleepMs: effectiveWakeFloorSec(ownerFloorSec) * 1_000,
    now,
  });
}

/** Record a hive launch fire (the debounce input for the next one). */
export async function recordHiveWake(workspaceId?: string): Promise<void> {
  await updateOperatorState<HiveWakeState>(
    'hive_wake',
    EMPTY_STATE,
    (cur) => ({ ...cur, lastWakeAt: Date.now() }),
    workspaceId,
  );
}

/** Resolve the harness slug the hive runs against: explicit arg → ctx harness →
 *  env default. The hive is workspace-level but the invoke route is
 *  harness-scoped, so a home slug must be named somewhere. */
export function resolveHiveHomeSlug(explicit?: string | null, ctxSlug?: string | null): string | null {
  return explicit?.trim() || ctxSlug?.trim() || process.env.PAPERCUSP_HIVE_HOME_SLUG?.trim() || null;
}
