/**
 * POST /api/governance-policy/explain        { workspaceId?, request }
 * POST /api/governance-policy/simulate       { workspaceId?, proposed, requests[] }
 * POST /api/governance-policy/set            { layerId, level, scopeRef, parentLayerId, rules, exceptions?, reason, expectedVersion? }
 * POST /api/governance-policy/add-exception  { layerId, exception, reason, expectedVersion? }
 * POST /api/governance-policy/prepare        { ...layer, workspaceId, reason, expectedVersion?, requests?, requiredApprovals? }
 * POST /api/governance-policy/decide         { requestId, decision: approve|deny, reason }
 * POST /api/governance-policy/apply          { requestId, expectedPayloadHash? }
 * POST /api/governance-policy/delegate       { principal, layerId, capabilities[], reason, expiresAt }
 * POST /api/governance-policy/revoke-delegation { delegationId, reason }
 * POST /api/governance-policy/authority      { workspaceId?, layerIds?, status? }
 *
 * The /admin/governance-policy pane's doors (plan papercusp-enterprise-readiness-roadmap-2026-10-09
 * P-005, WI-6554700010011434). The pane READS through the `governancePolicy.state` sync query.
 * P-006 (WI-10007901, D-015) adds the sensitive-change doors: an organization/department change
 * is prepared (server-simulated), approved by a DISTINCT authorized human, then applied once.
 * The pane is the human approver's surface, which is why `decide` and `delegate` exist here and
 * not on the MCP tool (an agent is a service identity and can never approve or delegate).
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
  applyGovernancePolicyChange,
  changeFailure,
  decideGovernancePolicyChange,
  delegateGovernanceAuthority,
  explainGovernancePolicy,
  governancePolicyAddExceptionSchema,
  governancePolicyApplySchema,
  governancePolicyAuthoritySchema,
  governancePolicyDecideSchema,
  governancePolicyDelegateSchema,
  governancePolicyExplainSchema,
  governancePolicyPrepareSchema,
  governancePolicyRevokeDelegationSchema,
  governancePolicySetSchema,
  governancePolicySimulateSchema,
  parseGovernedRequest,
  prepareGovernancePolicyChange,
  readGovernanceAuthority,
  revokeGovernanceAuthority,
  setGovernancePolicyLayer,
  simulateGovernancePolicy,
  type GovernancePolicyChangeCode,
  type GovernancePolicyFailure,
  type GovernancePolicyWriteCode,
  type GovernancePolicyWriteResult,
  type ProposedLayer,
} from '../../../governance-policy/control';
import { getSensitiveAction, LEGACY_ADOPTION_ACTION, SensitiveActionError } from '../../../governance-policy/sensitive-action';
import { decideLegacyAdoption, reserveLegacyAdoption, retainLegacyAdoptionHuman,
  validateLegacyAdoptionRequest } from '../../../blind-review-continuation-custody';
import type { GovernedRequest, PolicyException } from '../../../governance-policy/inherited-policy';
import { enrollHostAuthorityBinding, HostAuthorityEnrollmentError } from '../../../governance-policy/host-authority-bindings';
import { PrincipalCheckError } from '../../../auth/require-principal';

export const GOVERNANCE_POLICY_WRITE_STATUS: Record<GovernancePolicyWriteCode, number> = {
  invalid: 400,
  parent: 400,
  conflict: 409,
  unavailable: 503,
  'approval-required': 403,
  forbidden: 403,
};

/**
 * A sensitive-change refusal's status. 403 = this actor may not (no authority, self-approval, a
 * service identity approving); 404 = no such request/delegation; 409 = the request's STATE refuses
 * it (not yet approved, expired, already applied, or the policy moved since it was simulated).
 */
export const GOVERNANCE_POLICY_CHANGE_STATUS: Record<GovernancePolicyChangeCode, number> = {
  ...GOVERNANCE_POLICY_WRITE_STATUS,
  'not-found': 404,
  'self-approval': 403,
  'already-decided': 409,
  'not-pending': 409,
  'not-approved': 409,
  expired: 409,
  replayed: 409,
  'payload-mismatch': 409,
  stale: 409,
};

export function governancePolicyActor(ctx: { principal?: { slug?: string } | null }): string {
  return `admin:${ctx.principal?.slug ?? 'operator'}`;
}

function writeResponse(op: string, out: GovernancePolicyWriteResult): Response {
  return Response.json({ op, ...out }, { status: out.ok ? 200 : GOVERNANCE_POLICY_WRITE_STATUS[out.code] });
}

function changeResponse<T extends { ok: true }>(op: string, out: T | GovernancePolicyFailure): Response {
  return Response.json({ op, ...out }, { status: out.ok ? 200 : GOVERNANCE_POLICY_CHANGE_STATUS[out.code] });
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

const prepare = defineTool({
  method: 'POST',
  path: '/governance-policy/prepare',
  auth: 'loopback',
  input: governancePolicyPrepareSchema,
  async handler(_req, ctx) {
    const { reason, expectedVersion, workspaceId, requests, requiredApprovals, ...layer } = ctx.input;
    const parsed = parseRequests(requests ?? []);
    if (!parsed.ok) return badRequest('prepare', parsed.error);
    const out = await prepareGovernancePolicyChange(
      { ...(layer as ProposedLayer), reason, expectedVersion, workspaceId, requests: parsed.requests, requiredApprovals },
      governancePolicyActor(ctx),
    );
    return changeResponse('prepare', out);
  },
});

const decide = defineTool({
  method: 'POST',
  path: '/governance-policy/decide',
  auth: 'loopback',
  input: governancePolicyDecideSchema,
  async handler(req, ctx) {
    try {
      // The stored discriminator selects the executor. Neither body fields nor
      // the loopback/admin actor can select the authenticated adoption seam.
      const stored = await getSensitiveAction(ctx.input.requestId);
      if (!stored) throw new SensitiveActionError('not-found', 'sensitive action not found');
      if (stored.actionKind !== LEGACY_ADOPTION_ACTION)
        return changeResponse('decide', await decideGovernancePolicyChange(ctx.input, governancePolicyActor(ctx)));
      if (stored.workspaceId !== activeWorkspaceId())
        throw new SensitiveActionError('forbidden', 'adoption request belongs to another workspace');
      const request = await decideLegacyAdoption({ ...ctx.input, workspaceId: stored.workspaceId }, req.headers);
      return changeResponse('decide', { ok: true, request });
    } catch (error) { return changeResponse('decide', changeFailure(error)); }
  },
});

const apply = defineTool({
  method: 'POST',
  path: '/governance-policy/apply',
  auth: 'loopback',
  input: governancePolicyApplySchema,
  async handler(req, ctx) {
    try {
      const stored = await getSensitiveAction(ctx.input.requestId);
      if (!stored) throw new SensitiveActionError('not-found', 'sensitive action not found');
      if (stored.actionKind !== LEGACY_ADOPTION_ACTION)
        return changeResponse('apply', await applyGovernancePolicyChange(ctx.input, governancePolicyActor(ctx)));
      if (stored.workspaceId !== activeWorkspaceId())
        throw new SensitiveActionError('forbidden', 'adoption request belongs to another workspace');
      const payload = validateLegacyAdoptionRequest(stored);
      const principal = await retainLegacyAdoptionHuman(req.headers, stored.workspaceId);
      const adoption = await reserveLegacyAdoption({ workspaceId: stored.workspaceId,
        bindingId: payload.bindingId, requestId: stored.requestId,
        expectedPayloadHash: ctx.input.expectedPayloadHash ?? stored.payloadHash }, principal);
      return changeResponse('apply', { ok: true, adoption });
    } catch (error) { return changeResponse('apply', changeFailure(error)); }
  },
});

const delegate = defineTool({
  method: 'POST',
  path: '/governance-policy/delegate',
  auth: 'loopback',
  input: governancePolicyDelegateSchema,
  async handler(_req, ctx) {
    return changeResponse('delegate', await delegateGovernanceAuthority(ctx.input, governancePolicyActor(ctx)));
  },
});

const revokeDelegation = defineTool({
  method: 'POST',
  path: '/governance-policy/revoke-delegation',
  auth: 'loopback',
  input: governancePolicyRevokeDelegationSchema,
  async handler(_req, ctx) {
    return changeResponse('revoke-delegation', await revokeGovernanceAuthority(ctx.input, governancePolicyActor(ctx)));
  },
});

const authority = defineTool({
  method: 'POST',
  path: '/governance-policy/authority',
  auth: 'loopback',
  input: governancePolicyAuthoritySchema,
  async handler(_req, ctx) {
    // Unfiltered by default: the approver's queue spans every workspace a change was simulated against.
    const out = await readGovernanceAuthority(ctx.input);
    return Response.json({ ok: true, op: 'authority', ...out });
  },
});

const enrollAuthority = defineTool({
  method: 'POST',
  path: '/governance-policy/enroll-authority',
  auth: 'loopback',
  async handler(req) {
    let input;
    try { input = await req.json(); }
    catch { return badRequest('enroll-authority', 'invalid JSON'); }
    try {
      const out = await enrollHostAuthorityBinding(req.headers, activeWorkspaceId(), input);
      return Response.json({ ok: true, op: 'enroll-authority', ...out });
    } catch (error) {
      if (error instanceof HostAuthorityEnrollmentError)
        return Response.json({ ok: false, op: 'enroll-authority', code: error.code, error: error.message },
          { status: { invalid: 400, forbidden: 403, conflict: 409 }[error.code] });
      if (error instanceof PrincipalCheckError)
        return Response.json({ ok: false, op: 'enroll-authority', code: 'forbidden', error: error.message }, { status: error.status });
      throw error;
    }
  },
});

export default [explain, simulate, set, addException, prepare, decide, apply, delegate, revokeDelegation, authority, enrollAuthority];
