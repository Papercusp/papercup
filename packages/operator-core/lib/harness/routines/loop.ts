/**
 * Loops — the engine-side row-construction + wakeup-prompt for a "loop" routine
 * (loop-routines-interval-recurrence-2026-06-20, B-LOOP-5 / P-006 + P-008).
 *
 * A LOOP is the THIRD recurrence kind: a routine that re-fires N seconds AFTER
 * its previous turn COMPLETES — the engine-managed, tracked replacement for
 * Claude Code's built-in `/loop` for su/interactive agents. Unlike `/loop`
 * (in-context, dies with the session, invisible to the operator), a loop is a
 * durable `harness_shared.routines` row: it survives restarts, is observable
 * (fire-history + the work-queue), and inherits the engine's guardrails
 * (failure-streak fire-gate + a cost-cap). It is NOT the autonomous queen/bee/
 * scout loop — that is its own system and is untouched (plan D-007).
 *
 * This mirrors materialize-plan-schedule.ts: a thin function over B-LOOP-1's
 * `upsertRoutine` (su-d5a84) so the loop:arm / loop:end verbs stay ergonomic
 * wrappers and the row shape lives in ONE place. The contract (confirmed with
 * the B-LOOP-1/2/3 owners) — a loop routine row is:
 *   - trigger_kind = 'cron'        → rides listDueCronRoutines + the 30s tick
 *   - trigger_config = {}          → no cron/rrule, so claim.ts treats it as a
 *                                    PURE loop (park at next_fire_at='infinity'
 *                                    in-flight; the completion-rebase re-arms it)
 *   - reschedule_interval_sec = N  → the loop interval (B-LOOP-1 column)
 *   - target_owner_id = ownerId    → the pinned WARM session's coord ownerId,
 *                                    the `coord:send {wake}` recipient (B-LOOP-1
 *                                    column). ownerId is the stable coord
 *                                    identity (survives `claude --resume`), so
 *                                    the loop keeps waking the SAME logical agent
 *   - payload_template.kickoff     → the wakeup prompt B-LOOP-3's fire delivers
 *                                    as the wake turn text
 *   - payload_template.costCapCents→ optional; B-LOOP-3's cost-cap auto-pauses
 *                                    the loop when its cumulative cost crosses it
 *
 * Pure-additive: this file is NEW and only IMPORTS upsertRoutine/setRoutineActive
 * (B-LOOP-1) — it never edits claim.ts / reconcile-plan-runs.ts / routines-
 * workflow.ts (the B-LOOP-2/3 lane), so it composes without collision.
 */
import type { Sql } from 'postgres';
import { getOrgPg, upsertRoutine } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../workspace-registry';
import { computeNextFireAt } from './cron';

/**
 * The `target_role` a loop routine carries. The DBOS fire (B-LOOP-3) recognises
 * a loop by `reschedule_interval_sec IS NOT NULL` + `target_owner_id` (it then
 * delivers a `coord:send {wake}` to the owner instead of the normal loopback
 * fire); `target_role` is NOT NULL in the schema, so a loop gets this stable,
 * self-documenting value (cf. PLAN_RUN_ACTION = 'system:plan-run'). It also keys
 * the per-(install_slug, target_role) failure-streak fire-gate (checkFireGate).
 */
export const LOOP_WAKE_ACTION = 'system:loop-wake';

/**
 * Policy floor for a loop interval, in seconds — the same 60s floor Claude's
 * `/loop` enforces. The DB CHECK (migration 323) only forbids a non-positive
 * interval; this minimum is a policy concern enforced one layer up (the verb).
 * Sub-minute is intentionally NOT supported: the completion-rebase observes the
 * turn settle on the 30s reconcile tick, so the true period is interval +
 * up-to-30s — fine at ≥60s, meaningless below it.
 */
export const LOOP_INTERVAL_FLOOR_SEC = 60;

/** Stable per-session loop routine name — one loop per pinned owner; re-arming
 *  upserts the single row (ON CONFLICT (install_slug, name)). */
export function loopRoutineName(ownerId: string): string {
  // Routine ids are normalized to [a-z0-9_] by upsertRoutine; the name is the
  // upsert key, so keep it deterministic from the ownerId.
  return `loop-${ownerId}`;
}

/**
 * The default per-wake instruction the loop fire delivers (payload_template.kickoff)
 * when the arming agent does not supply a custom `wakePrompt`. It is injected as
 * the looping agent's turn text, so it is addressed to that agent in the second
 * person and stays lean (the agent already carries its warm context across the
 * wake — this is a nudge, not a re-briefing). Placeholders are interpolated by
 * buildLoopWakePrompt at arm time.
 *
 * The create-+-SELF-ASSIGN convention (plan D-006 / B-LOOP-4): each wake, the
 * agent creates its work_items for the iteration and self-assigns them in ONE
 * atomic call (`work_items:create {assign_to:<me>}`, su-1ec26) so the loop's
 * work rides the work-queue (fleet:assignments) — warm + self-owned, no
 * create→claim race, no cold dispatch. `topics` is omitted deliberately: a
 * self-owned loop item needs no topic fanout (keeps a high-frequency loop from
 * spamming topic subscribers).
 */
export const DEFAULT_LOOP_WAKE_PROMPT_TEMPLATE = [
  '🔁 Loop wake (every ~{intervalSec}s after each turn settles). You are continuing your OWN warm session toward: {goal}',
  '',
  'Each wake:',
  "1. Decide the next concrete unit(s) of work. If the goal is DONE or there's nothing left to do, call `loop:end` and stop — do not spin on empty wakes.",
  '2. Create + SELF-ASSIGN each unit as a work_item in ONE atomic call:',
  "     work_items:create { kind:'task', title:'…', harness:'{harness}', assign_to:'{ownerId}' }",
  '   (creates AND claims it for you in one write — your work then shows in fleet:assignments, owned, with no create→claim race). Omit `topics` — a self-owned loop item needs no topic fanout.',
  '3. Do the work; update `work_items:set_state` (in_progress → completed) and your plan as you go.',
  "4. When this iteration's work is done (or you are blocked), END YOUR TURN. The loop re-wakes this same session ~{intervalSec}s after the turn settles.",
  '',
  'To stop: `loop:end`. If you are blocked on something external (a build, another agent, an owner decision), call `loop:end` and say why rather than burning wakes spinning. `loop:status` shows the loop state.',
].join('\n');

/** Interpolate the default wakeup prompt with this loop's specifics. */
export function buildLoopWakePrompt(opts: {
  ownerId: string;
  intervalSec: number;
  harness: string;
  goal: string;
}): string {
  return DEFAULT_LOOP_WAKE_PROMPT_TEMPLATE.replace(/\{intervalSec\}/g, String(opts.intervalSec))
    .replace(/\{harness\}/g, opts.harness)
    .replace(/\{ownerId\}/g, opts.ownerId)
    .replace(/\{goal\}/g, opts.goal);
}

export interface MaterializeLoopInput {
  workspaceId?: string;
  /** install_slug for the routine — the arming agent's harness. */
  harnessSlug: string;
  /** The pinned WARM session's coord ownerId (target_owner_id + the upsert key). */
  ownerId: string;
  /** Loop interval in seconds (the verb enforces ≥ LOOP_INTERVAL_FLOOR_SEC). */
  intervalSec: number;
  /** The wakeup prompt the fire delivers (payload_template.kickoff). */
  kickoff: string;
  /** Optional cost-cap in cents — B-LOOP-3 auto-pauses the loop on breach. */
  costCapCents?: number | null;
  /** Seed active (armed). Default true. */
  active?: boolean;
  /**
   * Seconds from now to the FIRST fire. Default = intervalSec, so the first wake
   * lands one interval after arming (giving the arming turn time to end first).
   * After the first fire the completion-rebase (B-LOOP-2) owns re-arming off each
   * turn's settle.
   */
  firstFireInSec?: number;
  /** Test seams. */
  sql?: Sql;
  now?: Date;
}

/**
 * Upsert the loop routine for an owner (the row B-LOOP-2's rebase + B-LOOP-3's
 * fire consume). Idempotent on (install_slug, name=`loop-<ownerId>`): re-arming
 * the same session updates the one row (new interval / kickoff / cost-cap).
 */
export async function materializeLoop(
  input: MaterializeLoopInput,
): Promise<{ id: string; name: string; nextFireAt: Date | null; targetRole: string }> {
  const sql = input.sql ?? getOrgPg().sql;
  const workspaceId = input.workspaceId ?? activeWorkspaceId();
  const now = input.now ?? new Date();
  const firstFireSec = input.firstFireInSec ?? input.intervalSec;
  // A finite first fire: the existing claim path fires it, then B-LOOP-2's
  // completion-rebase takes over the parked loop. (We deliberately do NOT arm
  // PARKED here — 'infinity' is only reachable via claim, and the rebase keys on
  // a turn settling, which the freshly-armed-but-never-fired loop has not done.)
  const nextFireAt = new Date(now.getTime() + firstFireSec * 1000);

  const payloadTemplate: Record<string, unknown> = { kickoff: input.kickoff };
  if (input.costCapCents != null) payloadTemplate.costCapCents = input.costCapCents;

  const row = await upsertRoutine(
    sql,
    {
      workspaceId,
      installSlug: input.harnessSlug,
      name: loopRoutineName(input.ownerId),
      triggerKind: 'cron', // next_fire_at-driven; rides listDueCronRoutines + the 30s tick
      triggerConfig: {}, // PURE loop — no cron/rrule ⇒ claim.ts parks at 'infinity' in-flight
      targetRole: LOOP_WAKE_ACTION,
      payloadTemplate,
      concurrency: 'skip', // belt-and-suspenders; the 'infinity' park is the real skip-if-in-flight guard
      active: input.active ?? true,
      nextFireAt, // explicit override — upsertRoutine only auto-derives next_fire_at from a cron string
      rescheduleIntervalSec: input.intervalSec,
      targetOwnerId: input.ownerId,
    },
    computeNextFireAt,
  );
  return { id: row.id, name: row.name, nextFireAt: row.nextFireAt, targetRole: row.targetRole };
}

/**
 * End an owner's loop — deactivate its routine so it never fires again (the row
 * is kept for fire-history + a quick re-arm). Keyed on the per-owner routine NAME
 * (`loop-<ownerId>`) so a session can stop its loop without re-supplying the exact
 * harness it armed under. Returns true if a routine was deactivated. Never
 * flag-gated by callers: you must always be able to stop an armed loop.
 */
export async function deactivateLoop(ownerId: string, opts: { sql?: Sql } = {}): Promise<boolean> {
  const sql = opts.sql ?? getOrgPg().sql;
  const result = await sql`
    UPDATE harness_shared.routines
       SET active = FALSE, updated_at = now()
     WHERE name = ${loopRoutineName(ownerId)} AND active = TRUE
  `;
  return Number((result as { count: number }).count ?? 0) > 0;
}

/** A lean view of an owner's loop, for loop:status / observability. */
export interface LoopStatus {
  name: string;
  ownerId: string;
  harnessSlug: string;
  active: boolean;
  intervalSec: number | null;
  /** True while the loop's turn is in flight (parked at next_fire_at='infinity'). */
  parked: boolean;
  /** Next scheduled fire (ISO), or null when parked / unset. */
  nextFireAt: string | null;
  lastFiredAt: string | null;
  costCapCents: number | null;
}

/**
 * Read an owner's loop status (NULL if none). A lean shape rather than the full
 * RoutineRow — and it correctly reads the parked sentinel: postgres-js parses
 * `next_fire_at='infinity'::timestamptz` to an invalid Date, so we detect parked
 * in SQL and never hand a NaN-Date out.
 */
export async function getLoopStatus(
  ownerId: string,
  opts: { sql?: Sql } = {},
): Promise<LoopStatus | null> {
  const sql = opts.sql ?? getOrgPg().sql;
  const name = loopRoutineName(ownerId);
  const rows = await sql<any[]>`
    SELECT install_slug,
           name,
           active,
           reschedule_interval_sec,
           target_owner_id,
           payload_template,
           last_fired_at,
           (next_fire_at = 'infinity'::timestamptz)                      AS parked,
           CASE WHEN next_fire_at = 'infinity'::timestamptz THEN NULL
                ELSE next_fire_at END                                    AS next_fire_at
      FROM harness_shared.routines
     WHERE name = ${name}
     ORDER BY active DESC, updated_at DESC
     LIMIT 1
  `;
  if (rows.length === 0) return null;
  const r = rows[0];
  const costCap = (r.payload_template ?? {})?.costCapCents;
  return {
    name: r.name,
    ownerId: r.target_owner_id ?? ownerId,
    harnessSlug: r.install_slug,
    active: r.active,
    intervalSec: r.reschedule_interval_sec == null ? null : Number(r.reschedule_interval_sec),
    parked: Boolean(r.parked),
    nextFireAt: r.next_fire_at ? new Date(r.next_fire_at).toISOString() : null,
    lastFiredAt: r.last_fired_at ? new Date(r.last_fired_at).toISOString() : null,
    costCapCents: typeof costCap === 'number' ? costCap : null,
  };
}
