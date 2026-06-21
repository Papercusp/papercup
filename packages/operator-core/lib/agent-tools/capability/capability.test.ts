/**
 * capability.test.ts — capability:grant_role / capability:revoke_role (live-configurability-audit P-008).
 *
 * Pins the SECURITY-critical tool logic. Uses the REAL protected-floor matcher (capability-envelope
 * policy); mocks the flag, the granter's caps (loadRoleCapabilities), the grant store, and the
 * control harness. Asserts the D-007 constraints hold:
 *   • dark (flag off) → refuse · operator-authority gate · protected-floor caps rejected (D-007a) ·
 *     cannot grant above the granter's envelope (D-007b) · happy grant · dryRun no-write · revoke.
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/capability/capability.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getFlagMock } = vi.hoisted(() => ({ getFlagMock: vi.fn(async () => true) }));
vi.mock('@papercusp/flags/server', async (orig) => ({ ...(await orig<Record<string, unknown>>()), getFlag: getFlagMock }));
vi.mock('@papercusp/db-org', async (orig) => ({ ...(await orig<Record<string, unknown>>()), getOrgPg: () => ({ sql: {} }) }));
vi.mock('../../workspace-registry', async (orig) => ({ ...(await orig<Record<string, unknown>>()), activeWorkspaceId: () => 'default' }));
vi.mock('../../endpoint-route/routes/transport/role-principal-caps', () => ({
  loadRoleCapabilities: vi.fn(async () => new Set<string>(['plans:write', 'harness:read'])),
}));
vi.mock('../../role-capability-grants', () => ({
  readGrants: vi.fn(async () => [] as string[]),
  grantCaps: vi.fn(async (_r: string, add: string[]) => [...add]),
  revokeCaps: vi.fn(async () => [] as string[]),
  writeGrants: vi.fn(async () => [] as string[]),
}));
vi.mock('../../gateway-control/control-harness', () => ({
  runControlMutation: vi.fn(async (spec: any, opts: any = {}) => {
    const prev = await spec.capturePrev();
    if (opts.dryRun) return { dryRun: true, applied: false, prev, preview: spec.describe?.(prev) };
    const next = await spec.apply();
    const verify = spec.verify ? await spec.verify(next) : undefined;
    return { dryRun: false, applied: true, prev, next, verify, auditId: 'aud-1' };
  }),
}));

import { loadRoleCapabilities } from '../../endpoint-route/routes/transport/role-principal-caps';
import { grantCaps, revokeCaps } from '../../role-capability-grants';
const loadM = vi.mocked(loadRoleCapabilities);
const grantM = vi.mocked(grantCaps);
const revokeM = vi.mocked(revokeCaps);

const grantTool = (await import('./grant-role')).default;
const revokeTool = (await import('./revoke-role')).default;

type Out = { content: { text: string }[] };
const body = (o: unknown) => JSON.parse((o as Out).content[0]!.text);

beforeEach(() => {
  vi.clearAllMocks();
  getFlagMock.mockResolvedValue(true);
  loadM.mockResolvedValue(new Set(['plans:write', 'harness:read']));
  grantM.mockImplementation(async (_r: string, add: string[]) => [...add]);
  revokeM.mockResolvedValue([]);
});

describe('capability:grant_role', () => {
  it('refuses while dark (flag off)', async () => {
    getFlagMock.mockResolvedValue(false);
    await expect(
      grantTool.handler({ role: 'planner', capabilities: ['plans:write'] } as never, { role: 'operator' } as never),
    ).rejects.toThrow(/dark/i);
    expect(grantM).not.toHaveBeenCalled();
  });

  it('is operator-authority gated', async () => {
    await expect(
      grantTool.handler({ role: 'planner', capabilities: ['plans:write'] } as never, { role: 'bee' } as never),
    ).rejects.toThrow(/operator, architect, or queen/i);
  });

  it('rejects protected-floor caps — D-007a (real matcher)', async () => {
    await expect(
      grantTool.handler({ role: 'planner', capabilities: ['secrets:read'] } as never, { role: 'operator' } as never),
    ).rejects.toThrow(/protected-floor/i);
    await expect(
      grantTool.handler({ role: 'planner', capabilities: ['processes:kill'] } as never, { role: 'operator' } as never),
    ).rejects.toThrow(/protected-floor/i);
    expect(grantM).not.toHaveBeenCalled();
  });

  it('rejects granting above the granter envelope — D-007b', async () => {
    // granter holds plans:write + harness:read; harness:write is NOT held → rejected.
    await expect(
      grantTool.handler(
        { role: 'planner', capabilities: ['plans:write', 'harness:write'] } as never,
        { role: 'operator' } as never,
      ),
    ).rejects.toThrow(/do not hold/i);
    expect(grantM).not.toHaveBeenCalled();
  });

  it('grants a cap the granter holds', async () => {
    const b = body(
      await grantTool.handler({ role: 'planner', capabilities: ['plans:write'] } as never, { role: 'operator' } as never),
    );
    expect(grantM).toHaveBeenCalledWith('planner', ['plans:write']);
    expect(b).toMatchObject({ ok: true, applied: true, role: 'planner', verify: { ok: true } });
  });

  it('dryRun does not grant', async () => {
    const b = body(
      await grantTool.handler(
        { role: 'planner', capabilities: ['plans:write'], dryRun: true } as never,
        { role: 'operator' } as never,
      ),
    );
    expect(grantM).not.toHaveBeenCalled();
    expect(b).toMatchObject({ dryRun: true, applied: false });
  });
});

describe('capability:revoke_role', () => {
  it('refuses while dark', async () => {
    getFlagMock.mockResolvedValue(false);
    await expect(
      revokeTool.handler({ role: 'planner', capabilities: ['plans:write'] } as never, { role: 'operator' } as never),
    ).rejects.toThrow(/dark/i);
  });

  it('is operator-authority gated', async () => {
    await expect(
      revokeTool.handler({ role: 'planner', capabilities: ['plans:write'] } as never, { role: 'bee' } as never),
    ).rejects.toThrow(/operator, architect, or queen/i);
  });

  it('revokes caps from the grant store', async () => {
    const b = body(
      await revokeTool.handler({ role: 'planner', capabilities: ['plans:write'] } as never, { role: 'operator' } as never),
    );
    expect(revokeM).toHaveBeenCalledWith('planner', ['plans:write']);
    expect(b).toMatchObject({ ok: true, applied: true });
  });
});
