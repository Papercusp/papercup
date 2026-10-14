/**
 * policy.test.ts — the governance:policy TOOL (papercusp-enterprise-readiness-roadmap-2026-10-09
 * P-005, WI-10007900). The operations themselves are pinned in governance-policy/control.test.ts;
 * this pins the DOOR: the anti-lockout name, the write-role gate, workspace defaulting,
 * request normalization and actor attribution.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../governance-policy/control', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../governance-policy/control')>();
  return {
    ...real,
    getGovernancePolicyState: vi.fn(async (workspaceId: string) => ({ workspaceId, load: 'none' })),
    explainGovernancePolicy: vi.fn(async (workspaceId: string, request: unknown) => ({ workspaceId, request })),
    simulateGovernancePolicy: vi.fn(async () => ({ cases: [] })),
    setGovernancePolicyLayer: vi.fn(async () => ({ ok: true, revision: 'ws-a@v1' })),
    addGovernancePolicyException: vi.fn(async () => ({ ok: true, revision: 'org-a@v2' })),
  };
});

import {
  addGovernancePolicyException,
  explainGovernancePolicy,
  getGovernancePolicyState,
  setGovernancePolicyLayer,
} from '../../governance-policy/control';
import { GOVERNANCE_ADMIN_TOOLS } from '../../governance-policy/enforce';

const tool = (await import('./policy')).default;

type Out = { content: { text: string }[] };
const body = (o: unknown) => JSON.parse((o as Out).content[0]!.text);
const call = (args: unknown, ctx: Record<string, unknown>) => tool.handler(args as never, ctx as never);

const LAYER = {
  layerId: 'ws-a',
  level: 'workspace' as const,
  scopeRef: 'papercusp-workspace',
  parentLayerId: 'org-a',
  rules: { tools: { deny: ['capability:bash'] } },
};

beforeEach(() => vi.clearAllMocks());

describe('governance:policy tool', () => {
  it('its name is exactly the one the enforcement seat exempts (anti-lockout drift guard)', () => {
    expect(GOVERNANCE_ADMIN_TOOLS.has(tool.name)).toBe(true);
  });

  it('set and add-exception refuse a role without operator-config write, and write nothing', async () => {
    await expect(call({ op: 'set', ...LAYER, reason: 'x' }, { role: 'worker', ownerId: 'w-1' })).rejects.toThrow(
      /requires operator/,
    );
    await expect(
      call(
        { op: 'add-exception', layerId: 'org-a', reason: 'x', exception: { category: 'tools', pattern: 'x', reason: 'y', expiresAt: '2026-10-20T00:00:00Z' } },
        { role: 'worker' },
      ),
    ).rejects.toThrow(/requires operator/);
    expect(setGovernancePolicyLayer).not.toHaveBeenCalled();
    expect(addGovernancePolicyException).not.toHaveBeenCalled();
  });

  it('set attributes the write to the calling owner and passes no op field through', async () => {
    const b = body(await call({ op: 'set', ...LAYER, reason: 'tighten', expectedVersion: 0 }, { role: 'operator', ownerId: 'su-1' }));
    expect(b).toEqual({ ok: true, revision: 'ws-a@v1' });
    const [req, actor] = vi.mocked(setGovernancePolicyLayer).mock.calls[0]!;
    expect(actor).toBe('su-1');
    expect(req).not.toHaveProperty('op');
    expect(req).toMatchObject({ layerId: 'ws-a', reason: 'tighten', expectedVersion: 0 });
  });

  it('get defaults to the session workspace; an explicit workspaceId wins', async () => {
    await call({ op: 'get' }, { role: 'su', workspaceId: 'ws-session' });
    await call({ op: 'get', workspaceId: 'ws-explicit' }, { role: 'su', workspaceId: 'ws-session' });
    expect(vi.mocked(getGovernancePolicyState).mock.calls.map((c) => c[0])).toEqual(['ws-session', 'ws-explicit']);
  });

  it('read ops refuse when there is no workspace to judge', async () => {
    await expect(call({ op: 'get' }, { role: 'su' })).rejects.toThrow(/pass workspaceId/);
  });

  it('explain normalizes the request (trims, drops blanks) before judging', async () => {
    await call({ op: 'explain', request: { tools: [' coord:send ', ''] } }, { role: 'su', workspaceId: 'w' });
    expect(vi.mocked(explainGovernancePolicy).mock.calls[0]!.slice(0, 2)).toEqual(['w', { tools: ['coord:send'] }]);
  });
});
