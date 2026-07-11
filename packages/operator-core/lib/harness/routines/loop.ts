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
import { getOrgPg, normalizeNextFireAt, upsertRoutine } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../workspace-registry';
import { computeNextFireAt } from './cron';
import { stampLoopArmedAt } from './loop-dead-man';

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

/** Stable per-session loop routine name — one loop per pinned owner. */
export function loopRoutineName(ownerId: string): string {
  // Routine ids are normalized to [a-z0-9_] by upsertRoutine; the name is the
  // upsert key, so keep it deterministic from the ownerId.
  return `loop-${ownerId}`;
}

export function loopRoutineId(harnessSlug: string, ownerId: string): string {
  return `rt_${harnessSlug}_${loopRoutineName(ownerId)}`.replace(/[^a-z0-9_]/gi, '_').toLowerCase();
}

/**
 * The default per-wake instruction the loop fire delivers (payload_template.kickoff)
 * when the arming agent does not supply a custom `wakePrompt`. It is injected as
 * the looping agent's turn text, so it is addressed to that agent in the second
 * person and stays lean (the agent already carries its warm context across the
 * wake — this is a nudge, not a re-briefing). Placeholders are interpolated by
 * buildLoopWakePrompt at arm time.
 *
 * fleet-member-native-guidance-2026-07-10 P-008: the create-+-SELF-ASSIGN-+-FINISH
 * contract (D-006 / B-LOOP-4 / EI-7674 / EI-7478) is now NATIVE to every su session
 * via the base persona's "Working as a fleet MEMBER — the member operating loop"
 * section (P-001, same plan) — so re-spelling the full mechanics here every FULL-form
 * wake (isLoopWakeFullForm, 1-in-10 by default) was pure re-teaching. This template
 * now POINTS at that persona section instead of restating it; only the loop-specific
 * mechanics NOT covered by the persona (the wake cadence, the harness/owner ids to
 * fill in, the end-turn + loop:end/loop:status instructions) stay spelled out here.
 */
export const DEFAULT_LOOP_WAKE_PROMPT_TEMPLATE = [
  '🔁 Loop wake (every ~{intervalSec}s after each turn settles). You are continuing your OWN warm session toward: {goal}',
  '',
  'Each wake:',
  "1. Decide the next concrete unit(s) of work. If the goal is DONE or there's nothing left to do, call `loop:end` and stop — do not spin on empty wakes. An idle SELF-PULLER (your scheduler:get_next / work_items:claim_next came back empty) parks on events instead of polling: register ONE `events:await { event: \"work-item:claimable\", when: <your claim spec's view>, timeout_sec: 1800 }`, then `loop:end` — the wake re-invokes you; your pull stays the authoritative claim (re-register on a re-miss).",
  '2. Work it per your persona\'s "Working as a fleet MEMBER — the member operating loop" contract — create + ' +
    'self-assign the unit atomically, pick `kind` by what it IS, finish with `work_items:complete { completion }` ' +
    'evidence (never a bare "done" assertion). harness:{harness}, assign_to:{ownerId}.',
  "3. When this iteration's work is done (or you are blocked), END YOUR TURN. The loop re-wakes this same session ~{intervalSec}s after the turn settles.",
  '',
  'To stop: `loop:end`. If you are blocked on something external (a build, another agent, an owner decision), call `loop:end` and say why rather than burning wakes spinning. `loop:status` shows the loop state.',
].join('\n');

/**
 * MONITOR-mode wake template (compaction-continuity-hardening-2026-07-07 P-001c). A
 * leader/supervisor loop that WATCHES (a fleet, a pipeline, a soak) does not create +
 * self-assign work_items each wake — delivering the work-item contract to it every wake
 * is pure boilerplate burn (measured: a monitor loop re-received the full ~3KB work
 * contract on 263 consecutive wakes). This template is the lean monitoring contract:
 * check, steer/escalate only on deltas, checkpoint, end turn.
 */
export const MONITOR_LOOP_WAKE_PROMPT_TEMPLATE = [
  '🔁 Monitor wake (every ~{intervalSec}s after each turn settles). You are continuing your OWN warm session, MONITORING: {goal}',
  '',
  'Each wake:',
  '1. Check the watched state (coord:orient { mode:"monitor" } for a fleet; the relevant status tool otherwise). If the thing you are watching is FINISHED or no longer needs a monitor, call `loop:end` and stop — do not spin on empty wakes.',
  '2. Act ONLY on deltas: something stalled/failed/blocked → unblock it, re-steer, or escalate. Nothing changed → write a one-line loop:checkpoint and END YOUR TURN — a quiet wake is a SUCCESS, not a license to invent work. Do NOT create work_items for routine checks; only file one when a delta needs real follow-up work.',
  '3. END YOUR TURN when this check settles. The loop re-wakes this same session ~{intervalSec}s after the turn settles.',
  '',
  'To stop: `loop:end`. `loop:status` shows the loop state.',
].join('\n');

/**
 * COLD-loop bootstrap addendum (su-cold-auto-mode-2026-07-03 P-002 producer). Appended
 * to the wake prompt only for a `carry:'cold'` loop. Until the FIRST carry-note exists,
 * decideColdWake's P-006 no-anchor guard keeps the loop WARM, so these early wakes inject
 * THIS kickoff — which is exactly where the agent is told to write its first
 * loop:checkpoint. Once a carry-note exists, subsequent wakes go cold and the carry-note
 * (wrapped by renderColdWakeInjection) carries the same mandate. So this bootstraps the
 * anchor and the cold injection sustains it.
 */
export const COLD_LOOP_WAKE_ADDENDUM = [
  '',
  "❄️ This is a COLD loop (carry:'cold'): once a carry-note anchor exists, each wake RESETS your context",
  '(a periodic RECYCLE) to that note instead of carrying this transcript — so your transcript will NOT persist.',
  'Therefore, before you END this turn you MUST write/refresh your carry-note so the next (cold) wake can continue:',
  '    loop:checkpoint { did, left, insight, next }   (compressed facts — what you did, what is left, the key',
  '    non-obvious insight, and the single next action). This is REQUIRED on a cold loop: with no carry-note the',
  '    loop silently stays warm (and grows unbounded); a stale note makes the next wake repeat work.',
  'The carry-note is NOT the only thing to persist — it is LOST if your session dies, so also, before ending:',
  '  • if you hold a work-item, REFRESH work_items:checkpoint { id, checkpoint } at least as often as the',
  '    carry-note — the ITEM checkpoint is INHERITED by a successor/reclaimer when your session dies, while the',
  '    loop-note is not; it is your real death-resilience anchor, not a nice-to-have.',
  '  • reached a DURABLE conclusion this wake (a confirmed root cause / repro, a decision, a system bug)? You MUST',
  '    facts:assert it. ⚠ A work-item COMMENT (or a checkpoint) does NOT satisfy this and is the exact trap to',
  '    avoid: a comment is NEVER folded into orient, so the next cold wake and every peer start BLIND to your',
  '    conclusion. The reflex "I already wrote it up in a comment" is precisely why conclusions get lost — a fact',
  '    is the ONLY write folded VERBATIM into every future orient/brief. Comment too if you want an audit trail,',
  '    but the facts:assert is the non-negotiable one; a conclusion left only in a comment/carry-note dies with the loop.',
].join('\n');

/**
 * GATED-continuation addendum (flush-to-proceed-stretch-discipline-2026-07-04 P-005).
 * Appended to the wake prompt only for a `continuation:'gated'` loop. The default
 * template tells the agent to do ONE iteration's work and end the turn; a gated loop
 * inverts that — the runtime EXPECTS multiple units per turn, gated per-unit by the
 * continuation gate (spec rule 2), so the agent recovers the per-wake orient/re-read
 * boundary tax by settling several units back-to-back instead of one-per-wake.
 */
export const GATED_LOOP_WAKE_ADDENDUM = [
  '',
  "🔀 This is a GATED loop (continuation:'gated'): unlike the default one-unit-per-wake cadence, the",
  'runtime EXPECTS you to run MULTIPLE units in a single turn — gated per unit by the CONTINUATION GATE.',
  'After you SETTLE each unit (live-verified or explicitly deferred-with-reason):',
  '  1. FLUSH first — every work-item claim you hold gets a fresh work_items:checkpoint (never carry',
  '     unexternalized state across a unit boundary; the P-002 flush gate enforces this).',
  '  2. READ THE GATE — loop:checkpoint returns a `continuation` verdict (context headroom < ceiling?',
  '     any unread inbox / pending owner input?). CONTINUE in this same turn ONLY when the gate is OPEN',
  '     AND your next unit is already scoped; otherwise END THE TURN.',
  '  3. On any pending owner input, an inbox interrupt, or context past the ceiling — settle now; the',
  '     next wake re-opens the gate on fresh context.',
  'Because a gated turn does more work, arm a LONGER interval than a one-unit loop — the boundary-tax',
  'win comes from N-units-per-turn, not from a faster wake cadence.',
].join('\n');

/**
 * Detect the single work-item a loop is DRIVING from its free-text goal (WI-2429
 * fix A auto-detect leg). Matches a WI-/EI-/F- id and returns it ONLY when the
 * goal names exactly ONE distinct such id — a goal that mentions several (or none)
 * is ambiguous, so we return null rather than guess which one the loop drives (the
 * arming agent can still name it explicitly via loop:arm { workItem }). Pure +
 * exported for unit tests. Case-insensitive match, normalized to the canonical
 * upper-case id. Note: the returned id is a CANDIDATE — the caller's claim step
 * is what confirms it exists and is claimable (claimWorkItem never steals a live
 * peer's item), so a false-positive like a stray "F-16" simply fails the claim
 * non-fatally.
 */
export function detectDrivenWorkItemId(goal: string): string | null {
  const matches = String(goal ?? '').match(/\b(?:WI|EI|F)-\d+\b/gi);
  if (!matches || matches.length === 0) return null;
  const distinct = [...new Set(matches.map((m) => m.toUpperCase()))];
  return distinct.length === 1 ? distinct[0] : null;
}

/**
 * A CONCRETE driven-work-item mandate (WI-2429 fix A), appended to a cold loop's
 * wake prompt when the loop drives a known, auto-claimed work-item. The generic
 * cold addendum says "IF you hold a work-item, refresh its checkpoint" — a soft
 * conditional the cold-auto experiment measured agents ignoring (WI-2429). Since
 * the loop now auto-CLAIMS the item at arm time, that condition is already TRUE,
 * so we can name the id and make the mandate unmissable instead of hypothetical.
 */
function renderDrivenWorkItemLine(workItem: string): string {
  return [
    '',
    `📌 This loop is DRIVING work-item ${workItem} — auto-claimed to you at arm time, so you ALREADY HOLD it. That`,
    `turns the work_items:checkpoint mandate above from an "if" into a REQUIREMENT each wake: work_items:checkpoint`,
    `{ id:'${workItem}', checkpoint } is the ONE piece of in-flight state a successor/reclaimer INHERITS if this`,
    'session dies mid-work — refresh it before every turn ends, at least as often as the carry-note. Finish it with',
    `work_items:complete { id:'${workItem}', … } when the goal is done (then loop:end).`,
  ].join('\n');
}

/** Interpolate the default wakeup prompt with this loop's specifics. For a cold loop
 *  (`carry:'cold'`) the COLD_LOOP_WAKE_ADDENDUM is appended so the pre-anchor warm wakes
 *  bootstrap the first carry-note, and — when the loop drives a known auto-claimed
 *  work-item (`workItem`) — a CONCRETE per-item checkpoint mandate (WI-2429 fix A); for a
 *  gated loop (`continuation:'gated'`) the GATED_LOOP_WAKE_ADDENDUM is appended so the
 *  agent runs multi-unit turns behind the continuation gate. A plain warm/settle loop is
 *  byte-identical to before. The addenda compose (a cold gated loop gets both). */
export function buildLoopWakePrompt(opts: {
  ownerId: string;
  intervalSec: number;
  harness: string;
  goal: string;
  carry?: 'warm' | 'cold';
  continuation?: 'settle' | 'gated';
  /** 'work' (default) = the create+self-assign work-item contract; 'monitor' = the lean
   *  check/steer/checkpoint contract with NO work-item boilerplate (P-001c). */
  mode?: 'work' | 'monitor';
  /** The work-item this loop drives (auto-claimed at arm time, WI-2429 fix A). When set on
   *  a cold loop, its per-item checkpoint mandate is named concretely in the wake prompt. */
  workItem?: string | null;
}): string {
  const base = opts.mode === 'monitor' ? MONITOR_LOOP_WAKE_PROMPT_TEMPLATE : DEFAULT_LOOP_WAKE_PROMPT_TEMPLATE;
  let prompt = base
    .replace(/\{intervalSec\}/g, String(opts.intervalSec))
    .replace(/\{harness\}/g, opts.harness)
    .replace(/\{ownerId\}/g, opts.ownerId)
    .replace(/\{goal\}/g, opts.goal);
  if (opts.carry === 'cold') prompt += COLD_LOOP_WAKE_ADDENDUM;
  if (opts.carry === 'cold' && opts.workItem) prompt += renderDrivenWorkItemLine(opts.workItem);
  if (opts.continuation === 'gated') prompt += GATED_LOOP_WAKE_ADDENDUM;
  return prompt;
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
  /** Optional dead-man bounds (loop-wake-rate-limit-robustness P2a) — auto-pause the loop after
   *  this many total fires / this many seconds since arm. Ride payload_template (no new columns). */
  maxFires?: number | null;
  maxDurationSec?: number | null;
  /** Loop lifecycle (su-cold-auto-mode-2026-07-03 P-003 / D-001). 'warm' (default, absent) =
   *  today's behaviour — each fire re-wakes the SAME warm session in place. 'cold' = the opt-in
   *  fresh-context lifecycle: a cold fire stamps a {carry,wakeCount,harness} marker on the wake
   *  so the wake-executor RESETs / periodically RECYCLEs instead of a warm turn. Rides
   *  payload_template (no new column). Downstream stays dormant until the P-007 gate (Phase 3). */
  carry?: 'warm' | 'cold';
  /** Continuation policy (flush-to-proceed-stretch-discipline-2026-07-04 P-005). 'settle'
   *  (default, absent) = today's behaviour — one unit per wake, end the turn. 'gated' = the
   *  runtime expects MULTIPLE units per turn, each gated by the continuation gate (P-005 spec
   *  rule 2). Rides payload_template (no new column); a settle loop leaves it byte-identical. */
  continuation?: 'settle' | 'gated';
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
 * fire consume). Idempotent on (workspace_id, target_owner_id, name): re-arming
 * the same session updates the one logical row even if the resolved harness
 * namespace changes between a concrete slug and the operator wildcard fallback.
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
  if (input.maxFires != null) payloadTemplate.maxFires = input.maxFires;
  if (input.maxDurationSec != null) payloadTemplate.maxDurationSec = input.maxDurationSec;
  // Only stamp a cold marker (su-cold-auto P-003); a warm loop leaves payload_template
  // byte-identical to today, so an existing warm loop re-armed by an older client is unchanged.
  if (input.carry === 'cold') payloadTemplate.carry = 'cold';
  // Same convention for the continuation policy (P-005): only stamp 'gated'; a settle loop
  // leaves payload_template unchanged.
  if (input.continuation === 'gated') payloadTemplate.continuation = 'gated';

  const name = loopRoutineName(input.ownerId);
  const desiredId = loopRoutineId(input.harnessSlug, input.ownerId);
  const triggerConfigStr = JSON.stringify({});
  const payloadTemplateStr = JSON.stringify(payloadTemplate);
  const nextFireAtStr = nextFireAt.toISOString();
  const existing = await sql<Array<{ id: string; install_slug: string; active: boolean }>>`
    SELECT id, install_slug, active
      FROM harness_shared.routines
     WHERE workspace_id = ${workspaceId}
       AND name = ${name}
       AND target_owner_id = ${input.ownerId}
       AND reschedule_interval_sec IS NOT NULL
     ORDER BY (install_slug = ${input.harnessSlug}) DESC, active DESC, updated_at DESC
     FOR UPDATE
  `;

  let row: { id: string; name: string; nextFireAt: Date | null; targetRole: string };
  if (existing.length > 0) {
    const canonical = existing[0]!;
    const rows = await sql<Array<{ id: string; name: string; next_fire_at: Date | null; target_role: string }>>`
      UPDATE harness_shared.routines
         SET id = ${desiredId},
             install_slug = ${input.harnessSlug},
             trigger_kind = 'cron',
             trigger_config = ${triggerConfigStr}::text::jsonb,
             target_role = ${LOOP_WAKE_ACTION},
             payload_template = ${payloadTemplateStr}::text::jsonb,
             concurrency = 'skip',
             catchup = 'skip-old',
             active = ${input.active ?? true},
             next_fire_at = CASE WHEN next_fire_at = 'infinity'::timestamptz
                                 THEN next_fire_at
                                 ELSE ${nextFireAtStr}::timestamptz END,
             reschedule_interval_sec = ${input.intervalSec},
             target_owner_id = ${input.ownerId},
             updated_at = now()
       WHERE id = ${canonical.id}
      RETURNING id, name, next_fire_at, target_role
    `;
    await sql`
      UPDATE harness_shared.routines
         SET active = FALSE, updated_at = now(),
             metadata = COALESCE(metadata, '{}'::jsonb) ||
               jsonb_build_object('loop_shadow_deactivated_at', now()::text, 'loop_shadow_deactivated_by', ${desiredId}::text)
       WHERE workspace_id = ${workspaceId}
         AND name = ${name}
         AND target_owner_id = ${input.ownerId}
         AND reschedule_interval_sec IS NOT NULL
         AND id <> ${desiredId}
         AND active = TRUE
    `;
    const updated = rows[0]!;
    row = {
      id: updated.id,
      name: updated.name,
      nextFireAt: normalizeNextFireAt(updated.next_fire_at),
      targetRole: updated.target_role,
    };
  } else {
    const inserted = await upsertRoutine(
      sql,
      {
        workspaceId,
        installSlug: input.harnessSlug,
        name,
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
    row = { id: inserted.id, name: inserted.name, nextFireAt: inserted.nextFireAt, targetRole: inserted.targetRole };
  }
  // EI-7613 — refresh the dead-man clock's arm instant on EVERY materialize (a fresh arm
  // AND a re-arm alike): the upsert above never touches `created_at` on its ON CONFLICT DO
  // UPDATE path, so without this a re-armed loop's maxDurationSec bound kept measuring from
  // the loop's ORIGINAL arm — a fresh bound could breach on the very first post-re-arm fire.
  // Best-effort; a stamp failure must never fail the arm (materializeLoop already succeeded).
  try {
    await stampLoopArmedAt(sql, row.id, now.getTime());
  } catch (e) {
    console.warn(
      `[loop] stampLoopArmedAt failed for routine ${row.id} (loop still armed): ${e instanceof Error ? e.message : e}`,
    );
  }
  return { id: row.id, name: row.name, nextFireAt: row.nextFireAt, targetRole: row.targetRole };
}

/**
 * End an owner's loop — deactivate its routine so it never fires again (the row
 * is kept for fire-history + a quick re-arm). Keyed on the per-owner routine NAME
 * (`loop-<ownerId>`) so a session can stop its loop without re-supplying the exact
 * harness it armed under. Returns true if a routine was deactivated. Never
 * flag-gated by callers: you must always be able to stop an armed loop.
 *
 * EI-3748: also clears any stale `metadata.last_error` stamp. The watchdog's
 * `routine-failure` collector (harness/improvements/watchdog.ts) only sees
 * ACTIVE routines, but a transient error (e.g. a one-off DBOS-executor-reaper
 * "stuck fire" auto-requeue — expected, self-healing behavior, not a wedge) that
 * was recorded on this routine, followed by the OWNER ending the loop rather
 * than firing again, left the stamp in place forever: the reaper's own
 * clear-on-next-successful-fire (dbos-executor-reaper.ts) never gets a chance to
 * run once the routine stops firing entirely. That stranded stamp is cosmetic
 * (the routine can't fire — inactive — so it can't actually be wedged) but the
 * filed watchdog issue is confusing/stale noise for whoever triages it later.
 * Unconditional (not source-scoped like the reaper's clear): ending the loop
 * makes ANY residual error moot, regardless of who recorded it.
 */
export async function deactivateLoop(ownerId: string, opts: { sql?: Sql } = {}): Promise<boolean> {
  const sql = opts.sql ?? getOrgPg().sql;
  const result = await sql`
    UPDATE harness_shared.routines
       SET active = FALSE, updated_at = now(),
           metadata = COALESCE(metadata, '{}'::jsonb) - 'last_error' - 'last_error_at' - 'last_error_source'
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
  /** Loop lifecycle (su-cold-auto-mode-2026-07-03 P-003/P-008): 'warm' (default) re-wakes the
   *  same session in place; 'cold' resets/recycles to the carry-note each wake. Observability so
   *  an operator can see whether a loop is cold and, if it looks lost, re-arm it warm. */
  carry: 'warm' | 'cold';
  /** Continuation policy (flush-to-proceed P-005): 'settle' (default) ends the turn after one
   *  unit; 'gated' runs multiple units per turn behind the continuation gate. Observability so an
   *  operator can see whether a loop is in gated mode. */
  continuation: 'settle' | 'gated';
  /** Total delivered fires so far (metadata.fire_count) — for a cold loop this is the wakeCount
   *  cadence counter (a RECYCLE lands every Nth). 0 when never fired / not tracked. */
  fireCount: number;
  /** True while the loop's turn is in flight (parked at next_fire_at='infinity'). */
  parked: boolean;
  /** Next scheduled fire (ISO), or null when parked / unset. */
  nextFireAt: string | null;
  lastFiredAt: string | null;
  costCapCents: number | null;
  /** P2a dead-man bounds (if configured). */
  maxFires: number | null;
  maxDurationSec: number | null;
  /** P2b (loop-wake-rate-limit-robustness): distinguish "parked, healthy in-flight" from
   *  "parked, last fire produced NO completion in ≥max(30min,4×interval)" — i.e. the wake turn
   *  likely died. `stalled` is the verdict; `stalledSinceMs` is how long it has been parked
   *  past the fire (null when healthy); `lastDeliveryOutcome` is the autoloop fire-state's last
   *  status (e.g. 'queued' / 'loop-lifecycle' / 'resume-turn-death:rate_limited'); and
   *  `consecutiveErrors` is the failure-streak the circuit watches. */
  stalled: boolean;
  stalledSinceMs: number | null;
  lastDeliveryOutcome: string | null;
  consecutiveErrors: number;
}

/**
 * Pure stall verdict (P2b): a loop is "stalled" when it is PARKED (turn in flight) far past its
 * fire (≥ max(30min, 4×interval)) with NO completion marker AND no session activity since the
 * fire — the signature of a dead wake turn, distinct from a legitimately long turn (which keeps
 * producing activity). Mirrors the reconcile stuck-park backstop / the watchdog loop-stalled
 * predicate. Injectable inputs keep it unit-testable.
 */
export function computeLoopStall(input: {
  parked: boolean;
  parkedMs: number | null;
  intervalSec: number | null;
  hasCompletionSinceFire: boolean;
  activeSinceFire: boolean;
}): { stalled: boolean; stalledSinceMs: number | null } {
  const stuckParkMs = Math.max(30 * 60_000, (input.intervalSec ?? 60) * 4 * 1000);
  if (!input.parked || input.parkedMs == null) return { stalled: false, stalledSinceMs: null };
  if (input.hasCompletionSinceFire || input.activeSinceFire) return { stalled: false, stalledSinceMs: null };
  if (input.parkedMs >= stuckParkMs) return { stalled: true, stalledSinceMs: input.parkedMs };
  return { stalled: false, stalledSinceMs: null };
}

/**
 * Read an owner's loop status (NULL if none). A lean shape rather than the full
 * RoutineRow — and it correctly reads the parked sentinel: postgres-js parses
 * `next_fire_at='infinity'::timestamptz` to an invalid Date, so we detect parked
 * in SQL and never hand a NaN-Date out.
 */
export async function getLoopStatus(ownerId: string, opts: { sql?: Sql } = {}): Promise<LoopStatus | null> {
  const sql = opts.sql ?? getOrgPg().sql;
  const name = loopRoutineName(ownerId);
  const rows = await sql<any[]>`
    SELECT r.install_slug,
           r.name,
           r.active,
           r.reschedule_interval_sec,
           r.target_owner_id,
           r.payload_template,
           COALESCE((r.metadata->>'fire_count')::int, 0)                  AS fire_count,
           r.last_fired_at,
           (r.next_fire_at = 'infinity'::timestamptz)                    AS parked,
           CASE WHEN r.next_fire_at = 'infinity'::timestamptz THEN NULL
                ELSE r.next_fire_at END                                  AS next_fire_at,
           -- P2b stall inputs: how long parked past the fire, last fire-state, completion + activity.
           CASE WHEN r.last_fired_at IS NULL THEN NULL
                ELSE (EXTRACT(EPOCH FROM (now() - r.last_fired_at)) * 1000)::bigint END AS parked_ms,
           a.last_status         AS last_delivery_outcome,
           a.consecutive_errors  AS consecutive_errors,
           (SELECT max(ag.created_at) FROM harness_shared.agent_activity ag
             WHERE ag.owner_id = r.target_owner_id AND ag.kind = 'lifecycle'
               AND ag.summary ILIKE '%end%' AND ag.created_at > r.last_fired_at) AS lifecycle_completed_at,
           (SELECT max(p.last_active_at) FROM harness_shared.coord_presence p
             WHERE p.owner_id = r.target_owner_id) AS presence_last_active_at
      FROM harness_shared.routines r
      LEFT JOIN harness_shared.autoloop_state a
        ON a.workspace_id = r.workspace_id AND a.harness_slug = r.install_slug AND a.role = r.name
     WHERE r.name = ${name}
     ORDER BY r.active DESC, r.updated_at DESC
     LIMIT 1
  `;
  if (rows.length === 0) return null;
  const r = rows[0];
  const pt = r.payload_template ?? {};
  const costCap = pt?.costCapCents;
  const intervalSec = r.reschedule_interval_sec == null ? null : Number(r.reschedule_interval_sec);
  const parked = Boolean(r.parked);
  const parkedMs = r.parked_ms == null ? null : Number(r.parked_ms);
  const lastFiredMs = r.last_fired_at ? new Date(r.last_fired_at).getTime() : null;
  const completedMs = r.lifecycle_completed_at ? new Date(r.lifecycle_completed_at).getTime() : null;
  const presenceMs = r.presence_last_active_at ? new Date(r.presence_last_active_at).getTime() : null;
  const stall = computeLoopStall({
    parked,
    parkedMs,
    intervalSec,
    hasCompletionSinceFire: completedMs != null, // the subquery already bounds it to > last_fired
    activeSinceFire: presenceMs != null && lastFiredMs != null && presenceMs > lastFiredMs,
  });
  return {
    name: r.name,
    ownerId: r.target_owner_id ?? ownerId,
    harnessSlug: r.install_slug,
    active: r.active,
    intervalSec,
    carry: pt?.carry === 'cold' ? 'cold' : 'warm',
    continuation: pt?.continuation === 'gated' ? 'gated' : 'settle',
    fireCount: r.fire_count == null ? 0 : Number(r.fire_count),
    parked,
    nextFireAt: r.next_fire_at ? new Date(r.next_fire_at).toISOString() : null,
    lastFiredAt: r.last_fired_at ? new Date(r.last_fired_at).toISOString() : null,
    costCapCents: typeof costCap === 'number' ? costCap : null,
    maxFires: typeof pt?.maxFires === 'number' ? pt.maxFires : null,
    maxDurationSec: typeof pt?.maxDurationSec === 'number' ? pt.maxDurationSec : null,
    stalled: stall.stalled,
    stalledSinceMs: stall.stalledSinceMs,
    lastDeliveryOutcome: r.last_delivery_outcome ?? null,
    consecutiveErrors: r.consecutive_errors == null ? 0 : Number(r.consecutive_errors),
  };
}
