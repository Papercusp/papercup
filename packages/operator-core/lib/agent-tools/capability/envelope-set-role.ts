/**
 * capability_envelope:set_role — read/set/clear a role's runtime capability-envelope override
 * (live-configurability-audit-2026-06-20 P-009; the B-18 per-role tuning seam made live).
 *
 * Confine or loosen a fleet role's deny/allow capabilities at runtime (e.g. re-confine a hallucinating
 * bee to read-only without a deploy), merged OVER the baked ROLE_ENVELOPES. DARK behind
 * papercusp-capability-envelope-overrides (off ⇒ inert) + gated by the existing CAPABILITY_ENVELOPE
 * enforcement flag. The universal floor (secrets:* / processes:kill) ALWAYS applies and is never
 * loosenable here (use capability_envelope:set_protected to TIGHTEN it further). Audited + revertible.
 */
import { z } from 'zod';
import { defineTool, SU_ROLES, isOperatorConfigWriteRole } from '@papercusp/agent-mcp';
import { runControlMutation } from '../../gateway-control/control-harness';
import { readEnvelopeOverrides, setRoleEnvelope } from '../../capability-envelope-overrides';
import type { RoleEnvelope } from '../../capability-envelope/policy';

function json(obj: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(obj) }] };
}

export default defineTool({
  name: 'capability_envelope:set_role',
  profile: 'engineer',
  description:
    "Read/set/clear a fleet role's runtime capability-envelope override (denyCapabilities / allowCapabilities), merged over the baked ROLE_ENVELOPES. Confine or loosen a role live (e.g. re-confine a misbehaving bee to read-only) without a deploy. DARK (papercusp-capability-envelope-overrides) + requires the CAPABILITY_ENVELOPE enforcement flag to bite. The universal floor (secrets:*/processes:kill) always applies. set/clear audited + one-call-revertible.",
  capability: 'operator:write',
  guidance: {
    when: 'Incident response: confine a hallucinating/misbehaving role to read-only (denyCapabilities: capability:fs-write/capability:bash) or restore it, live. get to inspect the active override.',
    notWhen: 'To TIGHTEN the universal protected floor use capability_envelope:set_protected (tighten-only). To change quota use quota tools; tiers use capability_tier:set. Loosening cannot bypass the protected floor.',
    chaining: 'config:list-overrides shows the active envelope overrides; config:reset-overrides reverts them. Needs the owner to flip papercusp-capability-envelope-overrides + CAPABILITY_ENVELOPE to enforce.',
    seeAlso: [
      'capability:grant_role (grant one capability to a role)',
      'capability:revoke_role (revoke one)',
      'capability_tier:set (set the capability risk tier)',
    ],
  },
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  rolesQuota: { operator: { perRun: 20 } },
  args: z.discriminatedUnion('op', [
    z.object({ op: z.literal('get') }),
    z.object({
      op: z.literal('set'),
      role: z.string().min(1).max(80),
      denyCapabilities: z.array(z.string().min(1).max(120)).max(100).optional(),
      allowCapabilities: z.array(z.string().min(1).max(120)).max(100).optional(),
      dryRun: z.boolean().optional(),
    }),
    z.object({ op: z.literal('clear'), role: z.string().min(1).max(80), dryRun: z.boolean().optional() }),
  ]),
  async handler(args, ctx) {
    if (args.op === 'get') {
      const o = await readEnvelopeOverrides();
      return json({ roleEnvelopes: o.roleEnvelopes ?? {}, protectedAdditions: o.protectedAdditions ?? [] });
    }

    if (!isOperatorConfigWriteRole(ctx.role)) {
      throw new Error('capability_envelope:set_role requires operator, architect, or queen role');
    }
    const role = args.role;
    const nextEnv: RoleEnvelope | null =
      args.op === 'clear'
        ? null
        : {
            ...(args.denyCapabilities !== undefined ? { denyCapabilities: args.denyCapabilities } : {}),
            ...(args.allowCapabilities !== undefined ? { allowCapabilities: args.allowCapabilities } : {}),
          };
    if (args.op === 'set' && args.denyCapabilities === undefined && args.allowCapabilities === undefined) {
      throw new Error('set requires denyCapabilities and/or allowCapabilities (or use op:clear)');
    }

    const outcome = await runControlMutation<RoleEnvelope | null>(
      {
        action: 'capability_envelope:set_role',
        subject: `envelope:${role}`,
        actor: `role:${ctx.role}`,
        capturePrev: async () => (await readEnvelopeOverrides()).roleEnvelopes?.[role] ?? null,
        apply: async () => {
          await setRoleEnvelope(role, nextEnv);
          return nextEnv;
        },
        revertTo: (prev) => setRoleEnvelope(role, prev).then(() => {}),
        verify: async () => {
          const cur = (await readEnvelopeOverrides()).roleEnvelopes?.[role] ?? null;
          const ok = JSON.stringify(cur) === JSON.stringify(nextEnv);
          return { ok, detail: ok ? undefined : 'envelope override did not persist' };
        },
        describe: (prev) => ({ role, had: prev !== null, op: args.op, proposed: nextEnv }),
      },
      { dryRun: args.dryRun },
    );
    return json({
      ok: true, role, dryRun: outcome.dryRun, applied: outcome.applied, reverted: outcome.reverted,
      preview: outcome.preview, verify: outcome.verify, auditId: outcome.auditId,
    });
  },
});
