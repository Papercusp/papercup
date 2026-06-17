/**
 * results.test.ts — handler-level tests for experiment:results (G8).
 *
 * PG-free unit: mocks PgExperimentLedger (so listRecent is a spy), activeWorkspaceId,
 * and the dynamic @papercusp/db-org import. Pins the workspace precedence
 * (ctx.workspaceId ?? ctx.principal?.workspaceId ?? activeWorkspaceId()) + the
 * testId/limit passthrough. Idiom mirrors ablation/report.test.ts.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import resultsTool from './results';
import { PgExperimentLedger } from '../../experiment/ledger';
import { activeWorkspaceId } from '../../workspace-registry';

vi.mock('@papercusp/db-org', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, getOrgPg: () => ({ sql: {} }) };
});
vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: vi.fn(() => 'ws-active') }));

// Spy on listRecent across all instances — the tool news up a PgExperimentLedger.
const listRecent = vi.spyOn(PgExperimentLedger.prototype, 'listRecent');
const mockActiveWs = vi.mocked(activeWorkspaceId);

function callTool(args: Record<string, unknown>, ctx: Record<string, unknown> = {}) {
  return (
    resultsTool as unknown as {
      handler: (a: unknown, c: unknown) => Promise<{ content: Array<{ text: string }> }>;
    }
  ).handler(args, ctx);
}

describe('experiment:results tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockActiveWs.mockReturnValue('ws-active');
    listRecent.mockResolvedValue([]);
  });

  it('uses ctx.workspaceId when present (highest precedence)', async () => {
    await callTool({}, { workspaceId: 'ws-ctx', principal: { workspaceId: 'ws-prin' } });
    expect(listRecent).toHaveBeenCalledWith('ws-ctx', expect.anything());
    expect(mockActiveWs).not.toHaveBeenCalled();
  });

  it('falls back to principal.workspaceId when ctx.workspaceId is absent', async () => {
    await callTool({}, { principal: { workspaceId: 'ws-prin' } });
    expect(listRecent).toHaveBeenCalledWith('ws-prin', expect.anything());
    expect(mockActiveWs).not.toHaveBeenCalled();
  });

  it('falls back to activeWorkspaceId() when neither ctx nor principal supplies one', async () => {
    await callTool({}, {});
    expect(listRecent).toHaveBeenCalledWith('ws-active', expect.anything());
    expect(mockActiveWs).toHaveBeenCalled();
  });

  it('passes testId + limit through to listRecent', async () => {
    await callTool({ testId: 'replay', limit: 50 }, {});
    expect(listRecent).toHaveBeenCalledWith('ws-active', { testId: 'replay', limit: 50 });
  });

  it('omits testId/limit (undefined) when not supplied', async () => {
    await callTool({}, {});
    expect(listRecent).toHaveBeenCalledWith('ws-active', { testId: undefined, limit: undefined });
  });

  it('returns the rows newest-first with ok + count envelope', async () => {
    listRecent.mockResolvedValue([
      { batteryId: 'b1', testId: 'replay', tier: 'offline', winner: 'cand', arms: [], totalCostUsd: 0.01, budgetExhausted: false, decision: 'proposed', createdAt: '2026-06-16T00:00:00.000Z' },
    ]);
    const res = await callTool({}, {});
    const body = JSON.parse(res.content[0].text);
    expect(body).toMatchObject({ ok: true, count: 1 });
    expect(body.runs[0]).toMatchObject({ batteryId: 'b1', winner: 'cand' });
  });
});
