/**
 * hive:set-steering — the owner's steering write surface for the Queen
 * (queen-steering-panel-2026-06-15, brief B-01; CONTRACT C-1).
 *
 * Writes the `owner-steering:*` hive_settings (via owner-steering.ts) — a focus
 * directive, the plans the Queen may pick up NOW (eligibility, DISTINCT from
 * lifecycle status, D-002), and a new-work pause (immediate or until a timestamp).
 * Then it (1) refreshes the 👑 Queen tab (`notifySyncInvalidate('hive.steering')`)
 * and (2) WAKES the Queen, so a steering change is honoured on her next survey
 * immediately rather than at the next cadence tick. The 👑 Queen tab (B-04) writes
 * through this; the Queen wake-brief (B-02) reads the same keys via getOwnerSteering.
 *
 * Sibling of `hive:pause` (the other harness:write Hive-control verb). Read twin:
 * `hive:get-steering`.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { COORD_ROLES } from '../coordination/roles';
import { activeWorkspaceId } from '../../workspace-registry';
import { resolveHiveHomeSlug } from '../../hive/wake';
import { requestUrgentHiveWake } from '../../hive/urgent-wake';
import { setOwnerSteering, type OwnerSteeringPatch } from '../../owner-steering';

const json = (o: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(o) }] });

export default defineTool({
  name: 'hive:set-steering',
  profile: 'engineer',
  description:
    'Set the owner steering the Queen reads on every wake (the 👑 Queen tab writes through this): a focus `directive`, `eligiblePlans` (the plans she may pick up NOW — eligibility, DISTINCT from a plan\'s lifecycle status), `eligibleHives` (the placement SCOPE — hives/harnesses she may place into, → survey allowedHarnesses), `pauseNewWork` / `pausedUntil` (pause starting new work, immediately or until an epoch-ms timestamp). Writes the owner-steering:* hive_settings, refreshes the panel (sync), AND wakes the Queen so she honours the change immediately. `clear:true` wipes ALL steering back to the default (no restriction); omitted fields are left unchanged (a null/[] value clears that one field).',
  guidance: {
    when: 'Steering the Queen from the owner surface — focus her on specific plans, give a directive, or pause new work (incident / cost / review). The 👑 Queen tab is the UI for this.',
    notWhen:
      'Freezing the WHOLE hive (all autonomous wakes) — hive:pause. Per-plan lifecycle (draft/ready/shipped) — plans:*. Stopping ONE bee — fleet:drain / fleet:cancel.',
    chaining:
      'hive:set-steering { eligiblePlans:[...], directive:"only these plans" } → the Queen wakes + honours it next placement. hive:set-steering { pauseNewWork:true } → she drives existing work to terminal then idles. hive:get-steering reads the current state; clear:true resets.',
  },
  capability: 'harness:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    hive: z
      .string()
      .max(120)
      .optional()
      .describe('Hive home-harness slug (default: ctx harness / PAPERCUSP_HIVE_HOME_SLUG) — steering is per-hive.'),
    workspace: z.string().max(120).optional().describe('Workspace id (default: ctx / active workspace).'),
    directive: z
      .string()
      .max(4000)
      .nullable()
      .optional()
      .describe('Free-text directive surfaced in the Queen wake brief. null or "" clears it.'),
    eligiblePlans: z
      .array(z.string().min(1).max(200))
      .max(200)
      .optional()
      .describe('Plan slugs the Queen may pick up NOW (eligibility ≠ lifecycle status). [] = no restriction (default).'),
    eligibleHives: z
      .array(z.string().min(1).max(200))
      .max(500)
      .optional()
      .describe('The placement SCOPE — hive/harness slugs the home Queen may place into (→ survey allowedHarnesses). [] = no restriction (default).'),
    pauseNewWork: z
      .boolean()
      .optional()
      .describe('Pause starting NEW work — the Queen drives existing placements to terminal then idles.'),
    pausedUntil: z
      .number()
      .int()
      .nonnegative()
      .nullable()
      .optional()
      .describe('Epoch ms the pause auto-expires at. null = no time-bound pause.'),
    clear: z.boolean().optional().describe('Wipe ALL steering keys back to the default (no restriction).'),
  }),
  async handler(args, ctx) {
    const workspaceId = args.workspace ?? ctx.workspaceId ?? ctx.principal?.workspaceId ?? activeWorkspaceId();
    const installSlug = resolveHiveHomeSlug(args.hive, ctx.harnessSlug ?? undefined);
    if (!installSlug) {
      return json({
        ok: false,
        error: 'no_home_harness',
        message: 'Pass `hive` (or set PAPERCUSP_HIVE_HOME_SLUG) — steering is per-hive.',
      });
    }
    const patch: OwnerSteeringPatch = {};
    if (args.directive !== undefined) patch.directive = args.directive;
    if (args.eligiblePlans !== undefined) patch.eligiblePlans = args.eligiblePlans;
    if (args.eligibleHives !== undefined) patch.eligibleHives = args.eligibleHives;
    if (args.pauseNewWork !== undefined) patch.pauseNewWork = args.pauseNewWork;
    if (args.pausedUntil !== undefined) patch.pausedUntil = args.pausedUntil;
    if (args.clear !== undefined) patch.clear = args.clear;

    let steering;
    try {
      steering = await setOwnerSteering(workspaceId, installSlug, patch);
    } catch (e) {
      // setHiveSetting rejects when the hive doesn't exist (logical scope, no FK).
      return json({ ok: false, error: e instanceof Error ? e.message : String(e), hive: installSlug });
    }

    // Refresh the 👑 Queen tab (hive.steering resolver) — best-effort.
    void import('../../sync-sse')
      .then(({ notifySyncInvalidate }) => notifySyncInvalidate('hive.steering', {}))
      .catch(() => {});

    // Wake the Queen so the new steering is honoured on her next survey now, not at
    // the next cadence tick. Fire-and-forget (the wake reports, never throws).
    const wake = await requestUrgentHiveWake({
      reason: 'owner steering updated',
      harness: installSlug,
      workspaceId,
    }).catch(() => null);

    return json({ ok: true, hive: installSlug, steering, queenWoken: wake?.fired ?? false });
  },
});
