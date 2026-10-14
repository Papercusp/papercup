/**
 * governance:policy — the MCP door onto inherited organization/department/workspace policy
 * (plan papercusp-enterprise-readiness-roadmap-2026-10-09 P-005, WI-10007900).
 *
 * A THIN wrapper: every op delegates to governance-policy/control.ts, the one implementation
 * the admin pane's routes and sync query also use, so a tool call and a pane click take the
 * same path and record the same version row.
 *
 * The tool name is load-bearing: enforce.ts#GOVERNANCE_ADMIN_TOOLS exempts exactly
 * 'governance:policy' from the policy seat so a bad policy can always be repaired (anti-lockout).
 * Because the seat does not guard it, the WRITE ops gate on the operator-config-write role here.
 */
import { z } from 'zod';
import { defineTool, SU_ROLES, isOperatorConfigWriteRole } from '@papercusp/agent-mcp';
import {
  addGovernancePolicyException,
  explainGovernancePolicy,
  getGovernancePolicyState,
  governancePolicyAddExceptionSchema,
  governancePolicyExplainSchema,
  governancePolicyGetSchema,
  governancePolicySetSchema,
  governancePolicySimulateSchema,
  parseGovernedRequest,
  setGovernancePolicyLayer,
  simulateGovernancePolicy,
} from '../../governance-policy/control';
import type { GovernedRequest } from '../../governance-policy/inherited-policy';

function json(obj: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(obj) }] };
}

function requireRequest(raw: unknown): GovernedRequest {
  const parsed = parseGovernedRequest(raw);
  if (!parsed.ok) throw new Error(`governance:policy: ${parsed.error}`);
  return parsed.request;
}

export default defineTool({
  name: 'governance:policy',
  profile: 'engineer',
  description:
    'Inherited organization > department > workspace policy over models, tools, plugins, egress, dataUse and actions. ' +
    'get = chain + layers + version history; explain = the verdict the enforcement seat would reach for a request, and which layer decided; ' +
    'simulate = before/after verdicts for a proposed layer (writes nothing); set = write a layer version (actor + reason); ' +
    'add-exception = append an expiring exception. A lower layer can never widen an ancestor.',
  capability: 'operator:write',
  guidance: {
    when: 'An action was refused with org_policy:* and you need to know which layer refused it and why (explain), or an admin must change or except a policy.',
    notWhen: 'Work-scope (which repos/paths a session may touch) is work-scope:*, not this.',
    chaining: 'simulate a proposed layer before set; pass expectedVersion from get to avoid overwriting a concurrent edit.',
  },
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  rolesQuota: { operator: { perRun: 40 } },
  args: z.discriminatedUnion('op', [
    governancePolicyGetSchema.extend({ op: z.literal('get') }),
    governancePolicyExplainSchema.extend({ op: z.literal('explain') }),
    governancePolicySimulateSchema.extend({ op: z.literal('simulate') }),
    governancePolicySetSchema.extend({ op: z.literal('set') }),
    governancePolicyAddExceptionSchema.extend({ op: z.literal('add-exception') }),
  ]),
  async handler(args, ctx) {
    if (args.op === 'set' || args.op === 'add-exception') {
      if (!isOperatorConfigWriteRole(ctx.role)) {
        throw new Error(`governance:policy ${args.op} requires operator, architect, or mug role`);
      }
      const actor = ctx.ownerId ?? `role:${ctx.role}`;
      if (args.op === 'set') {
        const { op: _op, ...req } = args;
        return json(await setGovernancePolicyLayer(req, actor));
      }
      const { op: _op, ...req } = args;
      return json(await addGovernancePolicyException(req, actor));
    }

    const workspaceId = args.workspaceId ?? ctx.workspaceId;
    if (!workspaceId) throw new Error('governance:policy: pass workspaceId (this session has no workspace)');

    if (args.op === 'get') {
      return json(await getGovernancePolicyState(workspaceId, { versionLimit: args.versionLimit }));
    }
    if (args.op === 'explain') {
      return json(await explainGovernancePolicy(workspaceId, requireRequest(args.request)));
    }
    return json(await simulateGovernancePolicy(workspaceId, args.proposed, args.requests.map(requireRequest)));
  },
});
