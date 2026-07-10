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
import { isParkedNextFire } from '@papercusp/db-org';
import {
  materializeLoop,
  buildLoopWakePrompt,
  detectDrivenWorkItemId,
  LOOP_INTERVAL_FLOOR_SEC,
} from '../../harness/routines/loop';
import { claimWorkItem, classifyClaimFailure, getWorkItem } from '../../work-items';
import { armInboxWake } from '../../events/await/inbox-wake-arm';
import {
  probeWakeReachability,
  type WakeReachabilityVerdict,
} from '../../events/await/wake-reachability';
import { softText, clampText } from '../limits';

const MAX_LOOP_INTERVAL_SEC = 60 * 60 * 24 * 7; // 7 days — beyond this, use a schedule (a fixed clock), not a loop

/** Cosmetic short form for an overridden owner id (display only, never keyed
 *  on) — mirrors resolveAgentIdentity's own `shortId` formatting so an
 *  ownerId-override loop's label reads the same as a self-armed one. */
function shortOwnerLabel(id: string): string {
  if (id.startsWith('pus-')) return id.slice(0, 12);
  return id.length > 8 ? id.slice(0, 8) : id;
}

export default defineTool({
  name: 'loop:arm',
  profile: 'engineer',
  description:
    'Arm the tracked engine loop for your session (or another ownerId) — the durable replacement for Claude /loop. Each fire re-wakes that warm session after its prior turn settles; context carries across iterations. Observable via loop:status / fleet:assignments and stoppable with loop:end.',
  guidance: {
    when: 'Use for an su/interactive session that should keep advancing a goal on a recurring cadence. Arm it last before ending your turn. Pass ownerId only to arm an already-running, wake-reachable session other than your own.',
    notWhen:
      'Not for wall-clock schedules (plans:set-schedule), one-off wakes (events:await), or autonomous queen/bee/scout loops (pot:declare-wake / kettle:declare-wake). Do not use Claude /loop instead.',
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
    goal: softText(4000, { min: 1 })
      .describe('One line: what this loop is working toward — echoed into every wake. Auto-truncated to 4000 chars if longer.'),
    harness: z
      .string()
      .max(120)
      .optional()
      .describe('Harness the loop is scoped to / namespaced under (default: your session harness).'),
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
        "Loop lifecycle (su-cold-auto-mode-2026-07-03, D-001 opt-in). 'warm' (DEFAULT) = today's behaviour — each fire re-wakes THIS same warm session in place, context carried. 'cold' = the opt-in fresh-context lifecycle for an UNATTENDED AUTO loop: each fire RESETs the session to its carry-note (a periodic RECYCLE every Nth wake) instead of a warm turn, so the transcript never grows unbounded. Cold requires a carry-note anchor and stays inert until the cold-auto master gate is enabled (Phase 3). NEVER use 'cold' for an interactive/human-present session (D-005).",
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
      .describe('Dead-man guard: auto-pause the loop after this many total wake fires (a bound on a runaway loop).'),
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
    const harness = resolvePotHomeSlug(args.harness, ctx.harnessSlug);
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

    // softText fields (P-002): never bounced on length — clamp to cap here.
    const goal = clampText(args.goal, 4000);
    const wakePrompt = clampText(args.wakePrompt, 4000);
    const carry = args.carry ?? 'warm';

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

    const kickoff =
      wakePrompt ??
      buildLoopWakePrompt({
        ownerId,
        intervalSec: args.intervalSec,
        harness,
        goal,
        carry,
        continuation: args.continuation ?? 'settle',
        mode: args.mode ?? 'work',
        // Only name the item in the wake prompt if we ACTUALLY hold it — a conflicted /
        // not-found candidate must not tell the agent "you hold X".
        workItem: claimedWorkItem,
      });

    const loop = await materializeLoop({
      workspaceId,
      harnessSlug: harness,
      ownerId,
      intervalSec: args.intervalSec,
      kickoff,
      costCapCents: args.costCapCents ?? null,
      maxFires: args.maxFires ?? null,
      maxDurationSec: args.maxDurationSec ?? null,
      carry: args.carry ?? 'warm',
      continuation: args.continuation ?? 'settle',
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
          ? `Armed (wake path: ${reachability.channel}). ⚠ ${reachability.warning} End your turn — the engine re-wakes ~${args.intervalSec}s after each turn settles. Stop with loop:end.`
          : `Armed (wake path: ${reachability?.channel ?? 'unverified'}). End your turn — the engine will re-wake this session ~${args.intervalSec}s after each turn settles. Stop anytime with loop:end.`;

    // WI-2429 fix A — surface the auto-claim outcome so the arming agent sees it took (or
    // why it didn't). A conflict/not-found never fails the arm; it's an advisory tail.
    const claimNote = workItemClaim
      ? workItemClaim.claimed
        ? ` 📌 Auto-claimed work-item ${workItemClaim.id} for this loop — held from wake 1; refresh its work_items:checkpoint each wake (your death-resilience anchor: a successor inherits it if this session dies).`
        : workItemClaim.reason === 'claim_conflict'
          ? ` ⚠ Did NOT auto-claim ${workItemClaim.id} — already held by ${workItemClaim.holder}. Coordinate with them (coord:send); the loop is armed regardless.`
          : ` ⚠ Did NOT auto-claim ${workItemClaim.id} (${workItemClaim.reason}); the loop is armed regardless — claim it yourself if this loop drives it.`
      : '';
    const note = baseNote + claimNote;

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
              intervalSec: args.intervalSec,
              goal,
              carry: args.carry ?? 'warm',
              continuation: args.continuation ?? 'settle',
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
            },
            workItemClaim,
            reachability: reachabilityOut,
            note,
          }),
        },
      ],
    };
  },
});
