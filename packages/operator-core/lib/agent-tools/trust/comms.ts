/**
 * trust:comms — the owner's per-user COMMS-TRUST tier grants
 * (cross-machine-coord-parity-and-trust-2026-07-01 P-011/P-013, D-004).
 *
 * The coordination twin of trust:add's auto-RUN grant, kept as a SEPARATE tool
 * on purpose: "may their verified work auto-run" and "may their agents reach /
 * re-invoke / steer MY agents" are separable owner decisions. Tier lattice:
 * observe < message < wake < steer — below `message` a member's federated coord
 * is QUARANTINED (visible + grantable, never dropped); below `wake` it delivers
 * but never re-invokes (a wake is a billable turn); `steer` unlocks handoffs.
 * Resolution: this local override → the owner-signed hive-policy default
 * (`comms.defaultTier`) → the conservative fallback ('message').
 *
 * Owner-scoped, local-only, NEVER federated (a peer must not influence who may
 * spend your tokens). Audited.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { softText, clampText, LIMITS } from '../limits';

export default defineTool({
  name: 'trust:comms',
  profile: 'engineer',
  // Writes the workspace-scoped rows via the admin handle, scoping itself by the
  // resolved workspace id (D-004 — never relies on RLS).
  crossWorkspace: true,
  description:
    "Owner: set / remove / list per-user COMMS-TRUST tiers (observe<message<wake<steer) governing what a hive member's agents may do to YOUR agents across machines — below 'message' their coord quarantines; below 'wake' it delivers but never re-invokes (billable turns); 'steer' unlocks handoffs. { action:'set', githubUserId, tier, note?, expiresAtMs? } | { action:'remove', githubUserId } | { action:'list' } | { action:'gate', githubUserId, granted } — the DG-4 GATE grant (does this member's distributed-test-gate verdicts count toward green?), SEPARABLE from the tiers. Local-only, never federated, audited. Overrides the hive policy's comms.defaultTier per user.",
  capability: 'audit:write',
  guidance: {
    when: "Granting or downgrading a specific hive member's reach into your agents: give a collaborator 'wake' so their queen can re-invoke your bees; give 'steer' for handoffs; set 'observe' to explicitly mute a noisy member below the policy default. expiresAtMs makes a grant probationary (decays to the policy default). action:'gate' grants/revokes the DISTRIBUTED-TEST-GATE trust (P-047): whether that member's shard verdicts count toward green(S) — separable from steer (a CI box can be gate-trusted but never steer; a steer-trusted peer's verdicts don't count until gate-granted).",
    notWhen:
      "Auto-RUN of their verified work items — that is trust:add (a separate grant). The hive-wide DEFAULT tier — author comms.defaultTier in the owner-signed hive policy instead. Reading the quarantine queue — that surfaces via the coord quarantine store, not here.",
    chaining: "trust:comms {action:'list'} → {action:'set', githubUserId, tier:'wake'} — the projection picks the new tier up within its ~30s cache TTL. Gate: {action:'gate', githubUserId, granted:true} → the DG-5 aggregator starts counting their verdicts on its next round.",
    seeAlso: ['trust:add (auto-run grant — separable)', 'trust:list (auto-run list)', 'hive:set-steering (policy authoring)'],
  },
  requirePrincipal: false,
  agentRoles: ['operator'],
  args: z
    .object({
      action: z.enum(['set', 'remove', 'list', 'gate']).describe("set | remove | list | gate (DG-4 gate-trust grant)"),
      githubUserId: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('The member (numeric GitHub id — matches hive_members.github_user_id). Required for set/remove.'),
      tier: z
        .enum(['observe', 'message', 'wake', 'steer'])
        .optional()
        .describe("Required for action:'set'."),
      note: softText(LIMITS.ANNOTATION).optional().describe('Optional human note (set only).'),
      expiresAtMs: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Optional expiry (epoch ms) — an expired override decays to the policy default.'),
      granted: z
        .boolean()
        .optional()
        .describe("action:'gate' only: true = this member's gate verdicts count toward green(S); false = revoke."),
    })
    .refine((a) => a.action === 'list' || Boolean(a.githubUserId), {
      message: 'set/remove/gate need `githubUserId`',
    })
    .refine((a) => a.action !== 'set' || Boolean(a.tier), {
      message: "action:'set' needs `tier`",
    })
    .refine((a) => a.action !== 'gate' || typeof a.granted === 'boolean', {
      message: "action:'gate' needs `granted`",
    }),
  async handler(args, ctx) {
    const { activeWorkspaceId } = await import('../../workspace-registry');
    const { listCommsTrust, setCommsTrust, removeCommsTrust, setGateTrust } = await import('../../trust/comms-trust');
    const principalWs = ctx?.principal?.workspaceId;
    const ws = principalWs && principalWs !== '*' ? principalWs : activeWorkspaceId();
    const actor = ctx?.principal?.slug ?? 'agent';
    let payload: Record<string, unknown>;
    if (args.action === 'list') {
      payload = { ok: true, workspaceId: ws, entries: await listCommsTrust(ws) };
    } else if (args.action === 'set') {
      const entry = await setCommsTrust(ws, {
        githubUserId: args.githubUserId!,
        tier: args.tier!,
        note: clampText(args.note, LIMITS.ANNOTATION) ?? null,
        expiresAtMs: args.expiresAtMs ?? null,
        actor,
        nowMs: Date.now(),
      });
      payload = { ok: true, workspaceId: ws, entry };
    } else if (args.action === 'gate') {
      const entry = await setGateTrust(ws, {
        githubUserId: args.githubUserId!,
        granted: args.granted!,
        note: clampText(args.note, LIMITS.ANNOTATION) ?? null,
        expiresAtMs: args.expiresAtMs ?? null,
        actor,
        nowMs: Date.now(),
      });
      payload = { ok: true, workspaceId: ws, entry };
    } else {
      const r = await removeCommsTrust(ws, args.githubUserId!, actor);
      payload = { ok: true, workspaceId: ws, removed: r.removed };
    }
    return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }] };
  },
});
