/**
 * hive:declare-wake — the Hive operator declares its own next wake before ending
 * a turn (autoloop-hive-operator-rebuild-2026-06-05 P0, D-002). REPLACE
 * semantics like coord:declare-intent: each call describes the WHOLE wake —
 * a time (`at` | `inSeconds`), event subscriptions (`events`), both, or
 * nothing (`mode:'none'`/all omitted). Omitted parts are cleared.
 *
 * The time wake is durable (a one-shot `hive-wake` routine row fired by the
 * DBOS routinesTick → system:blueprint-run → the hive launch blueprint); event
 * wakes are persisted subscriptions projected into live event-reaction rules
 * that fire `hive:wake`. A wake floor clamps the time (≥ now+floor) so a
 * confused operator can't spin.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import type { DataCondition } from '@papercusp/rules';
import { getOrgPg } from '@papercusp/db-org';
import { COORD_ROLES } from '../coordination/roles';
import { activeWorkspaceId } from '../../workspace-registry';
import {
  clearHiveTimeWake,
  declareHiveTimeWake,
  hiveWakeFloorSec,
  resolveHiveHomeSlug,
  setHiveEventSubscriptions,
  type HiveEventSubscription,
} from '../../hive/wake';

const subscriptionSchema = z.object({
  on: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]).describe(
    'Trigger tool name(s) to wake on, e.g. "coord:escalate".',
  ),
  when: z
    .record(z.string(), z.unknown())
    .optional()
    .describe('Optional declarative condition (a @papercusp/rules DataCondition over {args,result,ctx}).'),
  note: z.string().max(300).optional().describe('Why you subscribed — shown in hive:status.'),
});

export default defineTool({
  name: 'hive:declare-wake',
  profile: 'engineer',
  description:
    "Declare the Hive operator's next wake (REPLACE semantics — omitted parts are cleared): a time (`at` ISO / `inSeconds`), event subscriptions (`events: [{on, when?, note?}]`), both, or nothing (`mode:'none'`). The time is clamped to a wake floor; event wakes fire hive:wake when the subscribed tool-event matches.",
  guidance: {
    when: 'You are the hive/operator ending a turn — ALWAYS declare your next wake (a time, events, or explicitly none). Also when the user asks to schedule or re-schedule the operator.',
    notWhen: 'To fire the hive right now — that is hive:wake.',
    chaining: 'hive:status to inspect the current declaration; hive:wake for an immediate manual fire.',
  },
  capability: 'routines:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z
    .object({
      at: z.string().datetime({ offset: true }).optional().describe('Absolute wake time (ISO 8601).'),
      inSeconds: z.number().positive().max(60 * 60 * 24 * 30).optional().describe('Relative wake time in seconds from now.'),
      events: z.array(subscriptionSchema).max(20).optional().describe('Event-wake subscriptions (replaces the current set; omit to clear).'),
      mode: z.literal('none').optional().describe("Explicit 'nothing' — sleep until the user or a manual hive:wake."),
      harness: z.string().max(120).optional().describe('Home harness slug the wake fires against (default: ctx harness or PAPERCUSP_HIVE_HOME_SLUG).'),
      kickoff: z.string().max(2000).optional().describe('Kickoff text the woken operator reads (why this wake exists).'),
    })
    .refine((a) => !(a.at != null && a.inSeconds != null), { message: 'pass either at or inSeconds, not both' })
    .refine((a) => !(a.mode === 'none' && (a.at != null || a.inSeconds != null || (a.events?.length ?? 0) > 0)), {
      message: "mode:'none' cannot be combined with a time or events",
    }),
  async handler(args, ctx) {
    const workspaceId = ctx.workspaceId ?? ctx.principal?.workspaceId ?? activeWorkspaceId();
    const installSlug = resolveHiveHomeSlug(args.harness, ctx.harnessSlug);
    if (!installSlug) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: false,
              error: 'no_home_harness',
              message: 'Pass `harness` (or set PAPERCUSP_HIVE_HOME_SLUG) — the wake routine is harness-scoped.',
            }),
          },
        ],
      };
    }
    const { sql } = getOrgPg();

    const wantsTime = args.at != null || args.inSeconds != null;
    let time: { at: string; clamped: boolean } | null = null;
    if (wantsTime) {
      const requested = args.at != null ? new Date(args.at) : new Date(Date.now() + (args.inSeconds as number) * 1_000);
      const r = await declareHiveTimeWake(sql, { workspaceId, installSlug, at: requested, kickoff: args.kickoff });
      time = { at: r.at.toISOString(), clamped: r.clamped };
    } else {
      await clearHiveTimeWake(sql, installSlug);
    }

    const subs: HiveEventSubscription[] = (args.events ?? []).map((s) => ({
      on: s.on,
      when: s.when as DataCondition | undefined,
      note: s.note,
    }));
    const eventRules = await setHiveEventSubscriptions(workspaceId, subs);

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            harness: installSlug,
            time,
            eventRules,
            floorSec: hiveWakeFloorSec(),
            mode: time && eventRules > 0 ? 'time+event' : time ? 'time' : eventRules > 0 ? 'event' : 'none',
          }),
        },
      ],
    };
  },
});
