/**
 * autonomy:decide — the Queen autonomy decider gate, as a tool
 * (queen-autonomy-policy-2026-06-13 B-12 / P-070; closes queen-autonomous-execution
 * P-013, the shared decider seam).
 *
 * Given an action (the MCP tool/verb it uses) + its risk/authority/reversibility,
 * returns the D-004 verdict: `auto` → the Queen may decide it WITHOUT asking, or
 * `gated` → it routes to the owner Queue. The verdict resolves the action's
 * category (B-04), reads that category's effective ceiling from the policy store
 * (B-03), and checks the arming flag (P-092) — then runs the pure gate
 * (lib/autonomy/decider.ts). BEHAVIOR-NEUTRAL until armed: every call returns
 * `gated` while `papercusp-queen-autonomy-armed` is OFF (D-007).
 *
 * This is the gate the dark Queen-decider persona consults per ranked queue item
 * (frontier P-045 / FB-19) and the seam B-13's ledger + B-16's tripwire/graduation
 * + B-17's question-ladder consume — they do not fork the gate.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { COORD_ROLES } from '../coordination/roles';
import { RISK_TIERS, AUTHORITY_LEVELS } from '@papercusp/plan-parser';

export default defineTool({
  name: 'autonomy:decide',
  profile: 'engineer',
  // Resolves the workspace-scoped policy via the admin handle, scoping by the
  // resolved workspace id — so an unscoped operator/SU/Queen session can call it.
  crossWorkspace: true,
  description:
    'The Queen autonomy gate (D-004): given an action + its risk/authority/reversibility, returns auto (the Queen may decide it without asking) or gated (routes to the owner Queue), with the category, effective ceiling, and the reasons. Behavior-neutral (always gated) until the owner arms the policy (P-092).',
  capability: 'intel:read',
  guidance: {
    when: "You are the Queen (or a bee) deciding whether to auto-handle a queue item / answer a card without the owner. Pass the action's tool name (group:verb) + the item's risk_tier / reversibility; the gate tells you auto vs the owner Queue and why.",
    notWhen:
      'To READ or render the whole policy use autonomy:policy_get. To CHANGE a ceiling use autonomy:policy_set (owner-authority). This tool DECIDES one action; it never mutates.',
    chaining:
      'hive:survey / improvements:digest → autonomy:decide per item → place/auto-handle the `auto` ones, route the `gated` ones to the owner Queue.',
  },
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    action: z
      .string()
      .min(1)
      .describe('The MCP tool/verb the action would use (group:verb, e.g. "scout:grade-idea") — keys the category.'),
    capability: z
      .string()
      .optional()
      .describe('The action\'s coarse RBAC capability string — last-resort category fallback only.'),
    riskTier: z
      .enum([...RISK_TIERS] as [string, ...string[]])
      .optional()
      .describe('The item\'s graded risk. Omit ⇒ fail-safe critical.'),
    authority: z
      .enum([...AUTHORITY_LEVELS] as [string, ...string[]])
      .optional()
      .describe('Decision authority. "owner" always gates. Default "system".'),
    reversibility: z
      .enum(['reversible', 'irreversible', 'unknown'])
      .optional()
      .describe('Reversibility of the action. Omit/"unknown" ⇒ fail-safe irreversible.'),
  }),
  async handler(args, ctx) {
    const { getOrgPg } = await import('@papercusp/db-org');
    const { activeWorkspaceId } = await import('../../workspace-registry');
    const { resolveAutonomyDecision, defaultDeciderDeps } = await import('../../autonomy/decider');

    const principalWs = ctx?.principal?.workspaceId;
    const ws = principalWs && principalWs !== '*' ? principalWs : activeWorkspaceId();
    const { sql } = getOrgPg();

    const decision = await resolveAutonomyDecision(
      {
        action: args.action,
        ...(args.capability !== undefined ? { capability: args.capability } : {}),
        ...(args.riskTier !== undefined ? { riskTier: args.riskTier as never } : {}),
        ...(args.authority !== undefined ? { authority: args.authority as never } : {}),
        ...(args.reversibility !== undefined ? { reversibility: args.reversibility as never } : {}),
      },
      defaultDeciderDeps(sql, ws),
    );

    return {
      content: [
        { type: 'text', text: JSON.stringify({ ok: true, workspaceId: ws, decision }, null, 2) },
      ],
    };
  },
});
