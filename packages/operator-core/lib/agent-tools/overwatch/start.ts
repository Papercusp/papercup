/**
 * kettle:start — the "Start Overwatch" control (overwatch-role-2026-06-15 B-07).
 *
 * The sibling of pot:start, for the autonomous SYSTEM-HEALTH supervisor (a peer
 * to the Queen, D-005). START =
 *   1. persist `overwatch_started = true` (control-state.ts — the bit the loop
 *      (B-04) + liveness watchdog (B-09) key on),
 *   2. persist the wake cadence (default 10 min — a short-term control loop),
 *   3. request an immediate wake via the B-04 wake-bridge seam (fail-soft until
 *      B-04 is wired — the started bit is the durable arm regardless).
 *
 * Flag-aware (D-009): the `papercusp-overwatch` flag is the ACTIVATION gate (it
 * gates B-04's loop + the spawn-admission). When it is OFF, start still persists
 * the bit + cadence (so the colony is pre-armed for the moment the owner flips it
 * on, B-12) but SKIPS the live wake and surfaces a loud warning — never a silent
 * "started" that does nothing (cf. EI-590).
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { COORD_ROLES } from '../coordination/roles';
import { activeWorkspaceId } from '../../workspace-registry';
import { resolvePotHomeSlug } from '../../pot/wake';
import {
  setOverwatchStarted,
  setOverwatchCadenceSec,
  clampOverwatchCadenceSec,
  DEFAULT_OVERWATCH_CADENCE_SEC,
} from '../../overwatch/control-state';
import { requestOverwatchWake } from '../../overwatch/wake-bridge';
import { softText, clampText, LIMITS } from '../limits';

export default defineTool({
  name: 'kettle:start',
  profile: 'engineer',
  description:
    'START the Kettle (the autonomous system-health supervisor, a sibling to the Mug): persist overwatch_started=true, set its wake cadence, and wake it now. The loop (B-04) + liveness watchdog (B-09) hold "a wake is always armed" from here until kettle:pause. Gated by the papercusp-overwatch flag — while the flag is OFF the bit/cadence are persisted (pre-armed) but no live wake fires.',
  guidance: {
    when: 'The user clicks Start Kettle / asks to boot the system-health supervisor, or you are bringing a paused Kettle back to autonomous operation.',
    notWhen:
      'To start the Mug / pot — pot:start (distinct loop). To start one plan — plans:start. The Kettle nudges + observes; it never places work.',
    chaining:
      'kettle:pause to suspend. The papercusp-overwatch flag (/admin/features) must be ON for the loop to actually run (B-04 gate).',
    seeAlso: [
      'kettle:pause (suspend the Kettle)',
      'pot:start (start the Mug / pot — distinct loop)',
    ],
  },
  capability: 'harness:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    harness: z
      .string()
      .max(120)
      .optional()
      .describe('Pot home-harness slug the Kettle supervises (default: ctx harness or PAPERCUSP_POT_HOME_SLUG).'),
    workspace: z.string().max(120).optional().describe('Workspace id (default: ctx / active workspace).'),
    cadenceSec: z
      .number()
      .int()
      .optional()
      .describe('Wake cadence in seconds (clamped to [60, 3600]; default 600 = 10 min — a short-term control loop).'),
    kickoff: softText(LIMITS.ANNOTATION).optional().describe('Kickoff context for the immediate wake. Auto-truncated to 2000 chars if longer.'),
  }),
  async handler(args, ctx) {
    const workspaceId = args.workspace ?? ctx.workspaceId ?? ctx.principal?.workspaceId ?? activeWorkspaceId();
    const installSlug = resolvePotHomeSlug(args.harness, undefined);
    if (!installSlug) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: false,
              error: 'no_home_harness',
              message: 'Pass `harness` (or set PAPERCUSP_POT_HOME_SLUG) — the Kettle state is per-pot.',
            }),
          },
        ],
      };
    }

    const cadenceSec = clampOverwatchCadenceSec(args.cadenceSec ?? DEFAULT_OVERWATCH_CADENCE_SEC);
    await setOverwatchStarted(workspaceId, installSlug, true);
    await setOverwatchCadenceSec(workspaceId, installSlug, cadenceSec);

    // The papercusp-overwatch flag is the activation gate (D-009): with it OFF,
    // B-04's loop never fires, so a live wake would be a no-op anyway — skip it
    // and warn loudly. The persisted bit + cadence pre-arm the role for the flip.
    const { FLAGS } = await import('@papercusp/flags');
    const { getFlag } = await import('@papercusp/flags/server');
    const flagEnabled = await getFlag(FLAGS.OVERWATCH, `overwatch:${workspaceId}`);

    const wake = flagEnabled
      ? await requestOverwatchWake({
          reason:
            clampText(args.kickoff, LIMITS.ANNOTATION) ??
            'Start Overwatch — the owner started the supervisor; survey system health and nudge any drift back',
          harness: installSlug,
          workspaceId,
        })
      : { wired: false as const, skipped: 'flag_off' as const };

    // Live UI reflection (mirrors hive.controlState): the overwatch pane (B-08)
    // reads overwatch.controlState. Invalidating an unwired name is a safe no-op.
    void import('../../sync-sse')
      .then(({ notifySyncInvalidate }) => notifySyncInvalidate('overwatch.controlState', {}))
      .catch(() => {});

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            harness: installSlug,
            started: true,
            cadenceSec,
            flagEnabled,
            wake,
            ...(flagEnabled
              ? {}
              : {
                  warning:
                    'The papercusp-overwatch flag is OFF — overwatch_started + cadence are persisted (pre-armed), but the loop will NOT run and no wake fired until the flag is flipped ON (/admin/features; B-10/B-12).',
                }),
          }),
        },
      ],
    };
  },
});
