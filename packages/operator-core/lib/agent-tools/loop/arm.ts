/**
 * loop:arm — arm an engine-managed LOOP on your OWN session: the tracked,
 * restart-surviving, observable replacement for Claude Code's built-in `/loop`
 * for su/interactive agents (loop-routines-interval-recurrence-2026-06-20,
 * B-LOOP-5 / P-008).
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
 * which is a SEPARATE system (hive:declare-wake / overwatch:declare-wake) and is
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
import { resolveHiveHomeSlug } from '../../hive/wake';
import {
  materializeLoop,
  buildLoopWakePrompt,
  LOOP_INTERVAL_FLOOR_SEC,
} from '../../harness/routines/loop';
import { armInboxWake } from '../../events/await/inbox-wake-arm';
import {
  probeWakeReachability,
  type WakeReachabilityVerdict,
} from '../../events/await/wake-reachability';

const MAX_LOOP_INTERVAL_SEC = 60 * 60 * 24 * 7; // 7 days — beyond this, use a schedule (a fixed clock), not a loop

export default defineTool({
  name: 'loop:arm',
  profile: 'engineer',
  description:
    "Arm an engine-managed LOOP on your own session — the tracked replacement for Claude /loop. Each fire re-wakes THIS warm session ~intervalSec after your previous turn SETTLES (a warm coord wake, not a fresh run), so your context carries across iterations. The loop survives restarts, is observable (loop:status / fleet:assignments / fire-history), and inherits guardrails (failure-streak fire-gate + an optional cost-cap). End it with loop:end.",
  guidance: {
    when: 'You (an su/interactive agent working directly with a user) agree to "put this on a loop" — keep advancing a plan/goal WARM on a recurring cadence. Arm it as the LAST thing before you end your turn.',
    notWhen:
      "Wall-clock recurrence (a fixed time each day) — that is a SCHEDULE (plans:set-schedule). A single future wake — events:await / a one-shot. The autonomous queen/bee/scout loop — that is its OWN system (hive:declare-wake / overwatch:declare-wake); never loop:arm from an autonomous-fleet agent. Do NOT self-pace with Claude's native /loop — declare an engine loop here instead (it is tracked + pauseable).",
    chaining:
      'loop:arm { intervalSec, goal, costCapCents? } → end your turn → the engine re-wakes you each iteration with the wakeup prompt (create + self-assign your work_items, work them, set_state) → loop:end to stop. loop:status to inspect.',
  },
  capability: 'routines:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    intervalSec: z
      .number()
      .int()
      .min(LOOP_INTERVAL_FLOOR_SEC)
      .max(MAX_LOOP_INTERVAL_SEC)
      .describe(
        'Seconds AFTER each turn settles before the next wake (≥60). The true period is interval + up-to-30s (the turn-settle is observed on the 30s reconcile tick), so sub-minute is not supported.',
      ),
    goal: z
      .string()
      .min(1)
      .max(500)
      .describe('One line: what this loop is working toward — echoed into every wake.'),
    harness: z
      .string()
      .max(120)
      .optional()
      .describe('Harness the loop is scoped to / namespaced under (default: your session harness).'),
    wakePrompt: z
      .string()
      .max(4000)
      .optional()
      .describe(
        'Advanced: a custom per-wake instruction, replacing the default "create + self-assign your work_items, work them, set_state" template. Most loops should omit this.',
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
    const ownerId = identity.ownerId;
    const workspaceId = ctx.workspaceId ?? ctx.principal?.workspaceId ?? activeWorkspaceId();
    // No `?? ''` collapse — keep the unresolved case nullish so the guard below catches
    // it and fails loud (a routine with an empty harness namespace would collide across
    // hives). workspace-data-isolation-leaks P-003.
    const harness =
      args.harness ?? ctx.harnessSlug ?? resolveHiveHomeSlug(undefined, undefined);
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

    const kickoff =
      args.wakePrompt ??
      buildLoopWakePrompt({ ownerId, intervalSec: args.intervalSec, harness, goal: args.goal });

    const loop = await materializeLoop({
      workspaceId,
      harnessSlug: harness,
      ownerId,
      intervalSec: args.intervalSec,
      kickoff,
      costCapCents: args.costCapCents ?? null,
      maxFires: args.maxFires ?? null,
      maxDurationSec: args.maxDurationSec ?? null,
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

    const note =
      reachability && !reachability.reachable
        ? `⚠ Armed, but NOT wake-reachable: ${reachability.warning ?? reachability.summary} The loop row exists, but fires will NOT reach you as a fresh turn until this is fixed (re-arm from a managed/console/psu-hosted session). loop:status shows live reachability; loop:end stops it.`
        : reachability && reachability.warning
          ? `Armed (wake path: ${reachability.channel}). ⚠ ${reachability.warning} End your turn — the engine re-wakes ~${args.intervalSec}s after each turn settles. Stop with loop:end.`
          : `Armed (wake path: ${reachability?.channel ?? 'unverified'}). End your turn — the engine will re-wake this session ~${args.intervalSec}s after each turn settles. Stop anytime with loop:end.`;

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            loop: {
              name: loop.name,
              ownerId,
              ownerLabel: identity.ownerLabel,
              harness,
              intervalSec: args.intervalSec,
              goal: args.goal,
              costCapCents: args.costCapCents ?? null,
              firstFireAt: loop.nextFireAt ? loop.nextFireAt.toISOString() : null,
              customWakePrompt: args.wakePrompt != null,
            },
            reachability: reachabilityOut,
            note,
          }),
        },
      ],
    };
  },
});
