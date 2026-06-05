/**
 * The Pot's self-declared wake — autoloop-pot-operator-rebuild-2026-06-05 P0
 * (D-002/D-003).
 *
 * The pot's "loop" is the operator deciding its OWN next wake before ending a
 * turn — a time, an event-subscription, or nothing. No timer drives it:
 *
 *   - **Time wake** — a ONE-SHOT `pot-wake` routine row (`harness_shared.routines`,
 *     cron-kind with NO cron expr + an explicit `next_fire_at`). The shipped
 *     durable `routinesTick` claims it once (deactivating it — see
 *     `claimDueRoutine`) and fires `system:blueprint-run { blueprintId: 'pot' }`,
 *     which launches the pot blueprint's decider (the operator role) via the
 *     launch-blueprint primitive. Durable: a host restart never loses the wake.
 *
 *   - **Event wake** — persisted subscriptions (`harness_shared.pot_wake`, one
 *     row per workspace) projected into LIVE event-reaction rules
 *     (`registerReactionRule`) that fire the `pot:wake` tool when the subscribed
 *     tool-event matches. Re-registered at boot (`registerPotWakeRules`) since
 *     the rule registry is in-memory.
 *
 *   - **Nothing** — both cleared; the pot sleeps until the user (or a manual
 *     `pot:wake`) wakes it.
 *
 * A **wake floor** (D-002's clamp) stops a confused operator from spinning: a
 * declared time is clamped to ≥ now+floor, and `pot:wake` skips a fire that
 * lands within the floor of the previous one (the event-burst debounce).
 */
import type { Sql } from 'postgres';
import type { DataCondition } from '@papercusp/rules';
import { getOrgPg, upsertRoutine, setRoutineActive } from '@papercusp/db-org';
import { computeNextFireAt } from '../harness/routines/cron';
import { readOperatorState, updateOperatorState } from '../operator-state-pg';
import { activeWorkspaceId } from '../workspace-registry';
import { registerReactionRule, unregisterReactionRule, listReactionRules } from '../events/registry';

/** The pot launch blueprint id (blueprints/pot/blueprint.yaml). */
export const POT_BLUEPRINT_ID = 'pot';
/** The one-shot wake routine's name (per-harness unique with install_slug). */
export const POT_WAKE_ROUTINE_NAME = 'pot-wake';

/** One persisted event-wake subscription. Serializable (PG JSONB) — so `when`
 *  is the declarative DataCondition form only, never a JS predicate. */
export interface PotEventSubscription {
  /** Trigger tool name(s) — the event-reaction `on` key (e.g. 'coord:escalate'). */
  on: string | string[];
  /** Optional declarative condition over the tool event ({args,result,ctx}). */
  when?: DataCondition;
  /** Why the pot subscribed — surfaced in pot:status + the wake kickoff. */
  note?: string;
}

/** The per-workspace pot_wake state row payload. */
export interface PotWakeState {
  subscriptions: PotEventSubscription[];
  /** ms epoch of the last pot launch fire — the pot:wake floor-debounce input. */
  lastWakeAt?: number;
  /** ms epoch of the last declare-wake call (observability). */
  declaredAt?: number;
}

const EMPTY_STATE: PotWakeState = { subscriptions: [] };

/** The self-wake floor in seconds (D-002's clamp). Env-tunable, hard min 5s. */
export function potWakeFloorSec(): number {
  const n = Number(process.env.PAPERCUSP_POT_WAKE_FLOOR_SEC ?? 60);
  return Number.isFinite(n) && n >= 5 ? n : 60;
}

/** Clamp a requested wake time to ≥ now + the floor. */
export function clampWakeAt(requested: Date, now: Date = new Date()): { at: Date; clamped: boolean } {
  const floorMs = potWakeFloorSec() * 1_000;
  const min = now.getTime() + floorMs;
  if (requested.getTime() < min) return { at: new Date(min), clamped: true };
  return { at: requested, clamped: false };
}

/**
 * Declare (or replace) the pot's one-shot TIME wake: upsert the `pot-wake`
 * routine with an explicit clamped `next_fire_at` and no cron (one-shot —
 * `claimDueRoutine` deactivates it on fire). Returns the effective time.
 */
export async function declarePotTimeWake(
  sql: Sql,
  opts: { workspaceId: string; installSlug: string; at: Date; kickoff?: string; now?: Date },
): Promise<{ at: Date; clamped: boolean }> {
  const { at, clamped } = clampWakeAt(opts.at, opts.now);
  await upsertRoutine(
    sql,
    {
      workspaceId: opts.workspaceId,
      installSlug: opts.installSlug,
      name: POT_WAKE_ROUTINE_NAME,
      triggerKind: 'cron',
      triggerConfig: {}, // no cron expr ⇒ one-shot
      targetRole: 'system:blueprint-run',
      payloadTemplate: {
        blueprintId: POT_BLUEPRINT_ID,
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

/** Clear the pot's time wake (mode 'none', or a declare with no time). */
export async function clearPotTimeWake(sql: Sql, installSlug: string): Promise<void> {
  await setRoutineActive(sql, installSlug, POT_WAKE_ROUTINE_NAME, false);
}

/** Read the pot's time-wake routine state (null = never declared). */
export async function getPotTimeWake(
  sql: Sql,
  installSlug: string,
): Promise<{ active: boolean; nextFireAt: Date | null; lastFiredAt: Date | null } | null> {
  const rows = await sql<Array<{ active: boolean; next_fire_at: Date | null; last_fired_at: Date | null }>>`
    SELECT active, next_fire_at, last_fired_at
      FROM harness_shared.routines
     WHERE install_slug = ${installSlug} AND name = ${POT_WAKE_ROUTINE_NAME}
  `;
  if (rows.length === 0) return null;
  return { active: rows[0].active, nextFireAt: rows[0].next_fire_at, lastFiredAt: rows[0].last_fired_at };
}

// ── event-wake subscriptions ─────────────────────────────────────────────────

const RULE_PREFIX = 'pot-wake';
const ruleId = (workspaceId: string, i: number): string => `${RULE_PREFIX}:${workspaceId}#${i}`;

/** Read the persisted pot wake state for a workspace. */
export async function readPotWakeState(workspaceId?: string): Promise<PotWakeState> {
  return (await readOperatorState<PotWakeState>('pot_wake', workspaceId)) ?? EMPTY_STATE;
}

/**
 * Project a workspace's persisted subscriptions into LIVE reaction rules.
 * Idempotent: removes every `pot-wake:<ws>#*` rule first, then registers the
 * current set. Each rule fires the `pot:wake` tool (the floor-debounce lives
 * there) with static args carrying the subscription's provenance.
 */
export function syncPotWakeRules(workspaceId: string, subs: PotEventSubscription[]): number {
  for (const r of listReactionRules()) {
    if (r.id.startsWith(`${RULE_PREFIX}:${workspaceId}#`)) unregisterReactionRule(r.id);
  }
  let n = 0;
  for (const [i, sub] of subs.entries()) {
    registerReactionRule({
      id: ruleId(workspaceId, i),
      on: sub.on,
      when: sub.when,
      fire: 'pot:wake',
      args: {
        reason: `subscribed event (${Array.isArray(sub.on) ? sub.on.join(', ') : sub.on})${sub.note ? ` — ${sub.note}` : ''}`,
        source: 'event',
      },
      // Durable would survive a restart, but a wake is cheap to lose and MUST
      // not retry-storm the pot — in-process fire-and-forget is right here.
      mode: 'sync',
      onlyOnSuccess: true,
      source: 'pot-wake',
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
export async function setPotEventSubscriptions(
  workspaceId: string,
  subs: PotEventSubscription[],
): Promise<number> {
  await updateOperatorState<PotWakeState>('pot_wake', EMPTY_STATE, (cur) => ({
    ...cur,
    subscriptions: subs,
    declaredAt: Date.now(),
  }));
  return syncPotWakeRules(workspaceId, subs);
}

/**
 * Boot-time re-registration: the rule registry is in-memory, so persisted
 * subscriptions must be projected again on every host start. Fail-soft (a
 * missing table pre-migration must never block boot).
 */
export async function registerPotWakeRules(workspaceId?: string): Promise<number> {
  const ws = workspaceId ?? activeWorkspaceId();
  try {
    const state = await readPotWakeState(ws);
    return syncPotWakeRules(ws, state.subscriptions);
  } catch (e) {
    console.warn(`[pot] wake-rule registration skipped: ${e instanceof Error ? e.message : e}`);
    return 0;
  }
}

// ── the fire-side floor debounce ─────────────────────────────────────────────

/** Whether a pot fire at `now` falls inside the floor window of the last one. */
export function withinWakeFloor(state: PotWakeState, now: number = Date.now()): boolean {
  return state.lastWakeAt != null && now - state.lastWakeAt < potWakeFloorSec() * 1_000;
}

/** Record a pot launch fire (the debounce input for the next one). */
export async function recordPotWake(workspaceId?: string): Promise<void> {
  await updateOperatorState<PotWakeState>(
    'pot_wake',
    EMPTY_STATE,
    (cur) => ({ ...cur, lastWakeAt: Date.now() }),
  );
}

/** Resolve the harness slug the pot runs against: explicit arg → ctx harness →
 *  env default. The pot is workspace-level but the invoke route is
 *  harness-scoped, so a home slug must be named somewhere. */
export function resolvePotHomeSlug(explicit?: string | null, ctxSlug?: string | null): string | null {
  return explicit?.trim() || ctxSlug?.trim() || process.env.PAPERCUSP_POT_HOME_SLUG?.trim() || null;
}
