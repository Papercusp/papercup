/**
 * release:checkpoint-config — read/set the green-checkpoint / release thresholds
 * (live-configurability-audit-2026-06-20 P-016).
 *
 * stallReds / stallAgeMs (when a held gate is alerted as STALLED), chronicFlakeCount /
 * flakeNotifyCooldownMs (chronic-flake quarantine nudge), deployBackoffMs (re-deploy backoff after a
 * failed/rolled-back deploy of the same target). Overlaid by releaseCheckpointConfig() over the
 * release-actions.ts const defaults. set is audited + one-call-revertible; empty ⇒ byte-identical.
 */
import { z } from 'zod';
import { defineTool, SU_ROLES, isOperatorConfigWriteRole } from '@papercusp/agent-mcp';
import { runControlMutation } from '../../gateway-control/control-harness';
import {
  readReleaseCheckpointOverride,
  writeReleaseCheckpointConfig,
  setReleaseCheckpointOverride,
  releaseCheckpointConfig,
  RELEASE_CHECKPOINT_DEFAULTS,
  type ReleaseCheckpointConfig,
} from '../../release-checkpoint-config';

function json(obj: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(obj) }] };
}

const DAY_MS = 24 * 60 * 60 * 1000;

export default defineTool({
  name: 'release:checkpoint-config',
  profile: 'engineer',
  description:
    'Read or set the green-checkpoint / release thresholds: stallReds + stallAgeMs (held-gate STALLED alert), chronicFlakeCount + flakeNotifyCooldownMs (chronic-flake quarantine nudge), deployBackoffMs (re-deploy backoff after a failed/rolled-back deploy of the same target). set is audited + one-call-revertible.',
  capability: 'operator:write',
  guidance: {
    when: 'Tune the release pipeline live — e.g. shorten deployBackoffMs to re-deploy a fixed target sooner during an incident, or raise stallReds/stallAgeMs to quiet a noisy stall alert.',
    notWhen: 'For the placement watchdog use pot:control_policy; for migrations use db:migrate-policy. vitest forks / suite-timeout (green-checkpoint.ts) and the health-probe timing are not covered here (separate consumers — follow-up).',
    chaining: '/admin/git shows the pipeline; config:list-overrides shows the active override; config:reset-overrides reverts it.',
    seeAlso: [
      'release:checkpoint-run (run the checkpoint suite now under this config)',
      'release:deploy (deploy the green pin the checkpoint produces)',
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
      stallReds: z.number().int().min(1).max(1000).optional(),
      stallAgeMs: z.number().int().min(60_000).max(7 * DAY_MS).optional(),
      chronicFlakeCount: z.number().int().min(1).max(1000).optional(),
      flakeNotifyCooldownMs: z.number().int().min(0).max(7 * DAY_MS).optional(),
      deployBackoffMs: z.number().int().min(0).max(DAY_MS).optional(),
      dryRun: z.boolean().optional(),
    }),
  ]),
  async handler(args, ctx) {
    if (args.op === 'get') {
      return json({ effective: releaseCheckpointConfig(), overrides: await readReleaseCheckpointOverride(), defaults: RELEASE_CHECKPOINT_DEFAULTS });
    }

    if (!isOperatorConfigWriteRole(ctx.role)) {
      throw new Error('release:checkpoint-config set requires operator, architect, or mug role');
    }
    const patch: Partial<ReleaseCheckpointConfig> = {};
    if (args.stallReds !== undefined) patch.stallReds = args.stallReds;
    if (args.stallAgeMs !== undefined) patch.stallAgeMs = args.stallAgeMs;
    if (args.chronicFlakeCount !== undefined) patch.chronicFlakeCount = args.chronicFlakeCount;
    if (args.flakeNotifyCooldownMs !== undefined) patch.flakeNotifyCooldownMs = args.flakeNotifyCooldownMs;
    if (args.deployBackoffMs !== undefined) patch.deployBackoffMs = args.deployBackoffMs;
    if (Object.keys(patch).length === 0) {
      throw new Error('set requires at least one of stallReds / stallAgeMs / chronicFlakeCount / flakeNotifyCooldownMs / deployBackoffMs');
    }

    const outcome = await runControlMutation<Partial<ReleaseCheckpointConfig>>(
      {
        action: 'release:checkpoint-config',
        subject: 'green-checkpoint',
        actor: `role:${ctx.role}`,
        capturePrev: () => readReleaseCheckpointOverride(),
        apply: () => writeReleaseCheckpointConfig(patch),
        revertTo: (prev) => setReleaseCheckpointOverride(prev),
        verify: async (next) => {
          const ok = (Object.keys(patch) as (keyof ReleaseCheckpointConfig)[]).every((k) => next[k] === patch[k]);
          return { ok, detail: ok ? undefined : 'config did not persist' };
        },
        describe: (prev) => ({ current: { ...RELEASE_CHECKPOINT_DEFAULTS, ...prev }, patch }),
      },
      { dryRun: args.dryRun },
    );
    return json({
      ok: true, dryRun: outcome.dryRun, applied: outcome.applied, reverted: outcome.reverted,
      preview: outcome.preview, verify: outcome.verify, auditId: outcome.auditId, next: outcome.next,
    });
  },
});
