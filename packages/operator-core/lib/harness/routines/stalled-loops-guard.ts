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
 *
 * A FOURTH POPULATION: WAKE-STARVED (WI-36685). The split above asks whether the FIRES stopped.
 * It does not ask the next question down: whether a fire that DID happen reached anyone. A wake
 * emits on `coord:inbox-wake:<owner>`; with no standing await registered there it matches nothing
 * and no `event_wake_deliveries` row is created at all — so the agent sleeps on, never having been
 * spoken to, and its `last_turn_at` goes stale for the one reason this module never considered:
 * nobody asked it for a turn. Every exemption above correctly declines (no recent turn, no
 * provider wall, and the fires did NOT stop, so `answeredItsLastFire` is false), and it takes the
 * permanent disarm. Measured on su-4a6e2255, twice in one day, the second time for 2h44m with
 * ZERO delivery rows while fires advanced — disarmed at 22:07:36Z and dark until a human typed
 * into it. Note this module's own OWNER page (EI-19899301656065801) is what should have covered
 * the gap and could not: it fires AFTER the disarm, and its rail writes no durable record
 * (WI-36644).
 *
 * The discriminator costs no new I/O — `lastWakeAt` is DERIVED as
 * COALESCE(delivered_at, created_at) over this routine's own delivery rows (loop.ts:1069), so a
 * created-but-undelivered row would still advance it and a frozen value under an advancing
 * `lastFiredAt` can only mean no row was created. What it CANNOT be keyed on is `reachable`:
 * `deriveWakeReachability`'s Gate 1 returns before consulting any liveness signal, so a
 * wake-starved owner is unreachable by construction and reads identically to a corpse. That
 * conflation is fixed at the source — the verdict now also reports `awaitRepairable` — and it is
 * the gate that keeps a genuine corpse (whose await was cancelled at SessionEnd, giving it the
 * same frozen `lastWakeAt`) on the disarm path.
 *
 * ⚠ The remedy here is TWO writes, not one: `rearmFireStarvedLoop` moves `next_fire_at` and
 * nothing else, so on this population it fires straight back into the same hole. The standing
 * watch must be re-armed FIRST (`armInboxWake` — what `loop:arm` itself does); the nudge only
 * decides when the now-deliverable fire happens.
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
import { probeWakeReachability, type WakeReachabilityVerdict } from '../../events/await/wake-reachability';
import type { AttentionNotifyInput } from '../../attention-notify';
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
  /**
   * Injectable for tests; defaults to the real standing-await (re-)arm (WI-36685).
   *
   * The REPAIR half of the wake-starved branch, and it has to be a separate write from
   * `rearm`: `rearmFireStarvedLoop` only nudges `next_fire_at`, so on a loop whose fires are
   * black-holing for want of a standing await it would fire straight back into the same hole.
   * Arming the watch is what actually restores delivery — the same call `loop:arm` makes
   * (agent-tools/loop/arm.ts:732).
   *
   * Dynamically imported at call time for the same reason `notify` is: this sweep runs on
   * every routine tick and must not carry the await/handle-capture machinery just to repair
   * the rare wake-starved loop.
   */
  armWake?: (input: { ownerId: string; note?: string | null }) => Promise<unknown>;
  /** Injectable for tests; defaults to the real fleet-wide broadcast. */
  broadcast?: typeof broadcastSevereEvent;
  /**
   * Injectable for tests; defaults to the real OWNER page (EI-19899301656065801).
   *
   * Imported dynamically at call time rather than statically, matching
   * `stale-routine-executor-watchdog.ts`: `attention-notify` pulls in the push/SSE
   * transports, and this sweep must not carry them on every routine tick just to
   * page on the rare disarm. The type-only import above is erased at runtime.
   */
  notify?: (input: AttentionNotifyInput) => Promise<void>;
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
  /**
   * EI-19899301656065801: the subset of `stalledOwners` that was still answering a reachability
   * probe at the moment it was disarmed — i.e. present sessions made permanently unwakeable, as
   * opposed to the corpses WI-6639 was built to reap. This is the population the owner is paged
   * about, and the only one for which the disarm destroys something recoverable.
   *
   * Expected to be EMPTY on a healthy workspace: a reachable session that stops taking turns is
   * itself a fault (a died carry-respawn, a wedged CLI child). A persistently non-empty list is
   * a signal about session liveness upstream, not about this sweep.
   */
  disarmedWhileReachable: string[];
  /**
   * WI-36685: owners whose loop was WAKE-starved — the routine kept firing, but each fire found
   * no standing `coord:inbox-wake` await, so `wake()` matched nothing, NO `event_wake_deliveries`
   * row was ever created, and the agent was never actually spoken to. It has no recent turn
   * because it was never asked for one.
   *
   * These are REPAIRED (the watch is re-armed, then the loop is made due) and never disarmed —
   * but only when the session is otherwise live (`awaitRepairable`), which is what keeps a
   * genuine corpse, whose await was cancelled at SessionEnd and which shows the SAME frozen
   * `lastWakeAt`, on the disarm path where it belongs.
   *
   * A non-zero count is an INFRASTRUCTURE signal about the wake-delivery path, not about the
   * agent — a sibling of `reArmedFireStarved`, one layer further down: there the fires stopped,
   * here they continued and landed nowhere.
   */
  repairedWakeStarved: string[];
  /**
   * WI-36792: owners whose MOST RECENT fire was never sent at all — the fire gate WITHHELD it
   * (`lastWithheldAt >= lastFiredAt`) while the session was still reachable. They read as
   * wake-starved for the same mechanical reason as `repairedWakeStarved` (a withheld fire
   * creates no `event_wake_deliveries` row, so `lastWakeAt` freezes under an advancing
   * `lastFiredAt`) but there is nothing to repair: the standing await is intact and the session
   * is live. Nothing is wrong with the agent — it was simply never asked for a turn.
   *
   * VETOED, not repaired and not re-armed: the gate's backoff is a deliberate cadence and this
   * module has no business overwriting it (the same "leave it alone" reasoning as
   * `vetoedByProviderWall`). Re-arming a withheld PARKED loop belongs to reconcileLoopRoutines'
   * `gate-backoff` rebase, which honours `retryAfterSec`.
   *
   * A non-zero count is a signal about the FIRE GATE, not the agent — the circuit is denying
   * fires to a live session. Sustained non-zero means the backoff is not clearing.
   */
  vetoedByWithheldFire: string[];
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
  const armWake =
    deps.armWake ??
    (async (input: { ownerId: string; note?: string | null }) => {
      const { armInboxWake } = await import('../../events/await/inbox-wake-arm');
      return armInboxWake(input);
    });
  const notify =
    deps.notify ??
    (async (input: AttentionNotifyInput) => {
      const { notifyAttention } = await import('../../attention-notify');
      await notifyAttention(input);
    });
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
      disarmedWhileReachable: [],
      repairedWakeStarved: [],
      vetoedByWithheldFire: [],
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
  /** EI-19899301656065801: disarmed owners the reachability probe still finds PRESENT. */
  const disarmedWhileReachable: string[] = [];
  /** WI-36685: owners whose fires were black-holing for want of a standing await. */
  const repairedWakeStarved: string[] = [];
  /** WI-36792: owners whose last fire the GATE withheld — never sent, so never answerable. */
  const vetoedByWithheldFire: string[] = [];
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
    if (wall && wall.resumesInMs != null && wall.resumesInMs > 0) {
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

    // WI-36685 — WAKE-STARVED, NOT TURN-STALLED. The fourth population, and the one that took
    // this very session dark twice in one day.
    //
    // The branch above catches an agent whose fires STOPPED. This one catches the opposite
    // signature: fires kept arriving on schedule and every one of them landed on NOBODY. A wake
    // emits on `coord:inbox-wake:<owner>`; with no standing await registered there,
    // emitAwaitedEvent matches nothing (woken:0, staged:0), loop-fire records `no-session-now`,
    // and — the part that makes this detectable — NO `event_wake_deliveries` row is ever
    // created. The agent is asleep, was never spoken to, and therefore has no recent turn. To
    // `last_turn_at` that is byte-identical to an agent that stopped answering, so it sails past
    // every exemption above and takes the permanent disarm.
    //
    // THE DISCRIMINATOR NEEDS NO NEW I/O, because it is a fact about history the status already
    // carries. `lastWakeAt` is NOT a stored column: loop.ts:1069 derives it as
    // COALESCE(delivered_at, created_at) over this routine's own wake-delivery rows. A row that
    // was created but never delivered would STILL advance it via created_at — so a frozen
    // `lastWakeAt` under an advancing `lastFiredAt` has exactly ONE explanation: no delivery row
    // was created at all. That is what separates this from a delivered-but-wedged child
    // (EI-19478552459475620), where the wake IS delivered (lastWakeStatus 'delivered', channel
    // 'psu-socket-reset') and `lastWakeAt` tracks the fires — correctly NOT this population.
    //
    // Measured on su-4a6e2255 (2026-08-08): ZERO delivery rows for 2h44m while fires advanced to
    // 21:54:31Z, every row that did exist status=delivered with an empty error. Never a delivery
    // FAILURE — no wake was ever attempted. Disarmed at 22:07:36Z, dark until the owner typed
    // into it by hand ~55 minutes later.
    //
    // WHY THE REPAIRABILITY GATE IS LOAD-BEARING, not a formality. The history test alone also
    // matches a genuine CORPSE: a session's standing await is cancelled by its SessionEnd hook,
    // so a dead owner's later fires create no delivery rows either and its `lastWakeAt` is just
    // as frozen. `awaitRepairable` is what separates them — it is true only when the await gate
    // is the ONLY thing blocking delivery and the session is otherwise live and injectable, so a
    // corpse (nothing live, nothing resumable) reads false and falls through to the disarm
    // exactly as before. Note this could NOT have been keyed on `reachable`: Gate 1 of
    // deriveWakeReachability returns before consulting any liveness signal, so a wake-starved
    // owner is unreachable BY CONSTRUCTION and a `reachable` gate would veto nothing, ever.
    //
    // AND THE REPAIR MUST ACTUALLY REPAIR. `rearmFireStarvedLoop` only moves `next_fire_at` — on
    // this population that fires straight back into the same black hole. Arming the standing
    // watch is the write that restores delivery; the nudge then makes it due immediately. Both,
    // in that order, or neither is worth doing. (The arm is deliberately NOT applied to owners
    // that fail the repairability gate: arming a watch for a dead session manufactures precisely
    // the zombie await that reads as a false `parked`/`wakeable` session and pins it against the
    // idle-session-reaper, which counts a standing await as alive.)
    //
    // Same asymmetry as the branch above, and it binds harder here: a wrong repair costs one
    // extra fire and self-corrects on the next sweep — the wake now genuinely lands, no turn
    // follows, `lastWakeAt` has advanced so this branch no longer matches, and the ordinary
    // disarm happens. A wrong disarm is permanent.
    const lastFiredMs = status.lastFiredAt ? Date.parse(status.lastFiredAt) : NaN;
    const lastWakeMs = status.lastWakeAt ? Date.parse(status.lastWakeAt) : NaN;
    const wakeStarved =
      Number.isFinite(lastFiredMs) &&
      (!Number.isFinite(lastWakeMs) || lastFiredMs - lastWakeMs >= turnsStalledFloorMs(status.intervalSec));

    // WI-36792 — WITHHELD, NOT WAKE-STARVED. The block below has THREE sub-cases and until now
    // implemented only two, so the third fell through to the permanent disarm.
    //
    // `wakeStarved` is already TRUE for a gate-withheld fire, and that is not a coincidence — it
    // is the same mechanical signature by a different cause. The claim stamps `last_fired_at` and
    // parks the row; the gate then DENIES the fire before `wake()` is ever called, so no
    // `event_wake_deliveries` row is created and `lastWakeAt` stays frozen under an advancing
    // `lastFiredAt`. Identical history, opposite remedy: there the wake was attempted and reached
    // nobody, here it was never attempted at all.
    //
    // The block escapes only via `awaitRepairable`, and that is exactly where this case falls
    // through: a withheld fire leaves the session's standing await INTACT (nothing consumed it),
    // so there is nothing to repair, `awaitRepairable` is false, and control reaches the disarm.
    // The healthiest possible state — live session, valid await — was being read as terminal.
    //
    // Measured on su-4a6e2255 (2026-08-08): `last_withheld_at` 21:54:40.570Z, reason 'fire-gate',
    // detail 'backoff (consecutive_errors=4, retry in ~454s)' — 9s after the 21:54:31.403Z claim,
    // with await 44729 alive and unfired the whole window. Disarmed at 22:07:36Z; dark until the
    // owner typed into the session by hand ~55 minutes later. `lastWithheldAt >= lastFiredAt` is
    // the whole discriminator, and it needs no new I/O — see LoopStatus.lastWithheldAt (loop.ts),
    // where it was surfaced for this reader.
    const withheldMs = status.lastWithheldAt ? Date.parse(status.lastWithheldAt) : NaN;
    const lastFireWasWithheld =
      Number.isFinite(withheldMs) && Number.isFinite(lastFiredMs) && withheldMs >= lastFiredMs;

    // Held so the disarm path below can reuse this probe instead of paying a second one.
    let probed: WakeReachabilityVerdict | null = null;
    if (wakeStarved) {
      probed = await probeReachability(ownerId).catch(() => null);
      if (probed?.awaitRepairable) {
        repairedWakeStarved.push(ownerId);
        console.warn(
          `[stalled-loops-guard] WAKE-STARVED ${ownerId}: fires advanced to ${status.lastFiredAt} while ` +
            `lastWakeAt stayed at ${status.lastWakeAt ?? 'never'} — no wake-delivery row was created, so the ` +
            `fires reached nobody. The session is alive and would take the ${probed.wouldBeChannel} channel ` +
            `once its inbox-wake watch is armed. Repairing + re-arming, NOT disarming — it was never asked ` +
            `for a turn (WI-36685).`,
        );
        if (!dryRun) {
          // Fail-soft: if the arm write fails, do NOT nudge the loop — a re-arm without a
          // restored watch just black-holes another fire and, worse, would leave this branch
          // reporting a repair that did not happen. Fall through to the disarm instead.
          const armed = await armWake({
            ownerId,
            note: `stalled-loops-guard wake-starved repair (WI-36685)`,
          })
            .then(() => true)
            .catch((e) => {
              console.warn(
                `[stalled-loops-guard] WAKE-STARVED ${ownerId}: armInboxWake FAILED ` +
                  `(${e instanceof Error ? e.message : e}) — not re-arming the loop, since a nudge without a ` +
                  `standing watch black-holes again.`,
              );
              return false;
            });
          if (!armed) {
            repairedWakeStarved.pop();
          } else {
            await rearm(
              sql,
              routineId,
              `stalled-loops-guard (WI-36685): wake-starved — fires advanced to ${status.lastFiredAt} with no ` +
                `wake delivery since ${status.lastWakeAt ?? 'never'}; inbox-wake watch re-armed ` +
                `(would-be channel ${probed.wouldBeChannel})`,
            );
            continue;
          }
        } else {
          continue;
        }
      }

      // WI-36792 — Case 2 of the wake-starved split: NOT repairable (a live session with a
      // VALID standing await has nothing for `armWake` to fix), but the reason `lastWakeAt`
      // is frozen is that the fire GATE withheld the most recent fire outright — it never
      // went out, so nobody was ever asked for a turn. Only reachable when the branch above
      // did not already `continue` (i.e. `!probed?.awaitRepairable`, or its repair write
      // failed and fell through — see the `repairedWakeStarved.pop()` path just above).
      //
      // `lastWithheldAt >= lastFiredAt` is the discriminator loop.ts documents on the field
      // itself: the claim stamps `lastFiredAt` and the gate is consulted immediately after,
      // so a withheld-at at or after it means THIS fire, not a stale one from a prior cycle.
      //
      // VETOED, not repaired and not re-armed — the gate's backoff is a deliberate cadence
      // (reconcileLoopRoutines' `gate-backoff` rebase honours `retryAfterSec`; re-arming here
      // would fight it, the same "leave it alone" reasoning as `vetoedByProviderWall`).
      if (!probed?.awaitRepairable) {
        const lastWithheldMs = status.lastWithheldAt ? Date.parse(status.lastWithheldAt) : NaN;
        const fireWasWithheld =
          Number.isFinite(lastWithheldMs) &&
          Number.isFinite(lastFiredMs) &&
          lastWithheldMs >= lastFiredMs;
        if (fireWasWithheld) {
          vetoedByWithheldFire.push(ownerId);
          console.warn(
            `[stalled-loops-guard] WITHHELD-FIRE VETO ${ownerId}: fires advanced to ${status.lastFiredAt} ` +
              `while lastWakeAt stayed at ${status.lastWakeAt ?? 'never'} — but the fire gate WITHHELD that ` +
              `claim (lastWithheldAt=${status.lastWithheldAt}), so it was never actually sent. The session ` +
              `is live with a valid standing await; there is nothing to repair. Refusing to disarm — the ` +
              `agent was never asked for a turn (WI-36792).`,
          );
          continue;
        }
      }
    }

    stalledOwners.push(ownerId);
    if (dryRun) continue;
    const reason =
      `turns-stalled: ${status.fireCount} fire(s), last fired ${status.lastFiredAt ?? 'never'}, ` +
      `last turn ${status.lastTurnAt ?? 'never'}`;
    await autoPause(sql, routineId, `stalled-loops-guard (WI-6639): ${reason}`);

    // EI-19899301656065801: ask whether the owner we just permanently disarmed is STILL THERE.
    //
    // Note where this probe sits. The fire-starved branch above consults reachability only
    // behind `answeredItsLastFire`, so on THIS path — the turn-stalled one — reachability was
    // never measured at all. That is the gap: a session whose last turn PRECEDES its last fire
    // is indistinguishable here from a 156h corpse, and both take the irreversible disarm. But
    // the two are not the same animal. A corpse is gone and disarming it is pure hygiene
    // (WI-6639's original population: 15 loops whose sessions had already ENDED). A session that
    // is still REACHABLE and simply stopped turning — a carry-respawn that died mid-flight, a
    // wedged CLI child — is recoverable, and after this write nothing will ever recover it: it
    // cannot re-arm itself (see the asymmetry argument above), `reconcileLoopRoutines` gates its
    // rescue sweep on `active = TRUE`, and its next `coord:orient` — whose `wakeSourceLostWarning`
    // is the designed catch for exactly this state — will never run, because running it requires
    // the turn it can no longer take.
    //
    // Disarming is still CORRECT for this shape: fires were landing and no turn followed, so
    // re-arming would only feed an agent that is not answering. What is missing is telling a
    // human, and the module's existing broadcast cannot do it — `broadcastSevereEvent` addresses
    // the FLEET, and no peer has a mandate to revive someone else's session. `notifyAttention` is
    // the OWNER rail (desktop SSE + APNs/FCM), and pairing the two is the established idiom for
    // "a human must act" (stale-routine-executor-watchdog.ts, EI-19388269294151851).
    //
    // Measured instance: su-4a6e2255 disarmed 2026-08-04T09:07:15Z, then dark for 4d6h until the
    // owner happened to resume that session BY HAND — which it did warm, with its context intact,
    // i.e. it had been sitting there recoverable the whole time.
    //
    // Fail-soft to `true` (page on an uncertain probe), matching the sibling branch's direction:
    // this only gates a NOTIFICATION, and one spurious page is far cheaper than the miss it
    // guards against. Reaching this line at all is rare, so it cannot become a flood.
    //
    // WI-36685: reuse the wake-starved branch's probe when it already ran for this owner rather
    // than paying a second one. Note the semantics survive the reuse: an owner that reached this
    // line WITH a `probed` verdict is one whose repairability gate said no, and `reachable` on
    // that same verdict is the honest answer to the different question asked here.
    const stillReachable =
      probed != null
        ? probed.reachable
        : await probeReachability(ownerId)
            .then((v) => v.reachable)
            .catch(() => true);
    if (stillReachable) disarmedWhileReachable.push(ownerId);
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
          : '') +
        (repairedWakeStarved.length > 0
          ? `\n\nALSO NOT disarmed: ${repairedWakeStarved.length} loop(s) were WAKE-STARVED ` +
            `(${repairedWakeStarved.join(', ')}) — their fires kept arriving but reached nobody, because no ` +
            `standing inbox-wake await was registered, so no wake-delivery row was ever created. Those ` +
            `agents were never asked for a turn. Their watch has been re-armed and the loops made due ` +
            `(WI-36685).`
          : ''),
      category: 'severe-event',
    });
  }

  // EI-19899301656065801: page the OWNER for the subset that was still REACHABLE when disarmed.
  //
  // Deliberately separate from the broadcast above rather than folded into it, because the two
  // have different audiences and different jobs. The broadcast tells the FLEET that a batch went
  // dark, which is a systemic-pattern signal ("a cluster is usually ONE event"). This tells the
  // ONE person who can do anything about it that a specific, still-present session has been made
  // permanently unwakeable and needs a manual `loop:arm` to come back.
  //
  // Guarded on a non-empty reachable subset, so the corpse-reaping case WI-6639 was built for —
  // sessions that ended long ago — stays as silent as it is today.
  //
  // The notify is wrapped in its own try/catch: paging is strictly an addition to this sweep's
  // job, and a push transport being down must never cost us the disarm bookkeeping or the
  // broadcast that already succeeded.
  if (disarmedWhileReachable.length > 0 && !dryRun) {
    try {
      await notify({
        kind: 'intervention',
        title:
          disarmedWhileReachable.length === 1
            ? `Agent ${disarmedWhileReachable[0]} was disarmed while still reachable — it cannot wake itself`
            : `${disarmedWhileReachable.length} reachable agents were disarmed — they cannot wake themselves`,
        body:
          `${disarmedWhileReachable.join(', ')}\n\n` +
          `Each was still answering a reachability probe when stalled-loops-guard disarmed its ` +
          `engine loop for producing no turns despite repeated fires. The disarm is correct — an ` +
          `agent that is not answering its fires will not be helped by more of them — but it is ` +
          `also PERMANENT: a disarmed loop cannot re-arm itself, reconcileLoopRoutines only ` +
          `re-arms loops that are still active, and the agent's own "nothing will wake you" ` +
          `warning needs a turn it can no longer take.\n\n` +
          `Nothing else will recover these. To bring one back: resume the session and re-arm its ` +
          `loop (loop:arm). If this keeps happening, the upstream question is why the sessions ` +
          `stop turning — a died carry-respawn and a wedged CLI child both present this way.`,
        importance: 'urgent',
        workspaceId: ws,
        data: { owners: disarmedWhileReachable.join(','), count: disarmedWhileReachable.length },
      });
    } catch (e) {
      console.warn(
        `[stalled-loops-guard] owner page failed for ${disarmedWhileReachable.length} reachable ` +
          `disarm(s) (${disarmedWhileReachable.join(', ')}): ${e instanceof Error ? e.message : e}`,
      );
    }
  }

  // EI-19406534159939583: a fire-starved batch with NO turn-stalled disarms alongside it still
  // needs to be loud. It is arguably the MORE serious of the two — agents that are alive and
  // working are receiving no wakes — and before this split it was invisible, because the only
  // broadcast in this module was gated on `stalledOwners.length > 0`.
  //
  // WI-36685 folds the WAKE-starved population into this same broadcast rather than adding a
  // second one. Both are "live agents the delivery path stopped serving", they differ only in
  // WHERE it broke (no fire emitted vs. a fire that reached nobody), and a sweep that turns up
  // both at once is emphatically ONE event — emitting two notices for it would be the exact
  // "don't spam N inboxes for one root cause" failure this module's own broadcast avoids.
  //
  // The SUMMARY still names the specific fault when only one population is present — a reader
  // paged by this line should not have to open the body to learn whether fires stopped or fires
  // landed nowhere, since those point at different code. Only a genuinely mixed sweep gets the
  // generic wording.
  const starved = [...reArmedFireStarved, ...repairedWakeStarved];
  if (starved.length > 0 && stalledOwners.length === 0 && !dryRun) {
    await broadcast({
      summary:
        repairedWakeStarved.length === 0
          ? `${reArmedFireStarved.length} armed engine loop(s) on ${ws} stopped RECEIVING fires while still ` +
            `answering them — re-armed, not disarmed (EI-19406534159939583).`
          : reArmedFireStarved.length === 0
            ? `${repairedWakeStarved.length} armed engine loop(s) on ${ws} had every fire reach NOBODY — no ` +
              `standing inbox-wake await, so nothing was ever delivered; repaired, not disarmed (WI-36685).`
            : `${starved.length} armed engine loop(s) on ${ws} were being STARVED of turns while still alive — ` +
              `repaired, not disarmed (EI-19406534159939583 / WI-36685).`,
      body:
        (reArmedFireStarved.length > 0
          ? `FIRE-STARVED (no fire emitted): ${reArmedFireStarved.join(', ')}. Each one's most recent turn ` +
            `is at or after its most recent fire — it answered every fire it was given — and then a stall ` +
            `floor's worth of time passed with no new fire. They have been made due immediately ` +
            `(next_fire_at = now). A cluster here means the scheduler tick, the loop completion-rebase, or ` +
            `a shed that skips it — start at routines-workflow.ts's routinesTick.\n\n`
          : '') +
        (repairedWakeStarved.length > 0
          ? `WAKE-STARVED (fires emitted, reached nobody): ${repairedWakeStarved.join(', ')}. Fires kept ` +
            `arriving on schedule, but no standing coord:inbox-wake await was registered for these owners, ` +
            `so each emit matched nothing and NO event_wake_deliveries row was created — the agents were ` +
            `never actually spoken to. Their watch has been re-armed and the loops made due. A cluster ` +
            `here means awaits are being cancelled or never armed — start at the SessionEnd hook's ` +
            `cancel path and loop-fire's ensureInboxWakeArmedForActiveSession self-heal.\n\n`
          : '') +
        `The agents are not at fault in either case. If they resume, the delivery path was the problem; ` +
        `if a fire now lands and no turn follows, the next sweep reclassifies and disarms them normally.`,
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
    disarmedWhileReachable,
    repairedWakeStarved,
    vetoedByWithheldFire,
    dryRun,
  };
}
