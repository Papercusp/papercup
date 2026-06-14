import { describe, it, expect, beforeEach, vi } from 'vitest';
import recordTool from './record_disposition';
import { resolveAutonomyDecision, defaultDeciderDeps } from '../../autonomy/decider';
import { recordDecisionDisposition } from '../../decision-ledger/disposition';
import { activeWorkspaceId } from '../../workspace-registry';

// PG-free unit: the decider + the ledger writer have their own suites; this pins
// the TOOL — re-resolving the SAME gate as autonomy:decide (no fork), the
// conditional links assembly (itemRef / actionLedgerId / researchTaskId / run /
// spawn), and the disposition row write (B-13 / P-111).
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, getOrgPg: () => ({ sql: {} }) };
});
vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: vi.fn(() => 'ws-active') }));
vi.mock('../../autonomy/decider', () => ({
  resolveAutonomyDecision: vi.fn(),
  defaultDeciderDeps: vi.fn(),
}));
// Partial mock: keep the real DISPOSITIONS const (the zod enum needs it at module
// load), mock only the writer.
vi.mock('../../decision-ledger/disposition', async (orig) => {
  const actual = (await orig()) as typeof import('../../decision-ledger/disposition');
  return { ...actual, recordDecisionDisposition: vi.fn() };
});

const mockResolve = vi.mocked(resolveAutonomyDecision);
const mockDeps = vi.mocked(defaultDeciderDeps);
const mockRecord = vi.mocked(recordDecisionDisposition);
const mockActiveWs = vi.mocked(activeWorkspaceId);

const DECISION = { verdict: 'gated', category: 'plan-governance', reasons: ['armed=off'] };

function callTool(args: Record<string, unknown>, ctx: Record<string, unknown> = {}) {
  return (
    recordTool as unknown as {
      handler: (a: unknown, c: unknown) => Promise<{ content: Array<{ text: string }> }>;
    }
  ).handler(args, ctx);
}

describe('autonomy:record_disposition tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockActiveWs.mockReturnValue('ws-active');
    mockDeps.mockReturnValue({ sentinel: 'deps' } as unknown as ReturnType<typeof defaultDeciderDeps>);
    mockResolve.mockResolvedValue(DECISION as unknown as Awaited<ReturnType<typeof resolveAutonomyDecision>>);
    mockRecord.mockResolvedValue(4242 as Awaited<ReturnType<typeof recordDecisionDisposition>>);
  });

  it('re-resolves the gate from the action axes (the same inputs as autonomy:decide)', async () => {
    await callTool({ action: 'plans:add-item', disposition: 'defer', riskTier: 'low' });
    expect(mockResolve).toHaveBeenCalledWith({ action: 'plans:add-item', riskTier: 'low' }, { sentinel: 'deps' });
  });

  it('writes a disposition row carrying the decision, workspace, harness, and actor context', async () => {
    await callTool(
      { action: 'plans:add-item', disposition: 'reject', why: 'duplicate of P-001' },
      { principal: { workspaceId: 'ws-prin', slug: 'queen' }, harnessSlug: 'papercup', role: 'operator', transport: 'mcp' },
    );
    expect(mockRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'ws-prin',
        harnessSlug: 'papercup',
        decision: DECISION,
        disposition: 'reject',
        why: 'duplicate of P-001',
        actorRole: 'operator',
        actorPrincipal: 'queen',
        transport: 'mcp',
      }),
    );
  });

  it('assembles only the provided links (and the run/spawn ids from ctx)', async () => {
    await callTool(
      { action: 'plans:add-item', disposition: 'route-to-research', researchTaskId: 'WI-9', itemRef: 'F-3' },
      { runId: 'r1', spawnId: 's1' },
    );
    const arg = mockRecord.mock.calls[0][0] as { links?: Record<string, unknown> };
    expect(arg.links).toEqual({ itemRef: 'F-3', researchTaskId: 'WI-9', runId: 'r1', spawnId: 's1' });
  });

  it('omits links entirely when none are provided', async () => {
    await callTool({ action: 'x', disposition: 'no-op' }, {});
    const arg = mockRecord.mock.calls[0][0] as { links?: Record<string, unknown> };
    expect(arg.links).toBeUndefined();
  });

  it('returns { ok, workspaceId, ledgerId, disposition, decision }', async () => {
    const res = await callTool({ action: 'x', disposition: 'act' }, { principal: { workspaceId: 'ws-prin' } });
    const body = JSON.parse(res.content[0].text);
    expect(body).toEqual({ ok: true, workspaceId: 'ws-prin', ledgerId: 4242, disposition: 'act', decision: DECISION });
  });
});
