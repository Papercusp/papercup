/**
 * pot:status — inspect the Pot's current wake declaration
 * (autoloop-hive-operator-rebuild-2026-06-05 P0). Read-only: the one-shot time
 * wake (routine row), the persisted event subscriptions + their live rule ids,
 * the last fire, and the floor.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import { COORD_ROLES } from '../coordination/roles';
import { activeWorkspaceId } from '../../workspace-registry';
import { listReactionRules } from '../../events/registry';
import {
  getPotTimeWake,
  potWakeFloorSec,
  readPotWakeState,
  resolvePotHomeSlug,
} from '../../pot/wake';
import { getPotStarted } from '../../pot/started';
import { recentWatchdogFires, watchdogFallbackSleepSec, watchdogStaleSec } from '../../pot/watchdog';
import { summarizeOpenPlacements } from '../../pot/placement-watchdog';
import { readPotSoakReport } from '../../pot/soak-report';

export default defineTool({
  name: 'pot:status',
  profile: 'engineer',
  description:
    "The Pot operator's current state: started/paused (the Start-Pot bit), the pending time wake (one-shot routine), event subscriptions + live rule ids, last wake, the floor, and the watchdog health signal (fallback fires in 24h). Read-only.",
  guidance: {
    when: 'To see when/whether the operator will wake next, or to verify a pot:declare-wake landed.',
    chaining: 'pot:declare-wake to change the declaration; pot:wake to fire now.',
    seeAlso: [
      'pot:declare-wake (change the wake declaration)',
      'pot:wake (fire the Mug now)',
      'pot:get (full pot detail — cups, load, queued work)',
    ],
  },
  capability: 'harness:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    harness: z.string().max(120).optional().describe('Home harness slug (default: ctx harness or PAPERCUSP_POT_HOME_SLUG).'),
  }),
  async handler(args, ctx) {
    const workspaceId = ctx.workspaceId ?? ctx.principal?.workspaceId ?? activeWorkspaceId();
    // EI-1802: resolve the home harness from the explicit arg, THEN the ctx
    // harness (a scoped session), then the env default — matching pot:wake /
    // pot:get_steering. The old `undefined` ignored a scoped session's harness
    // and fell through to the degraded `started:false` default below, which a
    // Mug could not distinguish from a genuinely-paused pot.
    const installSlug = resolvePotHomeSlug(args.harness, ctx.harnessSlug);
    const harnessUnresolved = !installSlug;
    const { sql } = getOrgPg();

    // K1 (workspace-scoped-coordination P-003): read the workspace-papercup wake
    // routine when the flag is ON (OFF ⇒ per-pot, unchanged).
    const time = installSlug ? await getPotTimeWake(sql, installSlug, { workspaceId }) : null;
    const state = await readPotWakeState(workspaceId);
    const ruleIds = listReactionRules()
      .filter((r) => r.id.startsWith(`pot-wake:${workspaceId}#`))
      .map((r) => r.id);
    // start-pot-wake P-004/P-012: the Start/Pause state + the watchdog health
    // signal (frequent fallback fires = a Mug prompt bug to fix, D-004).
    // EI-1802: with no resolved home harness the Start/Pause bit is UNKNOWN, not
    // false. Returning false here was indistinguishable from a genuinely-paused
    // pot, so a Mug could misread dormancy (wrongly self-run pot:start, or
    // conclude dormancy and escalate). null = unknown; the harness_unresolved
    // flag below is the signal callers should branch on.
    const started = installSlug ? await getPotStarted(workspaceId, installSlug) : null;
    const watchdogFires24h = installSlug ? await recentWatchdogFires(workspaceId, installSlug) : 0;
    // B-09 P-020/P-023: the open placements the Mug must drive to terminal —
    // recovering (re-place now), cursed (escalated), stranded (blocker stuck).
    const placements = installSlug ? await summarizeOpenPlacements(workspaceId, installSlug) : null;
    const soakReport = installSlug ? await readPotSoakReport(installSlug).catch(() => null) : null;

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            harness: installSlug,
            // EI-1802: surface the unresolved-harness case EXPLICITLY so a consumer (Mug /
            // overwatch) never reads the null `started` as a real paused-pot signal. true ⇒
            // no home harness resolved (started/time/placements are unknown, not dormant).
            harnessUnresolved,
            started,
            watchdog: {
              fires24h: watchdogFires24h,
              fallbackSleepSec: watchdogFallbackSleepSec(),
              staleSec: watchdogStaleSec(),
            },
            soakReport,
            time: time
              ? {
                  active: time.active,
                  nextFireAt: time.nextFireAt ? new Date(time.nextFireAt).toISOString() : null,
                  lastFiredAt: time.lastFiredAt ? new Date(time.lastFiredAt).toISOString() : null,
                }
              : null,
            placements,
            subscriptions: state.subscriptions,
            liveRuleIds: ruleIds,
            lastWakeAt: state.lastWakeAt ? new Date(state.lastWakeAt).toISOString() : null,
            declaredAt: state.declaredAt ? new Date(state.declaredAt).toISOString() : null,
            floorSec: potWakeFloorSec(),
          }),
        },
      ],
    };
  },
});
