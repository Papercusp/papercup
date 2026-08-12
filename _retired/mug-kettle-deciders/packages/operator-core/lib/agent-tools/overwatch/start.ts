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
import { resolveHomePotSlug } from '../pot/_resolve';
import {
  setOverwatchStarted,
  setOverwatchCadenceSec,
  clampOverwatchCadenceSec,
  DEFAULT_OVERWATCH_CADENCE_SEC,
} from '../../overwatch/control-state';
import { requestOverwatchWake } from '../../overwatch/wake-bridge';
import { softText, clampText, LIMITS } from '../limits';
import { refuseIfMugKettleRetired } from '../_mug-kettle-gate';

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
    // RETIREMENT GATE (retire-mug-kettle-su-only-2026-08-09 P-010 / D-017).
    // This tool already consults FLAGS.OVERWATCH — but a SECOND flag is not THIS
    // flag: OVERWATCH gates whether the supervisor runs, MUG_KETTLE_SYSTEM gates
    // whether the tier exists at all, and the retirement flag must be the
    // authority. Note the existing OVERWATCH branch still PERSISTS started +
    // cadence ("pre-armed") when that flag is off, so relying on it would leave
    // a retired Kettle armed to launch the moment someone flipped OVERWATCH on.
    const retired = await refuseIfMugKettleRetired(
      'start the Kettle',
      'System-health supervision now runs as plain `system:` routines (P-035/D-015).',
    );
    if (retired) return retired;
    const workspaceId = args.workspace ?? ctx.workspaceId ?? ctx.principal?.workspaceId ?? activeWorkspaceId();
    // `resolvePotHomeSlug` is ENV-ONLY, and PAPERCUSP_POT_HOME_SLUG is unset on the
    // dev/green operators. That made this the owner-visible half of the 2026-07-25
    // Kettle bug: once PAUSED, overwatch.controlState reported potSlug:null, so the
    // sidebar's Start button called this tool with NO harness and got
    // `no_home_harness` back — Start looked dead. Fall back to the registry home
    // pot, the same slug the steering UI writes to (mug-steering-panel GAP 1).
    const installSlug = resolvePotHomeSlug(args.harness, undefined) ?? (await resolveHomePotSlug(workspaceId));
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
            'Start Kettle — the owner started the supervisor; survey system health and nudge any drift back',
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
