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
  readQualificationAdmission,
  setQualificationHold,
  RELEASE_CHECKPOINT_DEFAULTS,
  type ReleaseCheckpointConfig,
  type QualificationHold,
} from '../../release-checkpoint-config';

/** The currently-placed hold, or null. A malformed/unknown admission reads as null here so a
 *  corrupted token can be overwritten (and reverted to "no hold") rather than being unliftable. */
async function currentHold(): Promise<QualificationHold | null> {
  const a = await readQualificationAdmission();
  return a.status === 'held' ? a.hold : null;
}

function json(obj: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(obj) }] };
}

const DAY_MS = 24 * 60 * 60 * 1000;

export default defineTool({
  name: 'release:checkpoint-config',
  profile: 'engineer',
  description:
    'Read or set the green-checkpoint / release thresholds: stallReds + stallAgeMs (held-gate STALLED alert), chronicFlakeCount + flakeNotifyCooldownMs (chronic-flake quarantine nudge), deployBackoffMs (re-deploy backoff after a failed/rolled-back deploy of the same target). op:hold / op:unhold place or lift the qualification hold that stops the SCHEDULED gate launching a run while a serializer hold is active. set/hold/unhold are audited + one-call-revertible.',
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
    // EI-21363817573800034: the qualification HOLD. governingRef is REQUIRED — a hold with no
    // attributable authority is how an unexplained frozen gate happens.
    z.object({
      op: z.literal('hold'),
      governingRef: z.string().min(1),
      blockingItems: z.array(z.string().min(1)).optional(),
      reason: z.string().optional(),
      dryRun: z.boolean().optional(),
    }),
    z.object({ op: z.literal('unhold'), dryRun: z.boolean().optional() }),
  ]),
  async handler(args, ctx) {
    if (args.op === 'get') {
      return json({
        effective: releaseCheckpointConfig(),
        overrides: await readReleaseCheckpointOverride(),
        defaults: RELEASE_CHECKPOINT_DEFAULTS,
        // Surfaced on the READ path too: a held gate that looks merely idle is exactly the
        // confusion this feature exists to remove.
        admission: await readQualificationAdmission(),
      });
    }

    if (args.op === 'hold' || args.op === 'unhold') {
      if (!isOperatorConfigWriteRole(ctx.role)) {
        throw new Error(`release:checkpoint-config ${args.op} requires operator, architect, or mug role`);
      }
      const next: QualificationHold | null =
        args.op === 'hold'
          ? {
              governingRef: args.governingRef,
              ...(args.blockingItems?.length ? { blockingItems: args.blockingItems } : {}),
              ...(args.reason ? { reason: args.reason } : {}),
              placedBy: `role:${ctx.role}`,
              placedAtMs: Date.now(),
            }
          : null;
      const outcome = await runControlMutation<QualificationHold | null>(
        {
          action: 'release:checkpoint-config',
          subject: 'green-checkpoint:qualification-hold',
          actor: `role:${ctx.role}`,
          capturePrev: () => currentHold(),
          apply: async () => {
            await setQualificationHold(next);
            return next;
          },
          revertTo: (prev) => setQualificationHold(prev),
          verify: async () => {
            const now = await currentHold();
            const ok = next === null ? now === null : now?.governingRef === next.governingRef;
            return { ok, detail: ok ? undefined : 'qualification hold did not persist' };
          },
          describe: (prev) => ({ current: prev, next }),
        },
        { dryRun: args.dryRun },
      );
      return json({
        ok: true, op: args.op, dryRun: outcome.dryRun, applied: outcome.applied, reverted: outcome.reverted,
        preview: outcome.preview, verify: outcome.verify, auditId: outcome.auditId, next: outcome.next,
      });
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
