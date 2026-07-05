import { describe, it, expect, beforeEach, vi } from 'vitest';
import summaryTool from './summary';
import { calibrationScores, openBetCounts } from '../../calibration/store';
import { activeWorkspaceId } from '../../workspace-registry';
import { resolveAgentIdentity } from '../coordination/identity';

// PG-free unit: the Brier/trust-weight math lives in calibration/store; this pins
// the TOOL — workspace precedence, the domain/predictor filter pass-through, the
// parallel scores+openBets read, and the { scored, scores, openBets } envelope
// (self-learning-frontier P-041 / FB-13, D-005 Queen-weighting read).
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, getOrgPg: () => ({ sql: {} }) };
});
vi.mock('../../calibration/store', () => ({ calibrationScores: vi.fn(), openBetCounts: vi.fn() }));
vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: vi.fn(() => 'ws-active') }));
vi.mock('../coordination/identity', () => ({ resolveAgentIdentity: vi.fn() }));

const mockScores = vi.mocked(calibrationScores);
const mockOpenBets = vi.mocked(openBetCounts);
const mockActiveWs = vi.mocked(activeWorkspaceId);
const mockIdentity = vi.mocked(resolveAgentIdentity);

function callTool(args: Record<string, unknown>, ctx: Record<string, unknown> = {}) {
  return (
    summaryTool as unknown as {
      handler: (a: unknown, c: unknown) => Promise<{ content: Array<{ text: string }> }>;
    }
  ).handler(args, ctx);
}

describe('calibration:summary tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIdentity.mockReturnValue({ ownerId: 'su-test' } as ReturnType<typeof resolveAgentIdentity>);
    mockActiveWs.mockReturnValue('ws-active');
    mockScores.mockResolvedValue([{ predictor: 'worker', domain: 'fix-survival', weight: 0.6 }] as unknown as Awaited<
      ReturnType<typeof calibrationScores>
    >);
    mockOpenBets.mockResolvedValue({ total: 2 } as unknown as Awaited<ReturnType<typeof openBetCounts>>);
  });

  it('reads scores + open bets in parallel for the active workspace by default', async () => {
    await callTool({});
    expect(mockScores).toHaveBeenCalledWith(expect.anything(), {
      workspaceId: 'ws-active',
      domain: undefined,
      predictor: undefined,
    });
    expect(mockOpenBets).toHaveBeenCalledWith(expect.anything(), { workspaceId: 'ws-active' });
  });

  it('forwards the domain + predictor filters and honors workspace precedence', async () => {
    await callTool({ domain: 'plan-ship', predictor: 'mug' }, { principal: { workspaceId: 'ws-prin' } });
    expect(mockScores).toHaveBeenCalledWith(expect.anything(), {
      workspaceId: 'ws-prin',
      domain: 'plan-ship',
      predictor: 'mug',
    });
  });

  it('returns { workspaceId, scored, scores, openBets }', async () => {
    const res = await callTool({ workspace: 'ws-x' });
    const body = JSON.parse(res.content[0].text);
    expect(body.workspaceId).toBe('ws-x');
    expect(body.scored).toBe(1);
    expect(body.scores).toHaveLength(1);
    expect(body.openBets).toEqual({ total: 2 });
  });
});
