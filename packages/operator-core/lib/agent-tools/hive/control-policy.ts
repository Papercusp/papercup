/**
 * pot:control_policy — read/set the placement-watchdog thresholds (live-configurability-audit P-015).
 *
 * Retires the PAPERCUSP_HIVE_PLACEMENT_* env gates: breakerThreshold (failed placements before the
 * cursed-item breaker trips), recoveryDebounceMs (min gap between recovery wakes for one stalled unit),
 * dormancyGraceMs (post-dormancy recovery-sweep grace), infraBreakerThreshold (bounded infra-loss
 * breaker). Overlaid by placementConfig() over its env defaults (sync-cached). set is audited +
 * one-call-revertible. Absent ⇒ env/baked default ⇒ byte-identical.
 *
 * (D-005: placement AFFINITY weights live in pot:set-steering, not here.)
 */
import { z } from 'zod';
import { defineTool, SU_ROLES, isOperatorConfigWriteRole } from '@papercusp/agent-mcp';
import { runControlMutation } from '../../gateway-control/control-harness';
import {
  readHiveControlPolicy,
  writeHiveControlPolicy,
  setHiveControlPolicy,
  HIVE_CONTROL_DEFAULTS,
  type HiveControlPolicy,
} from '../../hive-control-policy';

function json(obj: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(obj) }] };
}

const DAY_MS = 24 * 60 * 60 * 1000;

export default defineTool({
  name: 'pot:control_policy',
  profile: 'engineer',
  description:
    'Read or set the hive placement-watchdog thresholds: breakerThreshold (failed placements → cursed-item breaker), recoveryDebounceMs (min gap between recovery wakes for one stalled unit), dormancyGraceMs (post-dormancy recovery-sweep grace), infraBreakerThreshold (bounded infra-loss breaker). Replaces the PAPERCUSP_HIVE_PLACEMENT_* env gates; set is audited + one-call-revertible.',
  capability: 'operator:write',
  guidance: {
    when: 'Tune the placement watchdog live — e.g. raise breakerThreshold to give a flapping unit more recovery attempts before cursing it, or shorten recoveryDebounceMs to re-place stalled work faster during an incident.',
    notWhen: 'For placement AFFINITY weights use pot:set-steering (D-005). For stale-claim reclaim use work_items:reclaim_config; for session reaping use coord:session_reaper_config.',
    chaining: 'config:list-overrides shows the active override; config:reset-overrides reverts it.',
    seeAlso: [
      'pot:set-steering (placement AFFINITY weights, not watchdog tuning)',
      'work_items:reclaim_config (stale-claim reclaim tuning)',
      'config:list-overrides (the active override this wrote)',
    ],
  },
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  rolesQuota: { operator: { perRun: 20 } },
  args: z.discriminatedUnion('op', [
    z.object({ op: z.literal('get') }),
    z.object({
      op: z.literal('set'),
      breakerThreshold: z.number().int().min(1).max(1000).optional(),
      recoveryDebounceMs: z.number().int().min(0).max(DAY_MS).optional(),
      dormancyGraceMs: z.number().int().min(0).max(DAY_MS).optional(),
      infraBreakerThreshold: z.number().int().min(1).max(1000).optional(),
      dryRun: z.boolean().optional(),
    }),
  ]),
  async handler(args, ctx) {
    if (args.op === 'get') {
      const c = await readHiveControlPolicy();
      return json({
        effective: { ...HIVE_CONTROL_DEFAULTS, ...c },
        overrides: c,
        defaults: HIVE_CONTROL_DEFAULTS,
      });
    }

    if (!isOperatorConfigWriteRole(ctx.role)) {
      throw new Error('pot:control_policy set requires operator, architect, or queen role');
    }
    const patch: HiveControlPolicy = {};
    if (args.breakerThreshold !== undefined) patch.breakerThreshold = args.breakerThreshold;
    if (args.recoveryDebounceMs !== undefined) patch.recoveryDebounceMs = args.recoveryDebounceMs;
    if (args.dormancyGraceMs !== undefined) patch.dormancyGraceMs = args.dormancyGraceMs;
    if (args.infraBreakerThreshold !== undefined) patch.infraBreakerThreshold = args.infraBreakerThreshold;
    if (Object.keys(patch).length === 0) {
      throw new Error('set requires at least one of breakerThreshold / recoveryDebounceMs / dormancyGraceMs / infraBreakerThreshold');
    }

    const outcome = await runControlMutation<HiveControlPolicy>(
      {
        action: 'pot:control_policy',
        subject: 'placement-watchdog',
        actor: `role:${ctx.role}`,
        capturePrev: () => readHiveControlPolicy(),
        apply: () => writeHiveControlPolicy(patch),
        revertTo: (prev) => setHiveControlPolicy(prev),
        verify: async (next) => {
          const ok = (Object.keys(patch) as (keyof HiveControlPolicy)[]).every((k) => next[k] === patch[k]);
          return { ok, detail: ok ? undefined : 'policy did not persist' };
        },
        describe: (prev) => ({ current: { ...HIVE_CONTROL_DEFAULTS, ...prev }, patch }),
      },
      { dryRun: args.dryRun },
    );
    return json({
      ok: true, dryRun: outcome.dryRun, applied: outcome.applied, reverted: outcome.reverted,
      preview: outcome.preview, verify: outcome.verify, auditId: outcome.auditId, next: outcome.next,
    });
  },
});
