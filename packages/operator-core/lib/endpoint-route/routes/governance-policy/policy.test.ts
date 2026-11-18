import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../governance-policy/host-authority-bindings', async importOriginal => ({
  ...await importOriginal<typeof import('../../../governance-policy/host-authority-bindings')>(),
  enrollHostAuthorityBinding: vi.fn(),
}));

vi.mock('../../../workspace-registry', () => ({ activeWorkspaceId: () => 'ws-active' }));
vi.mock('../../../governance-policy/sensitive-action', async importOriginal => ({
  ...await importOriginal<typeof import('../../../governance-policy/sensitive-action')>(),
  getSensitiveAction: vi.fn(),
}));
vi.mock('../../../blind-review-continuation-custody', () => ({
  decideLegacyAdoption: vi.fn(), reserveLegacyAdoption: vi.fn(),
  retainLegacyAdoptionHuman: vi.fn(), validateLegacyAdoptionRequest: vi.fn(),
}));
vi.mock('../../../governance-policy/control', async (importOriginal) => {
  // Keep the real schemas and request parser; only the operations are replaced.
  const original = await importOriginal<typeof import('../../../governance-policy/control')>();
  return {
    ...original,
    explainGovernancePolicy: vi.fn(),
    simulateGovernancePolicy: vi.fn(),
    setGovernancePolicyLayer: vi.fn(),
    addGovernancePolicyException: vi.fn(),
    prepareGovernancePolicyChange: vi.fn(),
    decideGovernancePolicyChange: vi.fn(),
    applyGovernancePolicyChange: vi.fn(),
    delegateGovernanceAuthority: vi.fn(),
    revokeGovernanceAuthority: vi.fn(),
    readGovernanceAuthority: vi.fn(),
  };
});

import {
  addGovernancePolicyException,
  applyGovernancePolicyChange,
  decideGovernancePolicyChange,
  delegateGovernanceAuthority,
  explainGovernancePolicy,
  prepareGovernancePolicyChange,
  readGovernanceAuthority,
  revokeGovernanceAuthority,
  setGovernancePolicyLayer,
  simulateGovernancePolicy,
} from '../../../governance-policy/control';
import { getSensitiveAction, LEGACY_ADOPTION_ACTION, SensitiveActionError,
  type SensitiveActionErrorCode } from '../../../governance-policy/sensitive-action';
import { decideLegacyAdoption, reserveLegacyAdoption, retainLegacyAdoptionHuman,
  validateLegacyAdoptionRequest } from '../../../blind-review-continuation-custody';
import routes, { GOVERNANCE_POLICY_CHANGE_STATUS } from './policy';
import { enrollHostAuthorityBinding, HostAuthorityEnrollmentError } from '../../../governance-policy/host-authority-bindings';

// Partial fixtures cast to the mocked functions' REAL return types instead of
// `as never`, so a changed field type still fails here at compile time
// (see testing/typed-mock.ts and check-mock-cast-escape.mjs).
type StoredAction = NonNullable<Awaited<ReturnType<typeof getSensitiveAction>>>;
type LegacyBinding = ReturnType<typeof validateLegacyAdoptionRequest>;
type LegacyDecision = Awaited<ReturnType<typeof decideLegacyAdoption>>;
type LegacyReservation = Awaited<ReturnType<typeof reserveLegacyAdoption>>;

const [explainRoute, simulateRoute, setRoute, addExceptionRoute, prepareRoute, decideRoute, applyRoute, delegateRoute, revokeRoute, authorityRoute] =
  routes;

const FORBIDDEN_REFUSAL = {
  observed: { authorization: 'not satisfied' },
  liftsWhen: 'the actor has the required governance authority for the target layer',
  whoCanMakeItTrue: ['owner', 'host'],
} as const;

function ctxFor(input: Record<string, unknown>, slug: string | null = 'tester') {
  return { input, principal: slug ? { slug } : null } as never;
}

async function call(route: (typeof routes)[number], input: Record<string, unknown>, slug?: string | null,
  headers?: HeadersInit) {
  const res = (await route.handler(new Request('http://127.0.0.1/api/governance-policy', { headers }), ctxFor(input, slug))) as Response;
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const LAYER = {
  layerId: 'ws-a',
  level: 'workspace',
  scopeRef: 'ws-a',
  parentLayerId: 'dept-eng',
  rules: { tools: { deny: ['plans:*'] } },
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getSensitiveAction).mockResolvedValue({ requestId: 'sar-1', actionKind: 'governance-policy-change' } as StoredAction);
  vi.mocked(explainGovernancePolicy).mockReset();
  vi.mocked(simulateGovernancePolicy).mockReset();
  vi.mocked(setGovernancePolicyLayer).mockReset();
  vi.mocked(addGovernancePolicyException).mockReset();
});

describe('explicit host enrollment HTTP door', () => {
  const route = routes.find(route => route.path === '/governance-policy/enroll-authority')!;
  const input = { kind: 'platform', subjectId: 'floor', reason: 'explicit ownership' };
  it('uses the actual request credentials and server workspace, never the admin actor label', async () => {
    vi.mocked(enrollHostAuthorityBinding).mockResolvedValue({ status: 'enrolled', binding: {
      kind: 'platform', subjectId: 'floor', humanOwnerId: 'actual-human',
      requestPrincipalRevision: 'a'.repeat(64), reason: input.reason, recordedAt: '2030-01-01T00:00:00.000000Z',
    } });
    const res = await route.handler(new Request('http://127.0.0.1/api/governance-policy/enroll-authority', {
      method: 'POST', headers: { cookie: 'actual-cookie=retained' }, body: JSON.stringify(input),
    }), ctxFor({}, 'forged-admin')) as Response;
    expect(res.status).toBe(200);
    const [headers, workspace, received] = vi.mocked(enrollHostAuthorityBinding).mock.calls[0]!;
    expect(headers.get('cookie')).toBe('actual-cookie=retained');
    expect(workspace).toBe('ws-active');
    expect(received).toEqual(input);
    expect(await res.json()).toMatchObject({ ok: true, status: 'enrolled', binding: { humanOwnerId: 'actual-human' } });
  });

  it.each([['invalid', 400], ['forbidden', 403], ['conflict', 409]] as const)('preserves %s refusal', async (code, status) => {
    vi.mocked(enrollHostAuthorityBinding).mockRejectedValue(new HostAuthorityEnrollmentError(code, 'refused'));
    const res = await route.handler(new Request('http://127.0.0.1/enroll', { method: 'POST', body: JSON.stringify(input) }), ctxFor({})) as Response;
    expect(res.status).toBe(status);
    expect(await res.json()).toMatchObject({ ok: false, code });
  });

  it('refuses malformed JSON before calling the writer', async () => {
    const res = await route.handler(new Request('http://127.0.0.1/enroll', { method: 'POST', body: '{' }), ctxFor({})) as Response;
    expect(res.status).toBe(400);
    expect(enrollHostAuthorityBinding).not.toHaveBeenCalled();
  });
});

describe('D011 HTTP stored adoption dispatch', () => {
  const stored = { requestId: 'adopt-1', actionKind: LEGACY_ADOPTION_ACTION,
    workspaceId: 'ws-active', payloadHash: 'a'.repeat(64) };

  beforeEach(() => {
    vi.mocked(getSensitiveAction).mockResolvedValue(stored as StoredAction);
    vi.mocked(validateLegacyAdoptionRequest).mockReturnValue({ bindingId: 7 } as LegacyBinding);
    vi.mocked(retainLegacyAdoptionHuman).mockReset();
  });

  it('decide sends actual request headers and stored workspace to the adoption operation', async () => {
    vi.mocked(decideLegacyAdoption).mockResolvedValue(stored as LegacyDecision);
    const decision = { requestId: 'adopt-1', decision: 'approve', reason: 'reviewed' };
    const out = await call(decideRoute, decision, 'forged-admin', { cookie: 'actual-session=1' });
    expect(out).toMatchObject({ status: 200, body: { ok: true, op: 'decide' } });
    const [input, headers] = vi.mocked(decideLegacyAdoption).mock.calls[0]!;
    expect(input).toEqual({ ...decision, workspaceId: 'ws-active' });
    expect(headers.get('cookie')).toBe('actual-session=1');
    expect(decideGovernancePolicyChange).not.toHaveBeenCalled();
  });

  it('apply derives binding from stored payload and retains request credentials rather than the admin label', async () => {
    const principal = vi.fn();
    vi.mocked(retainLegacyAdoptionHuman).mockResolvedValue(principal);
    vi.mocked(reserveLegacyAdoption).mockResolvedValue({ rootId: 9 } as LegacyReservation);
    const out = await call(applyRoute, { requestId: 'adopt-1', bindingId: 999,
      workspaceId: 'forged', actor: 'user:forged' }, 'forged-admin', { cookie: 'actual-session=2' });
    expect(out).toMatchObject({ status: 200, body: { ok: true, adoption: { rootId: 9 } } });
    expect(validateLegacyAdoptionRequest).toHaveBeenCalledWith(stored);
    const [headers, workspace] = vi.mocked(retainLegacyAdoptionHuman).mock.calls[0]!;
    expect(headers.get('cookie')).toBe('actual-session=2');
    expect(workspace).toBe('ws-active');
    expect(reserveLegacyAdoption).toHaveBeenCalledWith({ workspaceId: 'ws-active', bindingId: 7,
      requestId: 'adopt-1', expectedPayloadHash: stored.payloadHash }, principal);
    expect(applyGovernancePolicyChange).not.toHaveBeenCalled();
  });

  it('passes an explicit expected hash through the locked adoption fence', async () => {
    vi.mocked(retainLegacyAdoptionHuman).mockResolvedValue(vi.fn());
    vi.mocked(reserveLegacyAdoption).mockRejectedValue(new SensitiveActionError('payload-mismatch', 'changed'));
    expect(await call(applyRoute, { requestId: 'adopt-1', expectedPayloadHash: 'b'.repeat(64) }))
      .toMatchObject({ status: 409, body: { ok: false, code: 'payload-mismatch' } });
    expect(vi.mocked(reserveLegacyAdoption).mock.calls[0]![0].expectedPayloadHash).toBe('b'.repeat(64));
  });

  it('refuses a bearer/loopback/admin assertion without retained human credentials', async () => {
    vi.mocked(retainLegacyAdoptionHuman).mockRejectedValue(new SensitiveActionError('forbidden', 'cookie required'));
    expect(await call(applyRoute, { requestId: 'adopt-1' }, 'user:forged', { authorization: 'Bearer fixture' }))
      .toMatchObject({ status: 403, body: { ok: false, code: 'forbidden', refusal: expect.any(Object) } });
    expect(reserveLegacyAdoption).not.toHaveBeenCalled();
    expect(applyGovernancePolicyChange).not.toHaveBeenCalled();
  });

  it('does not retry a refused adoption decision through the generic admin operation', async () => {
    vi.mocked(decideLegacyAdoption).mockRejectedValue(new SensitiveActionError('forbidden', 'cookie required'));
    expect(await call(decideRoute, { requestId: 'adopt-1', decision: 'approve', reason: 'r' }, 'forged-admin'))
      .toMatchObject({ status: 403, body: { ok: false, code: 'forbidden' } });
    expect(decideGovernancePolicyChange).not.toHaveBeenCalled();
  });

  it('a caller-supplied adoption discriminator cannot select the adoption executor', async () => {
    vi.mocked(getSensitiveAction).mockResolvedValue({ ...stored, actionKind: 'governance-policy-change' } as StoredAction);
    vi.mocked(applyGovernancePolicyChange).mockResolvedValue({ ok: true, request: {} as never,
      layer: { layerId: 'policy', version: 1 }, revision: 'policy@v1' });
    expect((await call(applyRoute, { requestId: 'adopt-1', actionKind: LEGACY_ADOPTION_ACTION })).status).toBe(200);
    expect(applyGovernancePolicyChange).toHaveBeenCalledOnce();
    expect(retainLegacyAdoptionHuman).not.toHaveBeenCalled();
    expect(reserveLegacyAdoption).not.toHaveBeenCalled();
  });

  it('an unavailable stored discriminator refuses without choosing an executor', async () => {
    vi.mocked(getSensitiveAction).mockRejectedValue(new Error('storage unavailable'));
    expect(await call(applyRoute, { requestId: 'adopt-1' }))
      .toMatchObject({ status: 503, body: { ok: false, code: 'unavailable' } });
    expect(applyGovernancePolicyChange).not.toHaveBeenCalled();
    expect(retainLegacyAdoptionHuman).not.toHaveBeenCalled();
    expect(reserveLegacyAdoption).not.toHaveBeenCalled();
  });

  it.each([decideRoute, applyRoute])('refuses a foreign-workspace adoption before authenticating or effecting it', async route => {
    vi.mocked(getSensitiveAction).mockResolvedValue({ ...stored, workspaceId: 'foreign' } as StoredAction);
    expect((await call(route, { requestId: 'adopt-1', decision: 'approve', reason: 'r' })).status).toBe(403);
    expect(decideLegacyAdoption).not.toHaveBeenCalled();
    expect(retainLegacyAdoptionHuman).not.toHaveBeenCalled();
    expect(reserveLegacyAdoption).not.toHaveBeenCalled();
  });

  it.each([decideRoute, applyRoute])('refuses an absent stored request without generic fallback', async route => {
    vi.mocked(getSensitiveAction).mockResolvedValue(null);
    expect((await call(route, { requestId: 'missing', decision: 'approve', reason: 'r' })).status).toBe(404);
    expect(decideGovernancePolicyChange).not.toHaveBeenCalled();
    expect(applyGovernancePolicyChange).not.toHaveBeenCalled();
    expect(reserveLegacyAdoption).not.toHaveBeenCalled();
  });
});

describe('/api/governance-policy/* — the admin pane doors (P-005)', () => {
  it('declares ten loopback POST doors at the documented paths', () => {
    expect(routes.map((r) => [r.method, r.path, r.auth])).toEqual([
      ['POST', '/governance-policy/explain', 'loopback'],
      ['POST', '/governance-policy/simulate', 'loopback'],
      ['POST', '/governance-policy/set', 'loopback'],
      ['POST', '/governance-policy/add-exception', 'loopback'],
      ['POST', '/governance-policy/prepare', 'loopback'],
      ['POST', '/governance-policy/decide', 'loopback'],
      ['POST', '/governance-policy/apply', 'loopback'],
      ['POST', '/governance-policy/delegate', 'loopback'],
      ['POST', '/governance-policy/revoke-delegation', 'loopback'],
      ['POST', '/governance-policy/authority', 'loopback'],
    ]);
  });

  it('explain defaults to the request-scoped workspace and passes the parsed request', async () => {
    vi.mocked(explainGovernancePolicy).mockResolvedValue({
      workspaceId: 'ws-active',
      governed: true,
      verdict: { allow: true, trace: [] },
      explanation: 'Allowed',
      revision: 'org@v1',
    });
    const out = await call(explainRoute, { request: { tools: [' capability:bash '] } });
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ ok: true, op: 'explain', explanation: 'Allowed' });
    expect(explainGovernancePolicy).toHaveBeenCalledWith('ws-active', { tools: ['capability:bash'] });
  });

  it('explain honours an explicit workspaceId and refuses an unknown category with 400', async () => {
    vi.mocked(explainGovernancePolicy).mockResolvedValue({
      workspaceId: 'ws-b',
      governed: false,
      verdict: { allow: true, trace: [] },
      explanation: 'ungoverned',
      revision: null,
    });
    await call(explainRoute, { workspaceId: 'ws-b', request: { tools: ['x'] } });
    expect(explainGovernancePolicy).toHaveBeenCalledWith('ws-b', { tools: ['x'] });
    const bad = await call(explainRoute, { request: { shells: ['bash'] } });
    expect(bad.status).toBe(400);
    expect(bad.body).toMatchObject({ ok: false, code: 'invalid' });
  });

  it('simulate names the first bad request and never runs the simulation', async () => {
    const out = await call(simulateRoute, { proposed: LAYER, requests: [{ tools: ['a'] }, { tools: [] }] });
    expect(out.status).toBe(400);
    expect(String(out.body.error)).toContain('requests[1]');
    expect(simulateGovernancePolicy).not.toHaveBeenCalled();
  });

  it('set forwards the layer, reason and expectedVersion with the admin actor', async () => {
    vi.mocked(setGovernancePolicyLayer).mockResolvedValue({ ok: true, layer: {} as never, revision: 'ws-a@v2' });
    const out = await call(setRoute, { ...LAYER, reason: 'lock plans', expectedVersion: 1 });
    expect(out).toMatchObject({ status: 200, body: { ok: true, op: 'set', revision: 'ws-a@v2' } });
    expect(setGovernancePolicyLayer).toHaveBeenCalledWith(
      { ...LAYER, reason: 'lock plans', expectedVersion: 1 },
      'admin:tester',
    );
  });

  it('maps write refusals to status codes, so the pane never shows a false success', async () => {
    for (const [code, status] of [['invalid', 400], ['parent', 400], ['conflict', 409], ['unavailable', 503], ['approval-required', 403], ['forbidden', 403]] as const) {
      vi.mocked(setGovernancePolicyLayer).mockResolvedValueOnce(code === 'forbidden'
        ? { ok: false, code, error: code, refusal: FORBIDDEN_REFUSAL }
        : { ok: false, code, error: code });
      const out = await call(setRoute, { ...LAYER, reason: 'r' }, null);
      expect(out).toMatchObject({ status, body: { ok: false, code } });
      if (code === 'forbidden') expect(out.body).toMatchObject({ refusal: FORBIDDEN_REFUSAL });
    }
    expect(vi.mocked(setGovernancePolicyLayer).mock.calls[0]?.[1]).toBe('admin:operator');
  });

  it('add-exception forwards the exception and actor', async () => {
    vi.mocked(addGovernancePolicyException).mockResolvedValue({ ok: true, layer: {} as never, revision: 'org@v2' });
    const exception = { category: 'tools', pattern: 'capability:bash', reason: 'incident', expiresAt: '2026-10-20T00:00:00Z' };
    const out = await call(addExceptionRoute, { layerId: 'org', exception, reason: 'incident', expectedVersion: 1 });
    expect(out).toMatchObject({ status: 200, body: { ok: true, op: 'add-exception' } });
    expect(addGovernancePolicyException).toHaveBeenCalledWith(
      { layerId: 'org', exception, reason: 'incident', expectedVersion: 1 },
      'admin:tester',
    );
  });
});

describe('/api/governance-policy/* — sensitive-change doors (P-006, D-015)', () => {
  const DEPT = { layerId: 'dept-a', level: 'department', scopeRef: 'eng', parentLayerId: 'org', rules: { tools: { deny: ['x'] } } };

  it('prepare parses its simulation requests and records the admin as preparer', async () => {
    vi.mocked(prepareGovernancePolicyChange).mockResolvedValue({ ok: true, request: { requestId: 'sar-1' } as never });
    const out = await call(prepareRoute, { ...DEPT, workspaceId: 'ws-a', reason: 'tighten', requests: [{ tools: [' x '] }], requiredApprovals: 2 });
    expect(out).toMatchObject({ status: 200, body: { ok: true, op: 'prepare', request: { requestId: 'sar-1' } } });
    expect(prepareGovernancePolicyChange).toHaveBeenCalledWith(
      { ...DEPT, workspaceId: 'ws-a', reason: 'tighten', expectedVersion: undefined, requests: [{ tools: ['x'] }], requiredApprovals: 2 },
      'admin:tester',
    );
  });

  it('prepare refuses a bad simulation request with 400 and prepares nothing', async () => {
    const out = await call(prepareRoute, { ...DEPT, workspaceId: 'ws-a', reason: 'r', requests: [{ tools: [] }] });
    expect(out.status).toBe(400);
    expect(String(out.body.error)).toContain('requests[0]');
    expect(prepareGovernancePolicyChange).not.toHaveBeenCalled();
  });

  it('decide, apply, delegate and revoke-delegation forward their input with the admin actor', async () => {
    vi.mocked(decideGovernancePolicyChange).mockResolvedValue({ ok: true, request: {} as never });
    vi.mocked(applyGovernancePolicyChange).mockResolvedValue({ ok: true, request: {} as never, layer: { layerId: 'dept-a', version: 2 }, revision: 'dept-a@v2' });
    vi.mocked(delegateGovernanceAuthority).mockResolvedValue({ ok: true, delegation: {} as never });
    vi.mocked(revokeGovernanceAuthority).mockResolvedValue({ ok: true, delegation: {} as never });
    const decision = { requestId: 'sar-1', decision: 'approve', reason: 'ok' };
    const grant = { principal: 'user:bo', layerId: 'dept-a', capabilities: ['prepare'], reason: 'r', expiresAt: '2026-10-20T00:00:00Z' };
    expect((await call(decideRoute, decision)).body).toMatchObject({ ok: true, op: 'decide' });
    expect((await call(applyRoute, { requestId: 'sar-1' })).body).toMatchObject({ ok: true, op: 'apply', revision: 'dept-a@v2' });
    expect((await call(delegateRoute, grant)).body).toMatchObject({ ok: true, op: 'delegate' });
    expect((await call(revokeRoute, { delegationId: 'd-1', reason: 'left' })).body).toMatchObject({ ok: true, op: 'revoke-delegation' });
    expect(decideGovernancePolicyChange).toHaveBeenCalledWith(decision, 'admin:tester');
    expect(applyGovernancePolicyChange).toHaveBeenCalledWith({ requestId: 'sar-1' }, 'admin:tester');
    expect(delegateGovernanceAuthority).toHaveBeenCalledWith(grant, 'admin:tester');
    expect(revokeGovernanceAuthority).toHaveBeenCalledWith({ delegationId: 'd-1', reason: 'left' }, 'admin:tester');
  });

  it('maps every sensitive-change refusal to a status, so the pane never shows a false success', async () => {
    const expected: Record<SensitiveActionErrorCode, number> = {
      invalid: 400,
      'not-found': 404,
      forbidden: 403,
      'self-approval': 403,
      'already-decided': 409,
      'not-pending': 409,
      'not-approved': 409,
      expired: 409,
      replayed: 409,
      'payload-mismatch': 409,
      stale: 409,
    };
    for (const [code, status] of Object.entries(expected) as [SensitiveActionErrorCode, number][]) {
      expect(GOVERNANCE_POLICY_CHANGE_STATUS[code]).toBe(status);
      vi.mocked(applyGovernancePolicyChange).mockResolvedValueOnce(code === 'forbidden'
        ? { ok: false, code, error: code, refusal: FORBIDDEN_REFUSAL }
        : { ok: false, code, error: code });
      const out = await call(applyRoute, { requestId: 'sar-1' });
      expect(out).toMatchObject({ status, body: { ok: false, op: 'apply', code } });
      if (code === 'forbidden') expect(out.body).toMatchObject({ refusal: FORBIDDEN_REFUSAL });
    }
    vi.mocked(decideGovernancePolicyChange).mockResolvedValueOnce({ ok: false, code: 'self-approval', error: 'no' });
    expect((await call(decideRoute, { requestId: 'sar-1', decision: 'approve', reason: 'r' })).status).toBe(403);
  });

  it('authority reads delegations and open requests, unfiltered unless asked', async () => {
    vi.mocked(readGovernanceAuthority).mockResolvedValue({ delegations: [], requests: [] });
    const out = await call(authorityRoute, {});
    expect(out).toMatchObject({ status: 200, body: { ok: true, op: 'authority', delegations: [], requests: [] } });
    expect(readGovernanceAuthority).toHaveBeenCalledWith({});
  });
});
