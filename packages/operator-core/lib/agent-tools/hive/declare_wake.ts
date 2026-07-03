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
import { FLAGS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';
import { COORD_ROLES } from '../coordination/roles';
import { activeWorkspaceId } from '../../workspace-registry';
import {
  clearHiveTimeWake,
  declareHiveTimeWake,
  hiveWakeFloorSec,
  resolveHiveHomeSlug,
  setHiveCarryNote,
  setHiveEventSubscriptions,
  type HiveEventSubscription,
} from '../../hive/wake';
import {
  evaluateWakeFrontierGuard,
  listUnplacedHiveFrontier,
  listNonTerminalPlacements,
} from '../../hive/wake-frontier-guard';
import { getHiveStarted } from '../../hive/started';
import { getOwnerSteering, isPausedNow } from '../../owner-steering';
import { softText, clampText, LIMITS } from '../limits';

const subscriptionSchema = z.object({
  on: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]).describe(
    'Trigger tool name(s) to wake on, e.g. "coord:escalate".',
  ),
  when: z
    .record(z.string(), z.unknown())
    .optional()
    .describe('Optional declarative condition (a @papercusp/rules DataCondition over {args,result,ctx}).'),
  note: softText(LIMITS.ANNOTATION).optional().describe('Why you subscribed — shown in hive:status. Auto-truncated to 2000 chars if longer.'),
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
    seeAlso: [
      'hive:status (inspect the current wake declaration)',
      'hive:wake (fire an immediate manual wake instead of scheduling)',
    ],
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
      kickoff: softText(LIMITS.ANNOTATION).optional().describe('Kickoff text the woken operator reads (why this wake exists). Auto-truncated to 2000 chars if longer.'),
      remember: z
        .string()
        .optional()
        .describe(
          "Your CARRY-NOTE for next wake — what future-you needs to continue (in-flight intention, a tentative conclusion, a revisit-trigger). REPLACE-semantics: omit to carry nothing (next wake re-derives from the floor). Do NOT restate the deterministic floor (frontier/bees/inbox — that's recomputed) or dump the transcript; longer notes cost uncached tail tokens every wake, so carry only what matters.",
        ),
      force: z
        .boolean()
        .optional()
        .describe(
          'Override the frontier guard (EI-309): declare an event-only/none wake even though the home harness has unplaced todo work items. Only set this when you deliberately intend to leave them unplaced.',
        ),
    })
    .refine((a) => !(a.at != null && a.inSeconds != null), { message: 'pass either at or inSeconds, not both' })
    .refine((a) => !(a.mode === 'none' && (a.at != null || a.inSeconds != null || (a.events?.length ?? 0) > 0)), {
      message: "mode:'none' cannot be combined with a time or events",
    }),
  async handler(args, ctx) {
    const workspaceId = ctx.workspaceId ?? ctx.principal?.workspaceId ?? activeWorkspaceId();
    const installSlug = resolveHiveHomeSlug(args.harness, undefined);
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

    // WI-2012 (owner directive 2026-07-03): no started hives ⇒ the queen STAYS paused.
    // hive:pause clears the pending time wake, but an IN-FLIGHT queen turn used to
    // re-arm it right back through this tool — the self-perpetuating wake loop that
    // kept a "paused" queen burning orient/survey churn for hours. When the queen
    // loop is not started, refuse to arm anything; hive:start is the resume (it sets
    // started=true BEFORE arming, so this gate can never strand resumption).
    if (!(await getHiveStarted(workspaceId, installSlug))) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: false,
              error: 'hive_paused',
              message:
                'The queen loop is PAUSED (hive_started=false) — not arming a wake. End your turn cleanly; hive:start resumes autonomous wakes.',
            }),
          },
        ],
      };
    }

    const wantsTime = args.at != null || args.inSeconds != null;

    // EI-309 frontier guard + P-030 drive-to-empty: refuse a no-time-component wake
    // (event-only / none) while the Queen still has work a no-time wake would
    // strand — unplaced todo work in the home harness, OR non-terminal placements
    // she must drive to completion. Runs BEFORE any mutation so a refused
    // declaration doesn't partially apply. Flag-gated; force overrides.
    if (!wantsTime && !args.force && (await getFlag(FLAGS.HIVE_WAKE_FRONTIER_GUARD, 'system'))) {
      // queen-steering-panel B-03: when the owner has PAUSED new work (owner-steering
      // C-1), the Queen is legitimately leaving the unplaced frontier alone — suppress
      // the frontier leg so she can declare an idle/event-only wake. The drive-to-
      // terminal leg (openPlacements) STILL applies: she must keep a cadence to finish
      // in-flight work. Fail-soft: an unreadable steering store ⇒ the full guard.
      const paused = await getOwnerSteering(workspaceId, installSlug, sql)
        .then((s) => isPausedNow(s, Date.now()))
        .catch(() => false);
      const [frontierIdsRaw, openPlacementIds] = await Promise.all([
        listUnplacedHiveFrontier(sql, workspaceId, installSlug),
        listNonTerminalPlacements(sql, workspaceId, installSlug),
      ]);
      const frontierIds = paused ? [] : frontierIdsRaw;
      const refusal = evaluateWakeFrontierGuard({ hasTimeWake: false, frontierIds, openPlacementIds });
      if (refusal) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, ...refusal }) }],
        };
      }
    }

    let time: { at: string; clamped: boolean } | null = null;
    if (wantsTime) {
      const requested = args.at != null ? new Date(args.at) : new Date(Date.now() + (args.inSeconds as number) * 1_000);
      const r = await declareHiveTimeWake(sql, { workspaceId, installSlug, at: requested, kickoff: clampText(args.kickoff, LIMITS.ANNOTATION) });
      time = { at: r.at.toISOString(), clamped: r.clamped };
    } else {
      // K1 (workspace-scoped-coordination P-003): thread the workspace so a clear
      // targets the sentinel wake routine when the flag is ON (OFF ⇒ per-hive).
      await clearHiveTimeWake(sql, installSlug, { workspaceId });
    }

    const subs: HiveEventSubscription[] = (args.events ?? []).map((s) => ({
      on: s.on,
      when: s.when as DataCondition | undefined,
      note: clampText(s.note, LIMITS.ANNOTATION),
    }));
    const eventRules = await setHiveEventSubscriptions(workspaceId, subs);

    // Carry-note (P-015 / B-04): REPLACE-semantics — store the note for the next
    // wake's brief tail, or clear it when omitted (re-derive from the floor).
    const carryNote = await setHiveCarryNote(workspaceId, args.remember);

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            harness: installSlug,
            time,
            eventRules,
            carryNote: carryNote ? { set: true, chars: carryNote.length } : { set: false },
            floorSec: hiveWakeFloorSec(),
            mode: time && eventRules > 0 ? 'time+event' : time ? 'time' : eventRules > 0 ? 'event' : 'none',
          }),
        },
      ],
    };
  },
});
