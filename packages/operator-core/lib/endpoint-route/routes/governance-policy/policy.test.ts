import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../workspace-registry', () => ({ activeWorkspaceId: () => 'ws-active' }));
vi.mock('../../../governance-policy/control', async (importOriginal) => {
  // Keep the real schemas and request parser; only the operations are replaced.
  const original = await importOriginal<typeof import('../../../governance-policy/control')>();
  return {
    ...original,
    explainGovernancePolicy: vi.fn(),
    simulateGovernancePolicy: vi.fn(),
    setGovernancePolicyLayer: vi.fn(),
    addGovernancePolicyException: vi.fn(),
  };
});

import {
  addGovernancePolicyException,
  explainGovernancePolicy,
  setGovernancePolicyLayer,
  simulateGovernancePolicy,
} from '../../../governance-policy/control';
import routes from './policy';

const [explainRoute, simulateRoute, setRoute, addExceptionRoute] = routes;

function ctxFor(input: Record<string, unknown>, slug: string | null = 'tester') {
  return { input, principal: slug ? { slug } : null } as never;
}

async function call(route: (typeof routes)[number], input: Record<string, unknown>, slug?: string | null) {
  const res = (await route.handler(new Request('http://127.0.0.1/api/governance-policy'), ctxFor(input, slug))) as Response;
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
  vi.mocked(explainGovernancePolicy).mockReset();
  vi.mocked(simulateGovernancePolicy).mockReset();
  vi.mocked(setGovernancePolicyLayer).mockReset();
  vi.mocked(addGovernancePolicyException).mockReset();
});

describe('/api/governance-policy/* — the admin pane doors (P-005)', () => {
  it('declares four loopback POST doors at the documented paths', () => {
    expect(routes.map((r) => [r.method, r.path, r.auth])).toEqual([
      ['POST', '/governance-policy/explain', 'loopback'],
      ['POST', '/governance-policy/simulate', 'loopback'],
      ['POST', '/governance-policy/set', 'loopback'],
      ['POST', '/governance-policy/add-exception', 'loopback'],
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
    for (const [code, status] of [['invalid', 400], ['parent', 400], ['conflict', 409], ['unavailable', 503]] as const) {
      vi.mocked(setGovernancePolicyLayer).mockResolvedValueOnce({ ok: false, code, error: code });
      const out = await call(setRoute, { ...LAYER, reason: 'r' }, null);
      expect(out).toMatchObject({ status, body: { ok: false, code } });
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
