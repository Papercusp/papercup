/**
 * overwatch:declare-wake — the overwatch declares its OWN next wake before ending a
 * turn (overwatch-role-2026-06-15 B-04, the declare-next-wake half of C-3).
 *
 * The overwatch is a fresh-per-wake autonomous loop (overwatch.md): each turn it
 * surveys system health, nudges/observes/escalates, then declares when to wake
 * next — SHORT (60–180s) while a drift is unresolved, LONGER (10–30 min) when the
 * system is calm. This is its declared-wake scheduler.
 *
 * It is deliberately a SEPARATE verb from the Queen's `hive:declare-wake` (which
 * writes the `hive-wake` channel) so the two wake channels never collide — and so
 * the overwatch CANNOT touch the Queen's schedule. The Queen's verb is gated on
 * `routines:write` (which the overwatch role does NOT hold, by design — D-001/B-01);
 * this verb is gated on `coord:write` (which the overwatch DOES hold, as part of its
 * coordination/control loop), so granting the overwatch its own declare-wake does
 * NOT also unlock the Queen's. Both call the SAME underlying `declareOverwatchTimeWake`
 * primitive (liveness.ts) the B-09 watchdog re-arms through.
 *
 * REPLACE semantics like hive:declare-wake / coord:declare-intent: each call sets
 * the WHOLE next wake — a time (`at` | `inSeconds`), the configured cadence default
 * (no time given), or `mode:'none'` (sleep until the owner or an immediate wake).
 * A wake floor clamps the time (≥ now+floor) so a confused overwatch can't spin.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { COORD_ROLES } from '../coordination/roles';
import { activeWorkspaceId } from '../../workspace-registry';
import { resolveHiveHomeSlug } from '../../hive/wake';
import { getOrgPg } from '@papercusp/db-org';
import {
  declareOverwatchTimeWake,
  clearOverwatchTimeWake,
  overwatchWakeFloorSec,
} from '../../overwatch/liveness';
import { getOverwatchCadenceSec } from '../../overwatch/control-state';

export default defineTool({
  name: 'overwatch:declare-wake',
  profile: 'engineer',
  description:
    "Declare the overwatch's next wake (REPLACE semantics): a time (`at` ISO / `inSeconds`), the configured cadence (no time given), or nothing (`mode:'none'` — sleep until the owner). Clamped to a wake floor. The overwatch's OWN channel — distinct from the Queen's hive:declare-wake; ALWAYS call this before ending a turn.",
  guidance: {
    when: 'You are the overwatch ending a turn — ALWAYS declare your next wake. Use a SHORT inSeconds (60–180) while a drift is unresolved (verify the nudge landed), a LONGER one (600–1800) when the system is calm. Omit the time to use the configured cadence.',
    notWhen:
      "To schedule the Queen / colony — that is hive:declare-wake (a different channel you cannot and must not touch). To wake right now — the owner's overwatch:start does that.",
    chaining: 'Follows your nudges/observations for the turn; this is the last loop step before your end-of-turn verb.',
  },
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z
    .object({
      at: z.string().datetime({ offset: true }).optional().describe('Absolute wake time (ISO 8601).'),
      inSeconds: z
        .number()
        .positive()
        .max(60 * 60 * 24 * 30)
        .optional()
        .describe('Relative wake time in seconds from now (60–180 while watching a drift; 600–1800 when calm).'),
      mode: z.literal('none').optional().describe("Explicit 'nothing' — sleep until the owner restarts you (clears any pending wake)."),
      harness: z
        .string()
        .max(120)
        .optional()
        .describe('Hive home-harness slug the wake fires against (default: ctx harness or PAPERCUSP_HIVE_HOME_SLUG).'),
      kickoff: z.string().max(2000).optional().describe('Kickoff text future-you reads (why this wake exists).'),
    })
    .refine((a) => !(a.at != null && a.inSeconds != null), { message: 'pass either at or inSeconds, not both' })
    .refine((a) => !(a.mode === 'none' && (a.at != null || a.inSeconds != null)), {
      message: "mode:'none' cannot be combined with a time",
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
              message: 'Pass `harness` (or set PAPERCUSP_HIVE_HOME_SLUG) — the overwatch wake routine is harness-scoped.',
            }),
          },
        ],
      };
    }
    const { sql } = getOrgPg();

    if (args.mode === 'none') {
      await clearOverwatchTimeWake(sql, installSlug);
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ ok: true, harness: installSlug, mode: 'none', floorSec: overwatchWakeFloorSec() }),
          },
        ],
      };
    }

    const wantsTime = args.at != null || args.inSeconds != null;
    // Bare call (no time, not 'none') → the configured cadence default
    // (getOverwatchCadenceSec, D-017) so a turn that just says "wake me again"
    // keeps the control-loop heartbeat without the persona needing the number.
    const requested =
      args.at != null
        ? new Date(args.at)
        : args.inSeconds != null
          ? new Date(Date.now() + args.inSeconds * 1_000)
          : new Date(Date.now() + (await getOverwatchCadenceSec(workspaceId, installSlug)) * 1_000);

    const r = await declareOverwatchTimeWake(sql, { workspaceId, installSlug, at: requested, kickoff: args.kickoff });
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            harness: installSlug,
            mode: 'time',
            time: { at: r.at.toISOString(), clamped: r.clamped },
            defaultedToCadence: !wantsTime,
            floorSec: overwatchWakeFloorSec(),
          }),
        },
      ],
    };
  },
});
