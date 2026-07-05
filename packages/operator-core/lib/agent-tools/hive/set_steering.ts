/**
 * pot:set-steering — the owner's steering write surface for the Queen
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
 * Sibling of `pot:pause` (the other harness:write Hive-control verb). Read twin:
 * `pot:get-steering`.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { COORD_ROLES } from '../coordination/roles';
import { activeWorkspaceId } from '../../workspace-registry';
import { resolveHiveHomeSlug } from '../../hive/wake';
import { requestUrgentHiveWake } from '../../hive/urgent-wake';
import { setOwnerSteering, type OwnerSteeringPatch } from '../../owner-steering';
import { LIMITS } from '../limits';

const json = (o: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(o) }] });

export default defineTool({
  name: 'pot:set-steering',
  profile: 'engineer',
  description:
    'Set the owner steering the Queen reads on every wake (the 👑 Queen tab writes through this): a focus `directive`, `eligiblePlans` / `eligibleHives` (what she may pick up + the placement scope NOW — eligibility ≠ lifecycle status), `pauseNewWork`/`pausedUntil`, the P-006 THROTTLE knobs (`cadenceFloorSec`, `maxBees`, `idleActivities`, `autoScaleOut`, `modelTiers`/`tierCeilings`, `decomposition`), and the federated Scout priming override `federatedPriming` (`foreignElites` / `crowded` / `empty`). Writes the owner-steering:* hive_settings, refreshes the panel, AND wakes the Queen so the change takes effect immediately. `clear:true` wipes all steering; omitted fields are unchanged (null/[] clears one field). See each arg description for detail.',
  guidance: {
    when: 'Steering the Queen from the owner surface — focus her on specific plans, give a directive, or pause new work (incident / cost / review). The 👑 Queen tab is the UI for this.',
    notWhen:
      'Freezing the WHOLE hive (all autonomous wakes) — pot:pause. Per-plan lifecycle (draft/ready/shipped) — plans:*. Stopping ONE bee — fleet:drain / fleet:cancel.',
    chaining:
      'pot:set-steering { eligiblePlans:[...], directive:"only these plans" } → the Queen wakes + honours it next placement. pot:set-steering { pauseNewWork:true } → she drives existing work to terminal then idles. pot:get-steering reads the current state; clear:true resets.',
    seeAlso: [
      'pot:get-steering (read the current steering before changing it)',
      'pot:pause (freeze the whole hive instead of steering the Queen)',
    ],
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
      .max(LIMITS.BRIEF)
      .nullable()
      .optional()
      .describe(`Free-text directive surfaced in the Queen wake brief. null or "" clears it. Max ${LIMITS.BRIEF} chars.`),
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
    includeUnplannedWork: z
      .boolean()
      .optional()
      .describe('Whether plan-LESS ("loose") work-items — those with no source plan — are placed. Default true; false ⇒ the Queen works ONLY plan-tied items. Independent of eligiblePlans (the "Non-plan work items" toggle).'),
    modelTiers: z
      .array(
        z.object({
          name: z.string().min(1).max(60),
          spec: z.string().min(1).max(120),
          backend: z.string().max(60).optional(),
          when: z.string().max(500).optional(),
        }),
      )
      .nullable()
      .optional()
      .describe('SESSION override of the model-tier menu (weakest→strongest) for the running fleet (D-006). null / [] clears it (use the workspace default).'),
    tierCeilings: z
      .record(z.string(), z.string().max(60))
      .nullable()
      .optional()
      .describe('SESSION override of the per-role tier ceilings (role→tier-name). null / {} clears it. e.g. {"cup":"opus:xhigh"} pins every bee.'),
    cadenceFloorSec: z
      .number()
      .nonnegative()
      .nullable()
      .optional()
      .describe('THROTTLE (P-006): min seconds between Queen wakes — effective floor = MAX(system 60s, this). Raises the interval to slow the loop. null / 0 clears it.'),
    maxBees: z
      .number()
      .int()
      .nullable()
      .optional()
      .describe('THROTTLE (P-006): concurrency ceiling — max concurrently-running agents/bees. Effective = MIN(system ceiling, this). null / <1 clears it.'),
    idleActivities: z
      .object({
        gym: z.boolean().optional(),
        scout: z.boolean().optional(),
        curation: z.boolean().optional(),
        'plan-review': z.boolean().optional(),
      })
      .nullable()
      .optional()
      .describe('THROTTLE (P-006): gate idle background activities. Each defaults ON; false suppresses that activity (gym cycles / Scout ideation / doc-curation / Queen review-iteration of Scout drafts). null / {} clears it.'),
    autoScaleOut: z
      .boolean()
      .nullable()
      .optional()
      .describe('THROTTLE (P-006): false disables automatic account-pool scale-out on sustained rate-limit exhaustion (manual accounts:scale_out still works). null clears it (⇒ default enabled).'),
    decomposition: z
      .enum(['serial', 'balanced', 'parallel'])
      .nullable()
      .optional()
      .describe('P-009 (ADVISORY): decomposition-aggressiveness hint the Queen reads in her wake brief — serial ↔ balanced ↔ max-parallel lanes. null clears it (Queen\'s own judgement).'),
    modelOverrides: z
      .record(z.string(), z.string().max(120))
      .nullable()
      .optional()
      .describe('SESSION per-role MODEL override (role→`model[:effort]`) for the FRONT-DOOR agents launched outside the cup:spawn tier path — keys "papercup" (dock TUI) and "kettle" (invoke loop). null / {} clears. e.g. {"papercup":"opus:high","kettle":"sonnet"}. (model-override-sidebar-2026-06-23.)'),
    federatedPriming: z
      .object({
        foreignElites: z.number().int().nonnegative().optional(),
        crowded: z.number().int().nonnegative().optional(),
        empty: z.number().int().nonnegative().optional(),
      })
      .nullable()
      .optional()
      .describe('SESSION Scout federated-priming override: nearby foreign-elites surfaced per ideation cycle plus crowded/empty niche counts for the repulsion map. 0 disables each subsection; null / {} clears it back to the blueprint default.'),
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
    if (args.includeUnplannedWork !== undefined) patch.includeUnplannedWork = args.includeUnplannedWork;
    if (args.modelTiers !== undefined) patch.modelTiers = args.modelTiers;
    if (args.tierCeilings !== undefined) patch.tierCeilings = args.tierCeilings;
    if (args.cadenceFloorSec !== undefined) patch.cadenceFloorSec = args.cadenceFloorSec;
    if (args.maxBees !== undefined) patch.maxBees = args.maxBees;
    if (args.idleActivities !== undefined) patch.idleActivities = args.idleActivities;
    if (args.autoScaleOut !== undefined) patch.autoScaleOut = args.autoScaleOut;
    if (args.decomposition !== undefined) patch.decomposition = args.decomposition;
    if (args.modelOverrides !== undefined) patch.modelOverrides = args.modelOverrides;
    if (args.federatedPriming !== undefined) patch.federatedPriming = args.federatedPriming;
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

    // Materialize the Sentinel's session model override to the file the dock's
    // psu-sentinel wrapper reads at launch (~/.papercusp/sentinel-model) — the
    // storage-policy "PG-canonical, file projected just-in-time" pattern (the bash
    // wrapper can't read hive_settings). The dock is volatile (relaunches on its
    // own), so the next relaunch picks up the new model. Best-effort.
    void import('../../sentinel-model-file')
      .then(({ materializeSentinelModelFile }) =>
        materializeSentinelModelFile(steering.modelOverrides?.papercup ?? null),
      )
      .catch(() => {});

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
