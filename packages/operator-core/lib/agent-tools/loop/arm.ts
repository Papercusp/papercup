/**
 * loop:arm — arm an engine-managed LOOP on your OWN session (or another
 * owner's, with `ownerId` — WI-1471): the tracked, restart-surviving,
 * observable replacement for Claude Code's built-in `/loop` for su/interactive
 * agents (loop-routines-interval-recurrence-2026-06-20, B-LOOP-5 / P-008).
 *
 * Each fire re-wakes THIS warm session ~intervalSec AFTER the previous turn
 * settles (a `coord:send {wake}` to the caller's ownerId, riding the wake-executor
 * liveness ladder — inject if live, `claude --resume` if exited; B-LOOP-3) — NOT
 * a fresh cold run, so the conversation/context carries across iterations. The
 * loop is a durable `harness_shared.routines` row, so it survives operator
 * restarts, is observable (loop:status + fleet:assignments + fire-history), and
 * inherits the engine guardrails (failure-streak fire-gate + an optional
 * cost-cap). End it with loop:end.
 *
 * This is the user-directed counterpart to the autonomous queen/bee/scout loop,
 * which is a SEPARATE system (pot:declare-wake / kettle:declare-wake) and is
 * out of scope here (plan D-007) — do not use loop:arm from an autonomous-fleet
 * agent.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { FLAGS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';
import { COORD_ROLES } from '../coordination/roles';
import { resolveAgentIdentity } from '../coordination/identity';
import { activeWorkspaceId } from '../../workspace-registry';
import { resolvePotHomeSlug } from '../../pot/wake';
import { resolveHomePotSlug } from '../pot/_resolve';
import { isParkedNextFire } from '@papercusp/db-org';
import {
  materializeLoop,
  buildLoopWakePrompt,
  detectDrivenWorkItemId,
  readActiveLoopFacts,
  type PriorLoopFacts,
  LOOP_INTERVAL_FLOOR_SEC,
} from '../../harness/routines/loop';
import { claimWorkItem, classifyClaimFailure, getWorkItem } from '../../work-items';
import { armInboxWake } from '../../events/await/inbox-wake-arm';
import { listWakeAwaitsForSubscriber } from '../../events/await/store';
import { findLiveHost, sessionClassForHost } from '../../events/await/psu-pty-discovery';
import {
  probeWakeReachability,
  type WakeReachabilityVerdict,
} from '../../events/await/wake-reachability';
import { softText, clampText } from '../limits';
import { refreshControlAnchorAfterMutation } from '../coordination/control-anchor';

const MAX_LOOP_INTERVAL_SEC = 60 * 60 * 24 * 7; // 7 days — beyond this, use a schedule (a fixed clock), not a loop

/**
 * EI-19395290807657827 — the SELF-SEALING BACKOFF. An agent's only backoff lever is a
 * longer interval, but a longer interval is exactly what removes its ability to observe
 * the blocker CLEARING: the wider you set it because you are blocked, the longer you keep
 * sleeping after you stop being blocked. Nothing in the loop re-evaluates the premise the
 * interval was chosen under.
 *
 * Measured 2026-08-03 on fleet nonp2p-bug-drain-0801: FIVE members re-armed at a ~2 HOUR
 * interval inside a 32-SECOND window — the clustering proving it was one shared reaction
 * (an 8h-red gate), not five independent judgments. The gate was fixed and re-fired by
 * 01:54Z; they would have slept until 03:58Z regardless. Cost: ~9 agents x ~1h idle
 * against 70 claimable items, on a fleet whose entire mission was draining that queue.
 * Only an external actor (the leader, hand-waking all 10) broke it — none were dead, all
 * were merely asleep on a timer. The persona already says "restore the cadence the instant
 * the blocker clears", but that is UNACTIONABLE from inside a sleeping agent: restoring
 * requires a wake, and the wake is precisely what was postponed.
 *
 * The fix makes the persona's own push-beats-polling rule enforceable, via an INCENTIVE
 * rather than a refusal — name the blocker's event and keep your long interval (the clear
 * pushes a wake); name no event and the interval is CAPPED, because an agent that cannot
 * be pushed must at least poll often enough to notice. Either way the premise is written
 * into the KICKOFF, which is re-delivered on every wake, so the next wake re-checks the
 * specific condition instead of silently inheriting it.
 */
const BLOCKED_INTERVAL_CAP_SEC = 15 * 60;

/** What the caller declared it is blocked on, when it widened the interval. */
export interface LoopBlockedOn {
  reason: string;
  event?: string;
}

export interface BlockedBackoffResolution {
  /** The interval to actually arm — capped when the backoff has no push channel. */
  intervalSec: number;
  /** True when the cap was applied (i.e. the requested interval was reduced). */
  clamped: boolean;
  /** Advisory line for the response, or null when nothing needs saying. */
  note: string | null;
  /**
   * Premise text to inject into the KICKOFF so it is re-delivered on EVERY wake. This is
   * the actual auto-restore mechanism: the sleeping agent cannot re-read this tool's
   * response, but it always re-reads its wake prompt.
   */
  wakePremise: string | null;
}

/**
 * EI-19447204017443244: what the ARM-TIME lookup of the caller's own live wake-capable
 * awaits found. Purely descriptive — it changes the MESSAGE, never the cap (the item
 * chose that explicitly: the nudge toward a catalogued clearing event is what actually
 * helps, so the fix is to stop asserting an unchecked premise, not to relax the guard).
 *
 * `unknown` is the DEFAULT precisely because it is the honest state when the lookup was
 * not run or failed. It must never collapse into `none`: "I did not look" and "I looked
 * and there was nothing" are different claims, and printing the second for the first is
 * the exact defect this whole change exists to remove.
 */
export type LivePushChannels =
  | { status: 'none' }
  | { status: 'found'; count: number; sample: readonly string[] }
  | { status: 'unknown' };

/**
 * PURE: resolve a blocker-motivated interval. Omitting `blockedOn` preserves the exact
 * pre-existing BEHAVIOUR (no cap, no premise, interval untouched) — since P-006/D-098 it
 * may return an advisory `note`, but nothing that changes what the loop does.
 *
 * `livePush` (EI-19447204017443244) is an OPTIONAL arm-time observation supplied by the
 * handler; omitting it yields `unknown`, which is why every pre-existing caller and test
 * is untouched by this parameter.
 */
export function resolveBlockedBackoff(
  requestedIntervalSec: number,
  blockedOn?: LoopBlockedOn | null,
  livePush: LivePushChannels = { status: 'unknown' },
): BlockedBackoffResolution {
  if (!blockedOn) {
    // P-006 / D-098 — SURFACE THE AFFORDANCE AT THE ONE MOMENT IT IS ACTIONABLE.
    //
    // `blockedOn` was built, is strictly better than a prose-matching auto-attach, and
    // measured 0 uses in 294 arm calls across 91 distinct arming agents (14d). Zero, not
    // low. It is optional and nothing ever asks for it — D-016's shape exactly, so it got
    // the adoption prose earns.
    //
    // ⚠ THE TRIGGER IS THE INTERVAL, NEVER THE GOAL TEXT, and that is a ruling not a
    // preference (D-098). Matching the goal prose was P-006's original proposal and it is
    // undecidable here: of 292 armed goals, 182 are work-pull/drain loops where a loop is
    // CORRECT, and 117 (40%) match the drain AND blocker vocabularies simultaneously — a
    // drain loop that mentions a gate in passing is textually identical to a gate-watch
    // loop. Every false positive would nudge an agent toward parking a loop that must keep
    // pulling. The interval is a STRUCTURAL signal and needs no matcher.
    //
    // Threshold reuses BLOCKED_INTERVAL_CAP_SEC rather than inventing a second constant, so
    // the nudge fires exactly where the cap WOULD have applied had the blocker been
    // declared — i.e. on loops that took the widening without the annotation that governs
    // it. Measured: 115 of 292 arms (39%) sit at or above it, p90 1800s, max 4200s; the
    // 65 arms at <=60s never see this.
    //
    // Advisory ONLY — no cap, no premise, no behaviour change. An undeclared long interval
    // is legitimate (a genuinely slow cadence), so this must inform and never obstruct.
    if (requestedIntervalSec >= BLOCKED_INTERVAL_CAP_SEC) {
      return {
        intervalSec: requestedIntervalSec,
        clamped: false,
        note:
          `⏸ ${requestedIntervalSec}s is a WIDE interval. If you widened it because you are waiting on something, ` +
          `say so: loop:arm { blockedOn: { reason, event } }. Naming the clearing event (events:catalog lists them) ` +
          `keeps your interval AND re-checks the premise on every wake; naming only a reason caps the interval at ` +
          `${BLOCKED_INTERVAL_CAP_SEC}s so a cleared blocker cannot leave you asleep (EI-19395290807657827). ` +
          `⚠ Park on the event IN ADDITION to this loop, never instead of it — a parked await suppresses these ` +
          `fires, so an await on an event that never fires (a gate that goes red, say) removes your only way back ` +
          `(WI-6595). If the cadence is simply slow by design, ignore this.`,
        wakePremise: null,
      };
    }
    return { intervalSec: requestedIntervalSec, clamped: false, note: null, wakePremise: null };
  }

  // A named event means the CLEAR can push a wake, so a long interval is no longer
  // self-sealing — the timer is a backstop, not the only way back. Honour it as passed.
  if (blockedOn.event) {
    return {
      intervalSec: requestedIntervalSec,
      clamped: false,
      note:
        `⏸ Backoff recorded: blocked on "${blockedOn.reason}" — interval honoured as ${requestedIntervalSec}s because you named the clearing event \`${blockedOn.event}\`. ` +
        `NOW ACTUALLY PARK ON IT: events:await { event: '${blockedOn.event}', timeout_sec, on_timeout: 'wake' } — naming the event here does NOT register the await, and an unparked long interval is the self-sealing backoff this field exists to prevent (EI-19395290807657827).`,
      wakePremise:
        `You widened this loop's interval because you were BLOCKED ON: "${blockedOn.reason}". ` +
        `RE-CHECK THAT PREMISE FIRST, before anything else — it may have cleared while you slept. ` +
        `It should push a wake via \`${blockedOn.event}\`; if it has cleared, RESTORE your normal cadence immediately (re-arm without blockedOn) rather than continuing at the widened interval.`,
    };
  }

  // No event to be pushed by ⇒ the timer is the ONLY way back, so it must stay short
  // enough to notice a clear. Cap rather than refuse: backing off is legitimate, and a
  // refusal would just push agents back to the un-annotated widening this replaces.
  const capped = Math.min(requestedIntervalSec, BLOCKED_INTERVAL_CAP_SEC);
  const clamped = capped < requestedIntervalSec;

  // EI-19447204017443244 — THE CLAIM IS SCOPED TO THIS LOOP, which is what makes it
  // true by construction. The old text said "nothing can push you a wake" flatly, and
  // that is a statement about the caller's WHOLE wake surface, which this function had
  // never looked at: a caller holding a live `state:subscribe` watch was told, as fact,
  // that no push channel existed. Saying "no clearing event was named FOR THIS LOOP, so
  // nothing will push you a wake WHEN IT CLEARS" keeps every ounce of the nudge while
  // asserting only what the cap actually knows — a separately-registered await is not
  // wired to this blocker, which is the very reason the cap still applies.
  const capReason =
    `because you named no clearing event for this loop, so nothing will push you a wake when it clears and the timer is your only way back ` +
    `— a wider interval would just mean sleeping longer AFTER the blocker clears (EI-19395290807657827). `;

  // The arm-time observation, attached ONLY in the branch that actually made it.
  // `unknown` adds nothing: the base sentence above is already true without a lookup,
  // so silence is the honest rendering of "not measured" (never a fabricated "none").
  const livePushNote =
    livePush.status === 'found'
      ? ` ⓘ FWIW you DO hold ${livePush.count} live wake-await(s) right now (${livePush.sample.map((k) => `\`${k}\``).join(', ')}) — ` +
        `this tool cannot tell whether any of them fires on THIS blocker, so it still capped. If one of them IS your clearing signal, re-arm with blockedOn.event naming it.`
      : livePush.status === 'none'
        ? ` (Checked: apart from your standing inbox-wake you hold no live wake-awaits, so this is measured, not assumed.)`
        : '';

  return {
    intervalSec: capped,
    clamped,
    note: clamped
      ? `⏸ Backoff recorded: blocked on "${blockedOn.reason}". Interval CAPPED ${requestedIntervalSec}s → ${capped}s ` +
        capReason +
        `To keep a longer interval, pass blockedOn.event with the events:catalog key that fires on the clear (events:catalog lists them) and park on it with events:await.` +
        livePushNote
      : `⏸ Backoff recorded: blocked on "${blockedOn.reason}". Interval ${capped}s is within the ${BLOCKED_INTERVAL_CAP_SEC}s cap for a backoff with no clearing event.`,
    // The premise is re-injected on EVERY wake, arbitrarily later — so it deliberately
    // names NO specific await. A once-await fires and is gone; "you hold watch #44071"
    // would be a fresh false claim of this same class, merely time-shifted.
    wakePremise:
      `You widened this loop's interval because you were BLOCKED ON: "${blockedOn.reason}". ` +
      `RE-CHECK THAT PREMISE FIRST, before anything else — it may have cleared while you slept. ` +
      `No clearing event was named for this loop, so NOTHING will push you a wake when this blocker clears: this timer is the only way you find out. ` +
      `If it has cleared, RESTORE your normal cadence immediately (re-arm without blockedOn).`,
  };
}

/** Cosmetic short form for an overridden owner id (display only, never keyed
 *  on) — mirrors resolveAgentIdentity's own `shortId` formatting so an
 *  ownerId-override loop's label reads the same as a self-armed one. */
function shortOwnerLabel(id: string): string {
  if (id.startsWith('pus-')) return id.slice(0, 12);
  return id.length > 8 ? id.slice(0, 8) : id;
}

/**
 * B (cold-with-carry-activation-2026-07-20, owner-directed): the arm-time carry
 * DEFAULT when the caller passes no explicit `carry`. A HEADLESS session
 * (host.bridgeTty===false ⇒ sessionClassForHost 'claude-headless') defaults to
 * 'cold' — an unattended AUTO loop should shed its transcript to its carry-note
 * each wake, not re-wake the SAME warm session until context overflows and dies
 * uncleanly (WI-5557 / the fa10eeb7 warm-to-974k-death incident). An INTERACTIVE /
 * human-present session ALWAYS stays warm (D-005 never-cold-a-human).
 *
 * Flag-gated (HEADLESS_LOOPS_COLD_BY_DEFAULT, default ON) and FAIL-SOFT: any
 * resolution failure — flag store down, no live host discovery record — yields
 * 'warm' (the historical default), so this can only ADD cold on a CONFIDENTLY
 * headless session, never surprise-cold anything. Layered under SU_COLD_AUTO: even
 * a cold-armed loop only actually colds when that master gate is on AND a carry-note
 * exists (decideColdWake), so this is a DEFAULT change, not a new cold path.
 */
/** The PURE B decision (exported for unit test): given the flag state and the loop
 *  owner's live host, the arm-time carry default. 'cold' ONLY when the flag is on
 *  AND the host classifies headless (sessionClassForHost 'claude-headless',
 *  i.e. bridgeTty===false); 'warm' otherwise (flag off, interactive, or no host). */
export function decideDefaultCarry(
  flagOn: boolean,
  host: Parameters<typeof sessionClassForHost>[0],
): 'warm' | 'cold' {
  if (!flagOn) return 'warm';
  return host && sessionClassForHost(host) === 'claude-headless' ? 'cold' : 'warm';
}

async function resolveDefaultCarry(ownerId: string): Promise<'warm' | 'cold'> {
  try {
    const flagOn = await getFlag(FLAGS.HEADLESS_LOOPS_COLD_BY_DEFAULT, 'system');
    return decideDefaultCarry(flagOn, findLiveHost(ownerId));
  } catch {
    return 'warm'; // fail-soft to the historical warm default
  }
}

/** Normalize free text for a loose goal-containment check (case/whitespace-insensitive). */
function normalizeLoopText(s: string): string {
  return String(s ?? '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** The surfaced comparison when a re-arm materially changes an ACTIVE loop's goal
 *  (EI-18221784742583615). Advisory only — the loop is still (re-)armed. */
export interface LoopOverwriteNote {
  priorIntervalSec: number | null;
  priorFireCount: number;
  priorCarry: 'warm' | 'cold';
  priorMode: 'work' | 'monitor';
  priorArmedAt: string | null;
  priorKickoffExcerpt: string;
  intervalChanged: boolean;
  message: string;
}

/**
 * EI-18221784742583615 — the PURE arm-time overwrite decision. loop:arm is an UPSERT
 * keyed on (owner, name), so re-arming REPLACES the owner's single loop row wholesale.
 * A stale/replayed fleet-kickoff turn (an expired-nonce envelope redelivered ~25h late)
 * could therefore silently clobber an ACTIVE, specialized, long-running loop (rich
 * checkpoint state, high fireCount, e.g. a 1200s WI-5672 watch) with a generic goal and
 * a fast 120s cadence — the arming agent, taking the stale premise at face value before
 * reading its own held work-items, never saw what it replaced.
 *
 * Given the prior active loop's facts and the incoming arm, decide whether the re-arm
 * MATERIALLY changes the loop's GOAL — the harmful case — and, if so, produce the
 * comparison to surface. Returns null (no warning — the loop still arms) when:
 *   - there is no prior loop, or it is not active (a fresh start / re-arm over an ended
 *     loop is fine); OR
 *   - the newly-built kickoff equals the prior kickoff (an identical re-arm); OR
 *   - the new goal text already appears in the prior kickoff (the default template embeds
 *     `{goal}`, so an interval-only / carry / mode retune — the normal in-turn re-arm —
 *     keeps the goal and is NOT flagged).
 * Only a goal SWAP (new goal not represented in the prior kickoff) surfaces the note. Pure
 * + exported for unit tests, mirroring decideDefaultCarry / computeLoopStall.
 */
export function computeLoopOverwriteNote(
  prior: PriorLoopFacts | null,
  next: { goal: string; intervalSec: number; kickoff: string },
): LoopOverwriteNote | null {
  if (!prior || !prior.active) return null;
  const priorKickoffNorm = normalizeLoopText(prior.kickoff);
  // Identical re-arm (same built kickoff, incl. a re-armed custom wakePrompt): the same
  // loop, unchanged — no warning.
  if (priorKickoffNorm === normalizeLoopText(next.kickoff)) return null;
  const nextGoal = normalizeLoopText(next.goal);
  // Goal preserved (present verbatim in the prior kickoff)? Then only interval/carry/mode
  // changed — a deliberate retune, not a goal swap. No warning.
  if (nextGoal.length > 0 && priorKickoffNorm.includes(nextGoal)) return null;
  const intervalChanged = prior.intervalSec != null && prior.intervalSec !== next.intervalSec;
  const excerpt = prior.kickoff.trim().slice(0, 240);
  const message =
    `This re-arm OVERWRITES an already-ACTIVE loop (fired ${prior.fireCount}×` +
    `${prior.armedAt ? `, last armed ${prior.armedAt}` : ''})` +
    (intervalChanged ? ` — interval ${prior.intervalSec}s → ${next.intervalSec}s` : '') +
    ` whose goal DIFFERS from the new one. If you did NOT intend to replace it (e.g. this` +
    ` turn came from a stale/replayed kickoff), do NOT proceed on the new goal — check` +
    ` loop:status, then loop:end + re-arm the correct loop. Prior kickoff: "${excerpt}` +
    `${prior.kickoff.length > 240 ? '…' : ''}"`;
  return {
    priorIntervalSec: prior.intervalSec,
    priorFireCount: prior.fireCount,
    priorCarry: prior.carry,
    priorMode: prior.mode,
    priorArmedAt: prior.armedAt,
    priorKickoffExcerpt: excerpt,
    intervalChanged,
    message,
  };
}

export default defineTool({
  name: 'loop:arm',
  profile: 'engineer',
  description:
    'Arm the tracked engine loop for your session (or another ownerId) — the durable replacement for Claude /loop. Each fire re-wakes that warm session after its prior turn settles; context carries across iterations. Observable via loop:status / fleet:assignments and stoppable with loop:end.',
  guidance: {
    when: 'Use for an su/interactive session that should keep advancing a goal on a recurring cadence. Arm it last before ending your turn. Pass ownerId only to arm an already-running, wake-reachable session other than your own.',
    notWhen:
      'Not for wall-clock schedules (plans:set-schedule) or autonomous queen/bee/scout loops (pot:declare-wake / kettle:declare-wake). Do not use Claude /loop instead. Not the PRIMARY watcher when the thing you watch already emits — park on it with events:await and keep the loop as the slow backstop.',
    chaining:
      'loop:arm { intervalSec, goal } → end turn → re-wakes each iteration → loop:status to inspect → loop:end to stop.',
    seeAlso: [
      'loop:end (stop the loop — also takes ownerId)',
      'loop:status (inspect it — also takes ownerId)',
      'plans:set-schedule (wall-clock recurrence instead)',
    ],
  },
  capability: 'routines:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    ownerId: z
      .string()
      .max(120)
      .optional()
      .describe(
        'Arm the loop for this owner id instead of the caller\'s own resolved identity (default: yourself). Mirrors loop:end/loop:status\'s ownerId — the same "or another owner\'s" override, previously missing here (WI-1471).',
      ),
    intervalSec: z
      .number()
      .int()
      .min(LOOP_INTERVAL_FLOOR_SEC)
      .max(MAX_LOOP_INTERVAL_SEC)
      .describe(
        'Seconds AFTER each turn settles before the next wake (≥60). IN AUTO MODE the DEFAULT is 60 (a 1-minute cadence) unless the owner specifies otherwise — only lengthen it when the loop is genuinely blocked on a slower-moving dependency (a deploy, a long gate suite), and restore 1m the moment it clears, because a multi-minute loop is indistinguishable from a dead one to an owner watching for progress. The true period is interval + up-to-30s (the turn-settle is observed on the 30s reconcile tick), so sub-minute is not supported.',
      ),
    blockedOn: z
      .object({
        reason: z
          .string()
          .min(1)
          .max(500)
          .describe('What you are blocked on, in one line (e.g. "green gate red 8h, blocking every deploy").'),
        event: z
          .string()
          .max(200)
          .optional()
          .describe(
            "The events:catalog key that fires when this blocker CLEARS. Name it and your interval is honoured as-passed, because the clear PUSHES a wake instead of you waiting out the timer — then actually park on it (events:await { event, timeout_sec, on_timeout:'wake' }). Omit it and the interval is CAPPED to 15min: an agent that cannot be pushed must poll often enough to notice.",
          ),
      })
      .optional()
      .describe(
        'Pass this WHENEVER you are lengthening the interval because you are BLOCKED (rather than because the work is genuinely slow-moving) — EI-19395290807657827. It records WHY the interval was widened so the premise is re-checked on the next wake instead of silently inherited, caps a blocker-motivated interval that has no push channel, and lets a fleet leader see "N members backed off for X, which cleared M minutes ago".',
      ),
    goal: softText(4000, { min: 1 })
      .describe('One line: what this loop is working toward — echoed into every wake. Auto-truncated to 4000 chars if longer.'),
    harness: z
      .string()
      .max(120)
      .optional()
      .describe(
        'Harness the loop is scoped to / namespaced under. Omit it (or use the workspace-global all/* scope) to resolve the workspace home pot; otherwise defaults to your concrete session harness.',
      ),
    wakePrompt: softText(4000)
      .optional()
      .describe(
        'Advanced: a custom per-wake instruction, replacing the default "create + self-assign your work_items, work them, set_state" template. Most loops should omit this. Auto-truncated to 4000 chars if longer.',
      ),
    workItem: z
      .string()
      .max(120)
      .optional()
      .describe(
        'The WI-/EI-/F- work-item this loop is DRIVING. It is auto-CLAIMED for the loop owner at arm time (WI-2429), so the item is HELD from wake 1 — the per-item work_items:checkpoint death-resilience net engages and a successor/reclaimer inherits it if the session dies. Safe: the claim never steals a live peer\'s item (a conflict is reported, not forced). If omitted on a COLD loop, a single WI-/EI-/F- id mentioned in `goal` is auto-detected and claimed the same way.',
      ),
    carry: z
      .enum(['warm', 'cold'])
      .optional()
      .describe(
        "Loop lifecycle (su-cold-auto-mode-2026-07-03). DEFAULT (cold-with-carry-activation-2026-07-20): a HEADLESS/unattended session defaults to 'cold', an INTERACTIVE session to 'warm' — pass this only to OVERRIDE that default. 'warm' = each fire re-wakes THIS same warm session in place, context carried (an unbounded warm loop can hit the ceiling and die — WI-5557). 'cold' = the fresh-context lifecycle for an UNATTENDED AUTO loop: each fire RESETs the session to its carry-note (a periodic RECYCLE every Nth wake) instead of a warm turn, so the transcript never grows unbounded. Cold requires a carry-note anchor and the cold-auto master gate (decideColdWake). NEVER use 'cold' for an interactive/human-present session (D-005).",
      ),
    continuation: z
      .enum(['settle', 'gated'])
      .optional()
      .describe(
        "Continuation policy (flush-to-proceed-stretch-discipline-2026-07-04 P-005). 'settle' (DEFAULT) = today's behaviour — do one iteration's work each wake, then end the turn. 'gated' = the runtime expects MULTIPLE units per turn, each gated by the continuation gate (loop:checkpoint returns the verdict: context headroom below the ceiling? no pending owner input / inbox interrupt?): after settling a unit you flush your checkpoints then continue in-turn while the gate is OPEN, else end the turn. Recovers the per-wake orient/re-read boundary tax by running units back-to-back — arm a LONGER interval for a gated loop. Rides payload_template (no schema change); a settle loop is byte-identical to today.",
      ),
    mode: z
      .enum(['work', 'monitor'])
      .optional()
      .describe(
        "Wake-contract shape. 'work' (DEFAULT) = each wake creates + self-assigns work_items and works them. 'monitor' = a leader/supervisor loop that WATCHES something (a fleet, a pipeline, a soak): the wake says check → act only on deltas → checkpoint → end turn, with NO per-wake work-item boilerplate. Ignored when a custom wakePrompt is passed.",
      ),
    costCapCents: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Auto-pause the loop if its cumulative cost crosses this many cents (best-effort).'),
    maxFires: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        'Dead-man guard: auto-pause the loop after this many wake fires SINCE THIS ARM (a bound on a runaway loop). Arm-relative, like maxDurationSec — a re-arm resets the count to 0, so `maxFires: 4` always means "4 more fires from now", never a lifetime total (EI-19339729634604096: this used to compare against the loop\'s cumulative lifetime fire count, so re-arming a session that had already fired more times than the new bound auto-paused it on the very first post-re-arm fire).',
      ),
    maxDurationSec: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Dead-man guard: auto-pause the loop this many seconds after it was armed (a bound on a forgotten / permanently-dead loop).'),
  }),
  async handler(args, ctx) {
    // Feature gate (papercusp-loops). Default OFF until the full loop engine
    // (fire + completion-rebase) is verified green end-to-end; flip in
    // /admin/features. loop:end is intentionally NOT gated (always stoppable).
    if (!(await getFlag(FLAGS.LOOPS, 'system'))) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: false,
              error: 'loops_disabled',
              message:
                'The loop feature (flag papercusp-loops) is off — enable it in /admin/features once the loop engine is verified green.',
            }),
          },
        ],
        isError: true,
      };
    }

    const identity = resolveAgentIdentity(ctx);
    // WI-1471: honor an explicit owner override (mirrors loop:end/loop:status,
    // which already accept `ownerId` with no extra gate beyond this tool's own
    // `capability:'routines:write'`). Without this, a caller with no per-session
    // uiClientId (e.g. a client-less ptool/curl bridge over the superuser
    // transport) silently binds the loop to resolveAgentIdentity's SUPERUSER_
    // FALLBACK_CLIENT_ID ('su-loopback') — a fixed id that is never a live,
    // wake-reachable session, so the loop is armed but can never actually fire
    // into a running turn.
    const ownerId = args.ownerId ?? identity.ownerId;
    const ownerLabel = args.ownerId ? `su · ${shortOwnerLabel(args.ownerId)}` : identity.ownerLabel;
    const workspaceId = ctx.workspaceId ?? ctx.principal?.workspaceId ?? activeWorkspaceId();
    // No `?? ''` collapse — keep the unresolved case nullish so the guard below catches
    // it and fails loud (a routine with an empty harness namespace would collide across
    // hives). workspace-data-isolation-leaks P-003.
    // EI-7734: route through resolvePotHomeSlug(explicit, ctxSlug) — NOT a raw `??`
    // chain — so its '*'-skip logic actually runs. Every superuser/operator-scope
    // session sets ctx.harnessSlug = '*' (the wildcard sentinel, `_harness-scope.ts`),
    // which is truthy and so WON A raw `args.harness ?? ctx.harnessSlug ?? …` chain
    // outright, before ever reaching the env-home fallback. That '*' then got
    // interpolated verbatim into the wake prompt's self-task example
    // (`work_items:create { …, harness:'*', … }`) — a value work_items:create's own
    // harness resolution rejects, so an SU loop's every wake failed to self-assign its
    // iteration's work_item. Same class of bug as the 2026-07-01 `pot:wake` 404
    // (installSlug='*') that resolvePotHomeSlug's '*'-skip was written to prevent —
    // this call site just wasn't routed through it.
    // Workspace-scoped operator sessions carry the '*' sentinel rather than a
    // concrete harness. A durable loop cannot be installed under that sentinel:
    // every wake must carry a real harness for coord:orient/scheduler:get_next.
    // Resolve the workspace's formal home pot in that case, so callers do not
    // have to discover and repeat a concrete slug (EI-20185529721601434). Keep
    // the synchronous resolver as a fallback for legacy env-only sessions and
    // explicit concrete selectors.
    const isConcreteHarness = (value?: string | null): boolean => {
      const trimmed = value?.trim().toLowerCase();
      return Boolean(trimmed && trimmed !== '*' && trimmed !== 'all');
    };
    const onlyWorkspaceScope = !isConcreteHarness(args.harness) && !isConcreteHarness(ctx.harnessSlug);
    let harness: string | null = null;
    if (onlyWorkspaceScope) {
      try {
        const home = await resolveHomePotSlug(workspaceId);
        if (home) harness = resolvePotHomeSlug(home, undefined);
      } catch {
        // Home-pot discovery is a convenience for workspace-scoped callers. If
        // the registry is temporarily unreadable, preserve the older env/ctx
        // fallback and let the existing no_harness response explain the gap.
        harness = null;
      }
    }
    harness ??= resolvePotHomeSlug(args.harness, ctx.harnessSlug);
    if (!harness) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: false,
              error: 'no_harness',
              message:
                'Pass `harness` — your session is not scoped to a harness and no home hive is set, so the loop routine has nowhere to live.',
            }),
          },
        ],
        isError: true,
      };
    }

    // EI-19966210024116714 — a loop armed against a harness its OWN SESSION cannot
    // address is doomed from `armedAt`, and the failure is SILENT for hours. Every
    // harness-scoped call the wake contract prescribes (`coord:orient`,
    // `scheduler:get_next`) is refused by the scoped-superuser dispatch clamp with
    // `harness_forbidden`, so the agent wakes on cadence, errors on every pull, and
    // produces no turn output — until the stalled-loops guard disarms it (WI-6639) and
    // the claim reaper releases its held work-items as `reaper:dead`. Every individual
    // signal reads healthy meanwhile: wakes report `delivered`, `turnsStalled` stays
    // false, `lastRealTurnAt` keeps advancing. The agent looks dead from outside and
    // fine from inside. Observed live 2026-08-08/09 across FOUR fleet members
    // (su-334bd763, su-28297628, su-b5111af0, +1) who armed loops on harness
    // 'papercusp' from sessions scoped to workspace 'default'; one burned 44 wakes over
    // ~8h and lost a held item mid-diagnosis to the reaper.
    //
    // The mismatch is fully determinable HERE, so refuse at arm time rather than let it
    // present as death 8h later. Mirrors the dispatch clamp's semantics EXACTLY
    // (`_mcp-handler.ts` scopedSuperuserClamp + resolveWorkspaceForHarnessSlugIn), so
    // this can only ever refuse an arm that clamp would go on to refuse call-by-call:
    // only a CLAMPED session is checked (an UNSCOPED '*' superuser legitimately spans
    // workspaces), and we fail OPEN on a resolver throw/miss — fail CLOSED only on a
    // CONFIRMED foreign resolution.
    const scopedClamp =
      ctx.isSuperuser === true &&
      workspaceId !== '*' &&
      (await getFlag(FLAGS.SCOPED_SUPERUSER_CLAMP, 'system'));
    if (scopedClamp) {
      let harnessWs: string | null = null;
      try {
        const { resolveWorkspaceForHarnessSlugIn } = await import('../../harness-core');
        harnessWs = await resolveWorkspaceForHarnessSlugIn(workspaceId, harness);
      } catch {
        // Ambiguous cross-workspace collision (resolver throws) or an infra error:
        // fail OPEN — never block a legitimate arm on a read we could not complete.
        harnessWs = null;
      }
      if (harnessWs && harnessWs !== workspaceId) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                ok: false,
                error: 'harness_workspace_mismatch',
                harness,
                harnessWorkspace: harnessWs,
                sessionWorkspace: workspaceId,
                message:
                  `Refusing to arm: harness "${harness}" belongs to workspace "${harnessWs}", but this session is scoped to workspace "${workspaceId}". ` +
                  'Every harness-scoped call this loop would make (coord:orient, scheduler:get_next) would be refused with harness_forbidden, so the ' +
                  'loop would wake on cadence, accomplish nothing, and eventually be auto-disarmed while your held work-items are reaped as dead. ' +
                  'Arm from a session scoped to that workspace (or an unscoped --all-workspaces session), or pass a harness that is in scope.',
              }),
            },
          ],
          isError: true,
        };
      }
    }

    // softText fields (P-002): never bounced on length — clamp to cap here.
    const goal = clampText(args.goal, 4000);
    const wakePrompt = clampText(args.wakePrompt, 4000);

    // EI-19447204017443244 — MEASURE the caller's live push channels before the cap
    // message speaks about them. Gated to the one branch that consumes it (a declared
    // blocker with NO named event): every other arm keeps its exact prior round-trip
    // count, so an advisory message costs nothing on the common path.
    //
    // Best-effort, mirroring the prior-loop read below: this is advisory, so a failure
    // must not fail the arm. The catch yields `unknown` rather than `none` — see
    // LivePushChannels; degrading to "I checked and found nothing" would print a
    // fabricated measurement, which is the defect being fixed here.
    let livePush: LivePushChannels = { status: 'unknown' };
    if (args.blockedOn && !args.blockedOn.event) {
      try {
        const awaits = await listWakeAwaitsForSubscriber(ownerId);
        livePush =
          awaits.length > 0
            ? { status: 'found', count: awaits.length, sample: awaits.slice(0, 2).map((a) => a.eventKey) }
            : { status: 'none' };
      } catch (e) {
        console.warn(
          `[loop:arm] live wake-await lookup failed (cap message will not claim either way): ${e instanceof Error ? e.message : e}`,
        );
      }
    }

    // EI-19395290807657827 — resolve a blocker-motivated interval BEFORE it is threaded
    // into the kickoff / overwrite-note / materializeLoop, so every downstream consumer
    // sees the interval that is actually armed rather than the one that was requested.
    const backoff = resolveBlockedBackoff(args.intervalSec, args.blockedOn ?? null, livePush);
    const intervalSec = backoff.intervalSec;

    // EI-18792078711601844 — read the prior loop this arm is about to UPSERT over
    // BEFORE computing carry, so a re-arm with `carry` omitted can PRESERVE it
    // instead of silently recomputing a fresh default. loop:arm is an upsert keyed
    // on (owner, name): the playbook's own prescribed remedy for a blocked loop —
    // "re-loop:arm with a larger intervalSec" — passes only intervalSec, and before
    // this fix that omission reset carry to whatever resolveDefaultCarry() computes
    // NOW (which can legitimately differ from the loop's actual current carry, e.g.
    // host-discovery flakiness, a flag flip mid-run), silently converting a bounded
    // cold loop into an unbounded warm one. Reused below for the overwrite-note
    // comparison too (was previously fetched twice). Best-effort: a read failure
    // here must not fail the arm — falls back to the pre-fix default-resolution path.
    let prior: PriorLoopFacts | null = null;
    try {
      prior = await readActiveLoopFacts(ownerId);
    } catch (e) {
      console.warn(`[loop:arm] prior-loop read failed (falling back to default carry resolution): ${e instanceof Error ? e.message : e}`);
    }

    // B (cold-with-carry-activation-2026-07-20): an unspecified carry on a FRESH arm
    // (no active prior loop for this owner) RESOLVES a default — 'cold' for an
    // unattended headless session, 'warm' otherwise (see resolveDefaultCarry). An
    // unspecified carry on a RE-ARM of an already-ACTIVE loop instead PRESERVES that
    // loop's current carry (EI-18792078711601844) — a re-arm's whole point is to
    // retune ONE field (usually intervalSec), not to re-decide the lifecycle. An
    // explicit args.carry always wins either way. `carry` from here on is the
    // RESOLVED value, threaded into materializeLoop + the kickoff + response.
    const carryPreservedFromPrior = args.carry == null && Boolean(prior?.active);
    const carry = args.carry ?? (prior?.active ? prior.carry : await resolveDefaultCarry(ownerId));
    const resolvedMode = args.mode ?? 'work';

    // WI-5557 TIER 1 — an unattended warm-carry WORK loop with neither dead-man guard set
    // (maxFires / maxDurationSec) has NOTHING bounding how long it re-wakes the SAME warm
    // session, so context grows every fire until it hits the ceiling and dies uncleanly
    // (repro: session fa10eeb7, 52 fires / 7.3h / 364 turns → death→cold-recycle→warm-regrow
    // cycle the owner called "should never happen"). This is purely additive — a response
    // field + note suffix, no behavior change — so it's safe to land without the TIER 2
    // engine-side hard net (which needs owner disclosure given its fleet-wide blast radius;
    // tracked separately). A 'monitor' loop is excluded: it's a leader/supervisor loop that
    // is, by its own contract, actively watched each wake, not left to silently regrow.
    const unboundedWarmLoopWarning: string | null =
      carry === 'warm' && resolvedMode === 'work' && !args.maxDurationSec && !args.maxFires
        ? 'This is an unattended warm-carry WORK loop with no maxFires/maxDurationSec bound — context carries and grows every fire with nothing to stop it, and an unbounded warm loop can hit the context ceiling and die uncleanly (WI-5557). Consider setting maxFires or maxDurationSec, or self-compacting periodically via session:request-compaction as context grows.'
        : null;

    // WI-2429 fix A — auto-claim the work-item this loop DRIVES, at arm time, so it is
    // HELD from wake 1. Then the per-item work_items:checkpoint death-resilience net
    // engages (a successor/reclaimer inherits the item + its checkpoint if the session
    // dies — the exact WI-2339 silent-halt risk), and the cold-wake prompt can name the
    // item concretely instead of the soft "if you hold a work-item" the cold-auto
    // experiment measured agents ignoring. An explicit `workItem` is honored for ANY
    // carry; goal auto-detect is scoped to COLD loops (the death-resilience scenario) so
    // warm-loop behaviour stays byte-identical unless the arming agent opts in. The claim
    // NEVER steals a live peer's item (claimWorkItem's compare-and-claim only takes an
    // unheld/self-held row), so a conflict/not-found is a non-fatal NOTE, never a failed
    // arm — arming already succeeded; this is best-effort on top.
    const explicit = args.workItem?.trim();
    const drivenCandidate =
      (explicit ? explicit.toUpperCase() : undefined) ??
      (carry === 'cold' ? detectDrivenWorkItemId(goal) ?? undefined : undefined);
    let claimedWorkItem: string | null = null;
    let workItemClaim:
      | { id: string; claimed: true }
      | { id: string; claimed: false; reason: string; holder?: string }
      | null = null;
    if (drivenCandidate) {
      try {
        const wi = await claimWorkItem(drivenCandidate, ownerId, { harness });
        if (wi) {
          claimedWorkItem = drivenCandidate;
          workItemClaim = { id: drivenCandidate, claimed: true };
        } else {
          // claimWorkItem returns a bare null for three outcomes — re-read + classify
          // for an accurate, actionable note (mirrors work_items:claim's claimOne).
          const current = await getWorkItem(drivenCandidate, harness);
          const failure = classifyClaimFailure(current, ownerId);
          workItemClaim =
            failure.reason === 'conflict'
              ? { id: drivenCandidate, claimed: false, reason: 'claim_conflict', holder: failure.holder }
              : failure.reason === 'not_found'
                ? { id: drivenCandidate, claimed: false, reason: 'not_found' }
                : { id: drivenCandidate, claimed: false, reason: 'not_claimable' };
        }
      } catch (e) {
        workItemClaim = {
          id: drivenCandidate,
          claimed: false,
          reason: `error: ${e instanceof Error ? e.message : String(e)}`,
        };
      }
    }

    const baseKickoff =
      wakePrompt ??
      buildLoopWakePrompt({
        ownerId,
        intervalSec,
        harness,
        goal,
        carry,
        continuation: args.continuation ?? 'settle',
        mode: resolvedMode,
        // Only name the item in the wake prompt if we ACTUALLY hold it — a conflicted /
        // not-found candidate must not tell the agent "you hold X".
        workItem: claimedWorkItem,
      });

    // EI-19395290807657827 — PREPEND the backoff premise to the kickoff. This is what makes
    // the fix work rather than merely advise: the arming agent goes to sleep and can never
    // re-read this tool's RESPONSE, but the kickoff is re-delivered on EVERY wake. Putting
    // the premise first means the next wake re-checks the specific condition the interval
    // was chosen under, instead of silently inheriting it for the rest of the loop's life.
    // Applies to a custom wakePrompt too — the trap is orthogonal to how the wake reads.
    const kickoff = backoff.wakePremise
      ? `⏸ BACKOFF PREMISE — RE-CHECK THIS BEFORE ANYTHING ELSE:\n${backoff.wakePremise}\n\n${baseKickoff}`
      : baseKickoff;

    // EI-18221784742583615 — arm-time overwrite guard. Using `prior` (read above, before
    // materializeLoop overwrites it) — if the re-arm materially changes an ACTIVE loop's
    // goal, surface the prior config for comparison so the arming agent sees what it is
    // replacing instead of clobbering a specialized loop blind (the stale/replayed-kickoff
    // scenario). Best-effort + purely advisory: a compute failure never fails the arm, and
    // the loop is still (re-)armed regardless — "surface, don't silently overwrite" per the
    // filed bug, not a hard refusal.
    let overwriteNote: LoopOverwriteNote | null = null;
    try {
      overwriteNote = computeLoopOverwriteNote(prior, { goal, intervalSec: intervalSec, kickoff });
    } catch (e) {
      console.warn(
        `[loop:arm] overwrite-note compute failed (loop still armed): ${e instanceof Error ? e.message : e}`,
      );
    }

    const loop = await materializeLoop({
      workspaceId,
      harnessSlug: harness,
      ownerId,
      intervalSec: intervalSec,
      kickoff,
      // EI-20072281215342526: persist the goal STRUCTURALLY, not only rendered into
      // `kickoff`. A carry-respawn never renders a kickoff, so this is the copy that
      // reaches a successor (via loop:status and the carry document).
      goal,
      costCapCents: args.costCapCents ?? null,
      maxFires: args.maxFires ?? null,
      maxDurationSec: args.maxDurationSec ?? null,
      carry,
      continuation: args.continuation ?? 'settle',
      mode: resolvedMode,
    });
    const control = await refreshControlAnchorAfterMutation({
      ownerId,
      workspaceId,
      origin: 'agent',
      actorId: identity.ownerId,
      source: 'loop:arm',
    });

    // WI-655 — wake-reachability is INTRINSIC to arming a loop, not a separate step.
    // (1) ARM the standing inbox-wake watch right here, so a loop is wakeable the instant
    // it is armed — independent of the SessionStart re-arm a RESUMED/curl-driven session
    // never re-runs (the exact decoupling that black-holed fires as `no-session-now`).
    // (2) VERIFY it: probe which wake-executor channel a fire WOULD take, and if the
    // session can't receive a wake as a fresh turn, return a LOUD warning rather than a
    // silent success. Fail-soft — arming the loop already succeeded; this leg is the
    // honest reachability read on top.
    let reachability: WakeReachabilityVerdict | null = null;
    try {
      await armInboxWake({ ownerId, workspaceId, note: `loop-armed inbox-wake (${loop.name})` });
      reachability = await probeWakeReachability(ownerId);
    } catch (e) {
      console.warn(`[loop:arm] reachability arm/probe failed (loop still armed): ${e instanceof Error ? e.message : e}`);
    }

    const reachabilityOut = reachability
      ? {
          reachable: reachability.reachable,
          channel: reachability.channel,
          durableWhileAlive: reachability.durableWhileAlive,
          summary: reachability.summary,
          ...(reachability.warning ? { warning: reachability.warning } : {}),
        }
      : null;

    const baseNote =
      reachability && !reachability.reachable
        ? `⚠ Armed, but NOT wake-reachable: ${reachability.warning ?? reachability.summary} The loop row exists, but fires will NOT reach you as a fresh turn until this is fixed (re-arm from a managed/console/psu-hosted session). loop:status shows live reachability; loop:end stops it.`
        : reachability && reachability.warning
          ? `Armed (wake path: ${reachability.channel}). ⚠ ${reachability.warning} End your turn — the engine re-wakes ~${intervalSec}s after each turn settles. Stop with loop:end.`
          : `Armed (wake path: ${reachability?.channel ?? 'unverified'}). End your turn — the engine will re-wake this session ~${intervalSec}s after each turn settles. Stop anytime with loop:end.`;

    // WI-2429 fix A — surface the auto-claim outcome so the arming agent sees it took (or
    // why it didn't). A conflict/not-found never fails the arm; it's an advisory tail.
    const claimNote = workItemClaim
      ? workItemClaim.claimed
        ? ` 📌 Auto-claimed work-item ${workItemClaim.id} for this loop — held from wake 1; refresh its work_items:checkpoint each wake (your death-resilience anchor: a successor inherits it if this session dies).`
        : workItemClaim.reason === 'claim_conflict'
          ? ` ⚠ Did NOT auto-claim ${workItemClaim.id} — already held by ${workItemClaim.holder}. Coordinate with them (coord:send); the loop is armed regardless.`
          : ` ⚠ Did NOT auto-claim ${workItemClaim.id} (${workItemClaim.reason}); the loop is armed regardless — claim it yourself if this loop drives it.`
      : '';
    // EI-18221784742583615: put the overwrite comparison right after the base note so it
    // is the FIRST thing the arming agent reads — ahead of the claim/warm/cold tails.
    const overwriteNoteText = overwriteNote ? ` ⚠ ${overwriteNote.message}` : '';
    // EI-19395290807657827 — the backoff disclosure. Sits with the other advisory tails,
    // but says something the agent CANNOT infer from the echoed interval alone: whether it
    // was capped, and (when an event was named) that naming it is not the same as parking
    // on it. A silently-capped interval would be worse than no cap at all.
    const backoffNote = backoff.note ? ` ${backoff.note}` : '';
    const warningNote = unboundedWarmLoopWarning ? ` ⚠ ${unboundedWarmLoopWarning}` : '';
    // B (cold-with-carry-activation-2026-07-20): disclose when the headless default
    // kicked in, so the arming agent knows its loop will go COLD (transcript reset to
    // the carry-note each wake) and must keep loop:checkpoint fresh — and how to
    // override if it wants warm. EI-18792078711601844: a RE-ARM that PRESERVED the
    // prior loop's carry (rather than recomputing a fresh default) gets its own,
    // distinct disclosure — "defaulted" would misstate what happened, and this is
    // exactly the surfacing the filed bug's "minimum viable" fix asked for (carry
    // shown prominently on re-arm so an omission is never silent).
    const coldDefaultNote =
      carryPreservedFromPrior
        ? ` (carry '${carry}' PRESERVED from the loop's prior config — pass carry explicitly to change it.)`
        : args.carry == null && carry === 'cold'
          ? ' ❄️ Defaulted to COLD carry (headless/unattended): each wake RESETS this session to its carry-note instead of re-waking warm, so keep loop:checkpoint { did, left, insight, next } fresh every wake. Pass carry:"warm" to override.'
          : '';
    // EI-19326580626849271 — invert the monitor-loop default toward PUSH.
    //
    // P-009 shipped fleet-transition events so a leader could react to pushes
    // instead of polling, and adoption was ~zero: 1 deliberate await in 48h
    // across 310 agents, while gate events (release:*, green-checkpoint:*) got
    // 66 across 11 agents. The mechanism was never the problem — the keys are
    // catalogued and events:await works. The problem is that nothing offers
    // them at the one moment a leader decides HOW to watch, and this tool's
    // own notWhen actively wrote events:await off as "one-off wakes".
    //
    // mode:'monitor' IS that moment, declared by the caller: a loop that
    // WATCHES rather than works. So name the push path here, with real keys.
    // Deliberately a runtime note rather than more guidance prose: it costs no
    // prompt weight, fires only for monitor loops, and arrives with the keys
    // already spelled out — static guidance is read before the decision, this
    // is read during it. The clock loop stays armed either way; this argues
    // for demoting it to a backstop, never refuses it.
    const monitorPushNote =
      args.mode === 'monitor'
        ? ' 📡 Monitor loop armed — but prefer PUSH wherever the thing you are watching already emits. A fleet leader can park on fleet:member-dead · fleet:claim-released · fleet:item-completed · fleet:context-critical via events:await { event, timeout_sec, on_timeout:"wake" }, which wakes you ON the transition instead of N times between transitions. Keep THIS loop as the slow backstop (a longer intervalSec) rather than the primary watcher. events:catalog lists the full set.'
        : '';
    const note =
      baseNote + overwriteNoteText + backoffNote + claimNote + warningNote + coldDefaultNote + monitorPushNote;

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            loop: {
              name: loop.name,
              ownerId,
              ownerLabel,
              harness,
              intervalSec,
              // EI-19395290807657827 — report the REQUESTED interval alongside the armed
              // one whenever they differ, so a capped backoff is legible in the structured
              // result and not only in the prose note.
              requestedIntervalSec: backoff.clamped ? args.intervalSec : undefined,
              blockedOn: args.blockedOn
                ? {
                    reason: args.blockedOn.reason,
                    event: args.blockedOn.event ?? null,
                    intervalCapped: backoff.clamped,
                  }
                : null,
              goal,
              carry,
              continuation: args.continuation ?? 'settle',
              mode: resolvedMode,
              costCapCents: args.costCapCents ?? null,
              // EI-6878: a re-arm of an ALREADY-armed loop called from WITHIN its own
              // in-flight turn returns the loop's row PARKED at the 'infinity' sentinel
              // (see routines-runtime.ts's upsertRoutine — parking must survive a re-arm
              // so the completion-rebase can still find it). Render that as the literal
              // string below rather than the raw sentinel's ISO date (+275760-09-13),
              // which reads to a caller as "this loop will never fire".
              firstFireAt: !loop.nextFireAt
                ? null
                : isParkedNextFire(loop.nextFireAt)
                  ? 'after-turn-settle'
                  : loop.nextFireAt.toISOString(),
              customWakePrompt: wakePrompt != null,
              workItem: claimedWorkItem,
              controlGeneration: control?.generation ?? null,
            },
            workItemClaim,
            reachability: reachabilityOut,
            unboundedWarmLoopWarning,
            priorLoopOverwrite: overwriteNote,
            note,
          }),
        },
      ],
    };
  },
});
