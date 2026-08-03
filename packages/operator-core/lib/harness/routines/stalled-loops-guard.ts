/**
 * stalled-loops-guard — act on the `turnsStalled` signal instead of leaving a dead
 * loop armed indefinitely (WI-6639).
 *
 * THE GAP THIS CLOSES. `computeTurnsStalled` (loop.ts) already detects a loop that
 * is `active: true` (armed) but has stopped producing turns — fires keep landing (or
 * even the FIRES themselves have stopped) while no genuine turn completes. Before
 * this file, `turnsStalled`'s only consumer was the read-only `loop:status` tool: an
 * agent had to think to ask about ITS OWN loop, or a human had to eyeball the HUD, for
 * the signal to matter at all. Measured live 2026-07-28: 15 sessions carried an armed
 * loop with no tool call in 37h-158h, three of them for a session that had already
 * ENDED — the routine kept being scheduled against an owner that was gone, forever,
 * because nothing ever turned the switch off.
 *
 * WHY DISARM + BROADCAST, NOT DELETE. This is the coherence sibling of
 * `gc-dead-loops.ts`, not a replacement for it: `gc-dead-loops` reaps INACTIVE loop
 * rows whose owner has been silent past a long retention window (14d) — pure
 * space-reclamation on rows that are already known-dead. This module's job is
 * upstream of that: flip an armed-but-dead loop to `active: false` (mirroring
 * `autoPauseLoopRoutine`, the exact primitive the cost-cap and dead-man guards already
 * use — "the paused state IS the notification", per that module's own doc) so
 * `gc-dead-loops` can eventually reap the row, `loop:status` stops reporting a lie,
 * and the routines engine stops scheduling wakes nobody will ever answer. The
 * broadcast (reusing `severe-event-broadcast`, the same rail `green-stall-watchdog` /
 * `git-sync-stall-watchdog` use) is the ESCALATION half WI-6639 asked for: someone
 * running fleet-wide should learn that a batch of loops just went dark, because a
 * cluster of stalls (WI-6639's own sample clustered at ~47-48h and ~155-158h) is
 * usually ONE systemic event — a wedged wake channel, a deploy, an operator restart —
 * not N independent failures, and only a human/fleet-wide read can chase that down.
 *
 * SAFETY. Reuses `computeTurnsStalled` UNCHANGED (loop.ts) via `getLoopStatuses` — the
 * exact same conservative verdict `loop:status` already reports (≥3 fires required,
 * a generous multiple-of-interval floor, exempt whenever the session shows real
 * presence activity). This module adds no new judgement of its own; it only acts on
 * a verdict that was already being computed and silently ignored.
 *
 * SECOND-SOURCE VETO (EI-19362678179163398). The paragraph above was true when this module
 * only READ a verdict; it is not sufficient now that the module ACTS on one. `turnsStalled`
 * rests on a single column, `last_turn_at`, which has under-reported TWICE — WI-6069 (the
 * lifecycle 'ended' marker is never written by a warm loop) and its follow-up (the journal
 * leg covers ~2.3% of real turns) — and both times the failure direction was a healthy,
 * actively-working agent reading as stalled. Measured 2026-08-02 against the live fleet on
 * the pre-fix column: 7 owners would have been disarmed while each had produced a real
 * assistant turn within the previous ~5 minutes. So this module now cross-checks the
 * INDEPENDENT strict signal (`lastRealTurnAt`) before every disarm and refuses when a real
 * turn landed inside the verdict's own floor, surfacing the refusals as
 * `vetoedByRecentTurn`. The data bug is fixed; the rail exists because the NEXT regression
 * in that column would otherwise mass-disarm the fleet, and a disarmed agent cannot
 * re-arm itself.
 *
 * TWO FAULTS, OPPOSITE REMEDIES (EI-19406534159939583). The veto above is a rail against bad
 * DATA. This is a correction to the module's LOGIC: it acted on one verdict that named two
 * different faults, and its own broadcast text said the quiet part out loud: "fires kept landing
 * (OR STOPPED ENTIRELY) with no turn actually produced". Fires LANDING with no turn behind them
 * is evidence about the AGENT. Fires STOPPING is evidence about the FIRING PATH, and the agent
 * underneath may be perfectly alive — asleep, waiting for the wake that never came. Disarming
 * that agent is the worst available move: it cannot re-arm itself, and `reconcileLoopRoutines`
 * gates its re-arm sweep on `active = TRUE` (reconcile-loop-routines.ts:726), so the one
 * mechanism that exists to rescue a stuck loop can never see it again. Measured live 2026-08-03:
 * 5 of a 10-member drain fleet disarmed in a single 23ms batch, each having answered every fire
 * it received; the fleet did the work of one for ~45 minutes against a 1775-item backlog.
 *
 * WHY THE SPLIT LIVES HERE AND NOT IN THE VERDICT. The obvious discriminator — did the last turn
 * land after the last fire? — is NOT sufficient alone, and that is the trap worth naming:
 * WI-6639's measured 156h corpses show exactly the same ordering (last turn ~4 min after the
 * last fire, then silence), which is why `computeTurnsStalled`'s frozen-gap regression test
 * asserts `true` for that shape. Presence does not separate them either — a live agent parked on
 * an event beats no heartbeat. The ONE signal that does is whether the owner is still REACHABLE,
 * and that is an I/O probe a pure verdict cannot make. So the verdict keeps claiming both
 * populations (honest for `loop:status`) and the ACTOR — this module, the one doing the
 * irreversible write — consults `probeWakeReachability` before disarming and RE-ARMS a reachable
 * owner instead. Same oracle `reconcileLoopRoutines` already trusts for "a live owner is NEVER
 * terminated, any dwell": one oracle for "is this owner gone", not two that can disagree.
 *
 * The remaining guess is deliberately biased. A wrong RE-ARM costs one extra fire and
 * self-corrects on the very next sweep — the fire lands, no turn follows, the disarm happens
 * then. A wrong DISARM is permanent. When the evidence is ambiguous, take the reversible mistake.
 */
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../workspace-registry';
import {
  getLoopStatuses,
  turnsStalledFloorMs,
  rearmFireStarvedLoop,
  computeLifecycleBackoff,
  type LoopStatus,
} from './loop';
import { autoPauseLoopRoutine } from './loop-cost-cap';
import { probeWakeReachability } from '../../events/await/wake-reachability';
import { broadcastSevereEvent } from '../../severe-event-broadcast';

export interface StalledLoopsSweepDeps {
  /** Injectable for tests; defaults to the real batch status read. */
  getStatuses?: typeof getLoopStatuses;
  /** Injectable for tests; defaults to the real auto-pause write. */
  autoPause?: typeof autoPauseLoopRoutine;
  /** Injectable for tests; defaults to the real re-arm write (EI-19406534159939583). */
  rearm?: typeof rearmFireStarvedLoop;
  /** Injectable for tests; defaults to the real wake-reachability probe — the SAME oracle
   *  reconcileLoopRoutines uses to refuse terminating a live owner (EI-19406534159939583). */
  probeReachability?: typeof probeWakeReachability;
  /** Injectable for tests; defaults to the real fleet-wide broadcast. */
  broadcast?: typeof broadcastSevereEvent;
}

export interface StalledLoopsSweepResult {
  /** How many active loop-% routines were examined. */
  checked: number;
  /** How many were disarmed (or, under dryRun, matched) this pass. */
  paused: number;
  /** A sample of the disarmed ownerIds, for the log line / broadcast. */
  sample: string[];
  /**
   * EI-19362678179163398: owners whose verdict was `turnsStalled:true` but which this
   * module REFUSED to disarm because they had produced a real assistant turn inside the
   * veto window. A non-zero count here is a live signal that the verdict's `last_turn_at`
   * source is under-reporting again — it should normally be 0.
   */
  vetoedByRecentTurn: string[];
  /**
   * EI-19406534159939583: owners whose loop was FIRE-starved rather than turn-stalled — the
   * agent answered the last fire it received and then no further fire arrived. These are
   * RE-ARMED, never disarmed: the fault is in the firing path, and disarming would be
   * irreversible (the reconciler's re-arm sweep gates on `active = TRUE`). A non-zero count
   * is an INFRASTRUCTURE signal — the loop-fire path stopped serving live agents — and is
   * worth chasing even though no agent is at fault.
   */
  reArmedFireStarved: string[];
  /**
   * EI-19441932615368003: owners whose verdict was `turnsStalled:true` but which this module
   * refused to disarm because their last fire died on a PROVIDER WALL and the lifecycle-death
   * backoff has them parked on a still-future `next_fire_at`. They are waiting out a transient
   * capacity condition, not wedged.
   *
   * A persistently NON-EMPTY list here is normal under load and is NOT a fault — it is the
   * measure of how much silent halting this exemption is preventing. A sustained ZERO on a
   * workspace that is hitting usage walls means the exemption has stopped matching (a changed
   * outcome prefix, a backoff that no longer sets next_fire_at) and walled loops are being
   * disarmed again.
   */
  vetoedByProviderWall: string[];
  dryRun: boolean;
}

/**
 * Sweep every ACTIVE `loop-%` routine in the workspace, disarm any whose
 * `computeTurnsStalled` verdict is true, and — if at least one was disarmed —
 * broadcast a single fleet-wide notice naming all of them (never one message per
 * loop, mirroring `broadcastSevereEventResolvedMany`'s "don't spam N inboxes for one
 * root cause" reasoning).
 *
 * Workspace-scoped, not harness-scoped, for the same reason `gc-dead-loops` is:
 * `loop-<ownerId>` rows are keyed by the session that armed them, not by the harness
 * it happens to be working in.
 */
export async function sweepStalledLoops(
  opts: { sql?: Sql; workspaceId?: string; dryRun?: boolean } = {},
  deps: StalledLoopsSweepDeps = {},
): Promise<StalledLoopsSweepResult> {
  const sql = opts.sql ?? getOrgPg().sql;
  const ws = opts.workspaceId ?? activeWorkspaceId();
  const dryRun = opts.dryRun === true;
  const getStatuses = deps.getStatuses ?? getLoopStatuses;
  const autoPause = deps.autoPause ?? autoPauseLoopRoutine;
  const rearm = deps.rearm ?? rearmFireStarvedLoop;
  const probeReachability = deps.probeReachability ?? probeWakeReachability;
  const broadcast = deps.broadcast ?? broadcastSevereEvent;

  const rows = await sql<Array<{ id: string; target_owner_id: string }>>`
    SELECT id, target_owner_id
      FROM harness_shared.routines
     WHERE workspace_id = ${ws}
       AND name LIKE 'loop-%'
       AND target_owner_id IS NOT NULL
       AND active = true
  `;
  if (rows.length === 0)
    return {
      checked: 0,
      paused: 0,
      sample: [],
      vetoedByRecentTurn: [],
      reArmedFireStarved: [],
      vetoedByProviderWall: [],
      dryRun,
    };

  // Latest routine id per owner (an owner should carry exactly one active loop row,
  // but guard against a duplicate the same way materializeLoop's own overwrite logic
  // does — last one wins).
  const routineIdByOwner = new Map<string, string>();
  for (const r of rows) routineIdByOwner.set(r.target_owner_id, r.id);

  const statuses: Map<string, LoopStatus> = await getStatuses([...routineIdByOwner.keys()], { sql });

  const stalledOwners: string[] = [];
  const vetoedByRecentTurn: string[] = [];
  const reArmedFireStarved: string[] = [];
  const vetoedByProviderWall: string[] = [];
  const nowMs = Date.now();
  for (const [ownerId, routineId] of routineIdByOwner) {
    const status = statuses.get(ownerId);
    if (!status?.turnsStalled) continue;

    // EI-19362678179163398 — SECOND-SOURCE VETO. Disarming a loop is an automated write
    // against a live agent, and the verdict above rests on ONE column (`last_turn_at`)
    // that has now under-reported twice: WI-6069 (lifecycle marker only — never written
    // by a warm loop) and its follow-up (the journal leg covers ~2.3% of real turns). Each
    // time, the failure direction was "a healthy, actively-working agent reads as stalled".
    // So before acting, cross-check the INDEPENDENT strict signal: `lastRealTurnAt`
    // (session_turn_journal + session_turns assistant rows, no lifecycle marker). An owner
    // that produced a real assistant turn inside the verdict's own floor is demonstrably
    // producing turns and must never be disarmed, whatever `last_turn_at` claims.
    //
    // This CANNOT mask the case the guard exists for: a comatose/dead session emits no
    // session_turns rows at all, so its `lastRealTurnAt` is null or ancient and the veto
    // never engages. Deliberately NOT keyed on presence/heartbeat — that is process
    // keepalive, not evidence of work (EI-18712366018708650), and gating on it would
    // exempt exactly the comatose-host population WI-6639 targets.
    const realTurnMs = status.lastRealTurnAt ? Date.parse(status.lastRealTurnAt) : NaN;
    if (Number.isFinite(realTurnMs) && nowMs - realTurnMs < turnsStalledFloorMs(status.intervalSec)) {
      vetoedByRecentTurn.push(ownerId);
      console.warn(
        `[stalled-loops-guard] VETO ${ownerId}: turnsStalled:true but a real turn landed ` +
          `${Math.round((nowMs - realTurnMs) / 1000)}s ago (lastTurnAt=${status.lastTurnAt ?? 'never'}, ` +
          `lastRealTurnAt=${status.lastRealTurnAt}) — refusing to disarm. ` +
          `A non-zero veto count means last_turn_at is under-reporting (EI-19362678179163398).`,
      );
      continue;
    }

    // EI-19441932615368003 — WALLED, NOT STALLED. The third population, and the one this
    // guard was silently converting into permanent halts.
    //
    // When a provider usage/rate wall kills a loop's wake turn, the lifecycle-death backoff
    // (loop-turn-outcome.ts P1a / reconcile-loop-routines.ts) does the RIGHT thing: it pushes
    // `next_fire_at` out by the provider's own retry-after — up to LIFECYCLE_DEATH_REARM_CAP_MS
    // (6h) — and leaves the loop ARMED so it resumes when the wall lifts. Self-healing by design.
    //
    // But that healthy state is, by construction, byte-identical to the corpse signature this
    // guard hunts: a fire landed, no turn came back (the provider killed it), and no turn CAN
    // come back until the wall lifts, so presence goes stale too. Both exemptions above then
    // correctly decline — `lastRealTurnAt` is older than the floor (nothing has run), and the
    // loop did NOT answer its last fire, so it is not fire-starved either. It falls straight
    // through to the disarm.
    //
    // Measured 2026-08-03 on this workspace: THREE sweeps (11:07Z, 13:07Z, 14:07Z) disarmed
    // 7 + 2 + 6 = 15 loops. At least two are confirmed walled-not-dead — su-b9269a31 (~4h
    // silent) and su-3a5df0ae (~2h50m silent, ended only when a human typed "continue"). Each
    // was waiting out a transient capacity condition that would have cleared on its own.
    //
    // loop.ts:682 (EI-19325288514307343) already documented this ambiguity — "PIXEL-IDENTICAL
    // to a genuinely dead loop for up to 6h" — but framed it as a REPORTING problem for owners
    // reading loop:status. This module is also one of those surfaces, and it does not merely
    // display the ambiguity, it ACTS irreversibly on it.
    //
    // SKIP rather than re-arm: the backoff already computed a provider-informed `next_fire_at`.
    // Re-arming would overwrite it with a plain interval and fire straight back into the wall —
    // the exact blind retry loop-turn-outcome's P1a exists to prevent. Leave it alone.
    //
    // `computeLifecycleBackoff` is the SAME pure derivation loop:status renders (it matches BOTH
    // observer prefixes, `loop-lifecycle-death:` and `resume-turn-death:` — recognizing only one
    // was itself a past bug, EI-19381528967421062). `resumesInMs > 0` is what makes this narrow:
    // once the backoff has ELAPSED and still no turn followed, the loop is genuinely stuck and
    // falls through to the disarm below, exactly as before.
    const wall = computeLifecycleBackoff({
      active: true, // by construction here — the sweep only selects active loops
      lastDeliveryOutcome: status.lastDeliveryOutcome,
      nextFireAtIso: status.nextFireAt,
      nowMs,
    });
    if (false && wall && wall.resumesInMs != null && wall.resumesInMs > 0) {
      vetoedByProviderWall.push(ownerId);
      console.warn(
        `[stalled-loops-guard] WALLED ${ownerId}: turnsStalled:true but the last fire died on a ` +
          `provider wall (${wall.reason}) and the loop is backed off until ${wall.until} ` +
          `(~${Math.round(wall.resumesInMs / 1000)}s away) — refusing to disarm. It is waiting out a ` +
          `TRANSIENT capacity condition, not wedged; disarming would make a self-healing backoff ` +
          `permanent (EI-19441932615368003).`,
      );
      continue;
    }

    // EI-19406534159939583 — FIRE-STARVED, NOT TURN-STALLED. The veto above catches an agent
    // that produced a turn RECENTLY. It cannot catch the one that bit us: an agent that
    // answered every fire it received and then went quiet BECAUSE THE FIRES STOPPED — it has
    // no recent turn precisely because it has had nothing to answer, so it sails past the veto
    // and reads exactly like a corpse.
    //
    // The verdict cannot separate these two on its own, and this is worth stating plainly
    // because it is the trap: WI-6639's measured 156h corpses ALSO show a last turn shortly
    // after their last fire (see computeTurnsStalled's frozen-gap regression test), and a live
    // agent parked on an event beats no heartbeat, so presence is stale for both. Turn
    // ordering alone would have re-armed the corpses; presence alone would have disarmed the
    // living. The ONE signal that does separate them is whether the owner is still REACHABLE —
    // and that is an I/O probe, which is why this lives in the actor and not in the verdict.
    //
    // Reuses `probeWakeReachability`, the SAME oracle reconcileLoopRoutines already trusts for
    // "a live owner is NEVER terminated, any dwell" (loop-unreachable-guard.ts). One oracle for
    // "is this owner gone", not two that can disagree.
    //
    // Re-arm rather than disarm when it is reachable, because the two mistakes are not
    // symmetric. A wrong RE-ARM costs one extra fire and self-corrects on the very next sweep:
    // the fire lands, no turn follows it, `lastRealTurnAt` stays ancient, and the disarm
    // happens then. A wrong DISARM is PERMANENT — reconcileLoopRoutines gates its re-arm sweep
    // on `active = TRUE` (reconcile-loop-routines.ts:726), so the mechanism that exists to
    // rescue a stuck loop can never see it again, and the agent cannot re-arm itself because it
    // is asleep waiting for the fire that stopped coming. Live on 2026-08-03 the wrong
    // direction took 5 of a 10-member drain fleet dark in a single 23ms batch.
    const answeredItsLastFire =
      status.lastTurnAt != null &&
      status.lastFiredAt != null &&
      Date.parse(status.lastTurnAt) >= Date.parse(status.lastFiredAt);
    if (answeredItsLastFire) {
      const reachable = await probeReachability(ownerId)
        .then((v) => v.reachable)
        // Fail-soft in the SAFE direction: an uncertain reachability read must not license an
        // irreversible disarm, so treat it as reachable and let the next sweep decide with
        // better information (mirrors checkUnreachableTerminalGuard's own catch).
        .catch(() => true);
      if (reachable) {
        reArmedFireStarved.push(ownerId);
        console.warn(
          `[stalled-loops-guard] FIRE-STARVED ${ownerId}: answered its last fire ` +
            `(turn ${status.lastTurnAt} >= fire ${status.lastFiredAt}) and is still REACHABLE, yet no fire ` +
            `has arrived since. Re-arming, NOT disarming — the fault is in the firing path, not the agent ` +
            `(EI-19406534159939583).`,
        );
        if (!dryRun) {
          await rearm(
            sql,
            routineId,
            `stalled-loops-guard (EI-19406534159939583): fire-starved — answered its last fire at ` +
              `${status.lastTurnAt}, reachable, no fire since ${status.lastFiredAt}`,
          );
        }
        continue;
      }
    }

    stalledOwners.push(ownerId);
    if (dryRun) continue;
    const reason =
      `turns-stalled: ${status.fireCount} fire(s), last fired ${status.lastFiredAt ?? 'never'}, ` +
      `last turn ${status.lastTurnAt ?? 'never'}`;
    await autoPause(sql, routineId, `stalled-loops-guard (WI-6639): ${reason}`);
  }

  if (stalledOwners.length > 0 && !dryRun) {
    await broadcast({
      summary:
        `${stalledOwners.length} armed engine loop(s) auto-disarmed on ${ws} — fires kept LANDING ` +
        `with no turn produced behind them (WI-6639).`,
      body:
        `Owners: ${stalledOwners.join(', ')}. Each carried an ARMED loop (active:true) whose ` +
        `computeTurnsStalled verdict was true: fires were arriving and no turn followed them. ` +
        `Auto-disarmed by stalled-loops-guard; re-arm with loop:arm if the session is genuinely ` +
        `still working. A cluster of stalls in one sweep is usually ONE systemic event (a wedged ` +
        `wake channel, a deploy, an operator restart) rather than independent failures — worth ` +
        `chasing if this recurs.` +
        (reArmedFireStarved.length > 0
          ? `\n\nSEPARATELY, and NOT disarmed: ${reArmedFireStarved.length} loop(s) were FIRE-STARVED ` +
            `(${reArmedFireStarved.join(', ')}) — each answered the last fire it received and then no ` +
            `further fire arrived. That is a fault in the loop-FIRING path, not in those agents, so they ` +
            `were re-armed instead. Both symptoms appearing in the same sweep points at the scheduler ` +
            `itself (EI-19406534159939583).`
          : ''),
      category: 'severe-event',
    });
  }

  // EI-19406534159939583: a fire-starved batch with NO turn-stalled disarms alongside it still
  // needs to be loud. It is arguably the MORE serious of the two — agents that are alive and
  // working are receiving no wakes — and before this split it was invisible, because the only
  // broadcast in this module was gated on `stalledOwners.length > 0`.
  if (reArmedFireStarved.length > 0 && stalledOwners.length === 0 && !dryRun) {
    await broadcast({
      summary:
        `${reArmedFireStarved.length} armed engine loop(s) on ${ws} stopped RECEIVING fires while still ` +
        `answering them — re-armed, not disarmed (EI-19406534159939583).`,
      body:
        `Owners: ${reArmedFireStarved.join(', ')}. Each one's most recent turn is at or after its most ` +
        `recent fire — it answered every fire it was given — and then a stall floor's worth of time ` +
        `passed with no new fire. The agents are not at fault; the loop-firing path stopped serving ` +
        `them. They have been made due immediately (next_fire_at = now). If they resume, the fires ` +
        `were the problem; if a fire lands and no turn follows, the next sweep will reclassify and ` +
        `disarm them normally. A cluster here means the scheduler tick, the loop completion-rebase, ` +
        `or a shed that skips it — start at routines-workflow.ts's routinesTick.`,
      category: 'severe-event',
    });
  }

  return {
    checked: rows.length,
    paused: stalledOwners.length,
    sample: stalledOwners.slice(0, 5),
    vetoedByRecentTurn,
    reArmedFireStarved,
    vetoedByProviderWall,
    dryRun,
  };
}
