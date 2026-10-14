/**
 * POST /api/governance-policy/explain        { workspaceId?, request }
 * POST /api/governance-policy/simulate       { workspaceId?, proposed, requests[] }
 * POST /api/governance-policy/set            { layerId, level, scopeRef, parentLayerId, rules, exceptions?, reason, expectedVersion? }
 * POST /api/governance-policy/add-exception  { layerId, exception, reason, expectedVersion? }
 *
 * The /admin/governance-policy pane's doors (plan papercusp-enterprise-readiness-roadmap-2026-10-09
 * P-005, WI-6554700010011434). The pane READS through the `governancePolicy.state` sync query.
 * Every door runs the SAME operation as the MCP tool `governance:policy`
 * (governance-policy/control.ts), so a pane click and a tool call record the same version row,
 * actor and reason.
 *
 * `auth: 'loopback'` like /work-scope/set: an admin-pane write from the desktop's own content
 * layer. A write refusal answers ok:false with the store's code (invalid / parent 400,
 * conflict 409, unavailable 503), so the pane never shows a green toast for a version that
 * was not recorded.
 */
import { defineTool } from '@papercusp/agent-mcp';
import { activeWorkspaceId } from '../../../workspace-registry';
import {
  addGovernancePolicyException,
  explainGovernancePolicy,
  governancePolicyAddExceptionSchema,
  governancePolicyExplainSchema,
  governancePolicySetSchema,
  governancePolicySimulateSchema,
  parseGovernedRequest,
  setGovernancePolicyLayer,
  simulateGovernancePolicy,
  type GovernancePolicyWriteCode,
  type GovernancePolicyWriteResult,
  type ProposedLayer,
} from '../../../governance-policy/control';
import type { GovernedRequest, PolicyException } from '../../../governance-policy/inherited-policy';

export const GOVERNANCE_POLICY_WRITE_STATUS: Record<GovernancePolicyWriteCode, number> = {
  invalid: 400,
  parent: 400,
  conflict: 409,
  unavailable: 503,
};

export function governancePolicyActor(ctx: { principal?: { slug?: string } | null }): string {
  return `admin:${ctx.principal?.slug ?? 'operator'}`;
}

function writeResponse(op: string, out: GovernancePolicyWriteResult): Response {
  return Response.json({ op, ...out }, { status: out.ok ? 200 : GOVERNANCE_POLICY_WRITE_STATUS[out.code] });
}

function badRequest(op: string, error: string): Response {
  return Response.json({ ok: false, op, code: 'invalid', error }, { status: 400 });
}

/** Parse every request, or name the first bad one. */
function parseRequests(raw: readonly unknown[]): { ok: true; requests: GovernedRequest[] } | { ok: false; error: string } {
  const requests: GovernedRequest[] = [];
  for (const [i, r] of raw.entries()) {
    const parsed = parseGovernedRequest(r);
    if (!parsed.ok) return { ok: false, error: `requests[${i}]: ${parsed.error}` };
    requests.push(parsed.request);
  }
  return { ok: true, requests };
}

const explain = defineTool({
  method: 'POST',
  path: '/governance-policy/explain',
  auth: 'loopback',
  input: governancePolicyExplainSchema,
  async handler(_req, ctx) {
    const parsed = parseGovernedRequest(ctx.input.request);
    if (!parsed.ok) return badRequest('explain', parsed.error);
    const out = await explainGovernancePolicy(ctx.input.workspaceId ?? activeWorkspaceId(), parsed.request);
    return Response.json({ ok: true, op: 'explain', ...out });
  },
});

const simulate = defineTool({
  method: 'POST',
  path: '/governance-policy/simulate',
  auth: 'loopback',
  input: governancePolicySimulateSchema,
  async handler(_req, ctx) {
    const parsed = parseRequests(ctx.input.requests);
    if (!parsed.ok) return badRequest('simulate', parsed.error);
    const out = await simulateGovernancePolicy(
      ctx.input.workspaceId ?? activeWorkspaceId(),
      ctx.input.proposed as ProposedLayer,
      parsed.requests,
    );
    return Response.json({ ok: true, op: 'simulate', ...out });
  },
});

const set = defineTool({
  method: 'POST',
  path: '/governance-policy/set',
  auth: 'loopback',
  input: governancePolicySetSchema,
  async handler(_req, ctx) {
    const { reason, expectedVersion, ...layer } = ctx.input;
    const out = await setGovernancePolicyLayer(
      { ...(layer as ProposedLayer), reason, expectedVersion },
      governancePolicyActor(ctx),
    );
    return writeResponse('set', out);
  },
});

const addException = defineTool({
  method: 'POST',
  path: '/governance-policy/add-exception',
  auth: 'loopback',
  input: governancePolicyAddExceptionSchema,
  async handler(_req, ctx) {
    const { layerId, exception, reason, expectedVersion } = ctx.input;
    const out = await addGovernancePolicyException(
      { layerId, exception: exception as PolicyException, reason, expectedVersion },
      governancePolicyActor(ctx),
    );
    return writeResponse('add-exception', out);
  },
});

export default [explain, simulate, set, addException];
