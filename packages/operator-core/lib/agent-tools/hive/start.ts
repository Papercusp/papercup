/**
 * hive:start — the global "Start Hive" control
 * (start-hive-wake-orchestration-2026-06-09 P-005, D-005/D-006).
 *
 * Distinct from PlanRail's per-plan Start (plans:start drives the feature
 * pipeline): THIS boots the brain. START =
 *   1. persist `hive_started = true` (P-004 — the bit the watchdog keys on),
 *   2. re-affirm the Queen's default event subscriptions (P-002, ENSURE mode —
 *      her runtime tuning is preserved),
 *   3. set the global wake-mode default to `auto` (the Pause primitive's
 *      inverse, D-005),
 *   4. wake the Queen NOW (floor/coalesced via the urgent-wake path).
 * The watchdog needs no explicit arm — its every seam gates on the started bit.
 *
 * OQ-4 (resolved as recommended): Start is BRAIN-ONLY — it does not resume
 * per-harness feature loops (autoloop routines); steering dispatch is the
 * Queen's judgment once awake.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { COORD_ROLES } from '../coordination/roles';
import { activeWorkspaceId } from '../../workspace-registry';
import { resolveHiveHomeSlug } from '../../hive/wake';
import { setHiveStarted } from '../../hive/started';
import { armDefaultHiveWakeSubscriptions } from '../../hive/wake-defaults';
import { setDefaultWakeMode } from '../coordination/wake-mode';
import { requestUrgentHiveWake } from '../../hive/urgent-wake';

export default defineTool({
  name: 'hive:start',
  profile: 'engineer',
  description:
    'START the hive (the global control, distinct from a per-plan Start): persist hive_started=true, re-affirm the Queen\'s default event-wake subscriptions (plan-started / work-item-created / escalation), set the global wake-mode to auto, and wake the Queen now (floor-debounced). The liveness watchdog holds "a wake is always armed" from here until hive:pause.',
  guidance: {
    when: "The user clicks Start Hive / asks to boot the colony, or you are bringing a paused hive back to autonomous operation.",
    notWhen:
      'To wake the Queen once without changing the started state — hive:wake. To start one plan — plans:start. To create a hive — hive:create.',
    chaining: 'hive:status to verify (started, subscriptions, next wake); hive:pause to suspend.',
  },
  capability: 'harness:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    harness: z
      .string()
      .max(120)
      .optional()
      .describe('Hive home-harness slug (default: ctx harness or PAPERCUSP_HIVE_HOME_SLUG).'),
    workspace: z.string().max(120).optional().describe('Workspace id (default: ctx / active workspace).'),
    kickoff: z.string().max(2000).optional().describe('Kickoff context for the immediate wake.'),
  }),
  async handler(args, ctx) {
    const workspaceId = args.workspace ?? ctx.workspaceId ?? ctx.principal?.workspaceId ?? activeWorkspaceId();
    const installSlug = resolveHiveHomeSlug(args.harness, ctx.harnessSlug);
    if (!installSlug) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: false,
              error: 'no_home_harness',
              message: 'Pass `harness` (or set PAPERCUSP_HIVE_HOME_SLUG) — the started state is per-hive.',
            }),
          },
        ],
      };
    }

    await setHiveStarted(workspaceId, installSlug, true);
    // ENSURE (not replace): the Queen's runtime-tuned subscriptions survive a
    // Pause→Start cycle; only uncovered defaults are added (P-002 / D-001).
    const subs = await armDefaultHiveWakeSubscriptions(workspaceId, { mode: 'ensure' });
    await setDefaultWakeMode('auto');
    const wake = await requestUrgentHiveWake({
      reason: args.kickoff ?? 'Start Hive — the user started the colony; survey and get the fleet moving',
      harness: installSlug,
      workspaceId,
    });

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            harness: installSlug,
            started: true,
            wakeMode: 'auto',
            subscriptions: { liveRules: subs.rules, defaultsAdded: subs.added },
            wake,
          }),
        },
      ],
    };
  },
});
