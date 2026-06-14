import { describe, it, expect, beforeEach, vi } from 'vitest';
import reportTool from './report';
import { buildDeadWeightReport } from '../../ablation/scoring';
import { listAblationRuns } from '../../ablation/store';
import { activeWorkspaceId } from '../../workspace-registry';
import { resolveAgentIdentity } from '../coordination/identity';

// PG-free unit: the dead-weight scoring + the store read have their own suites;
// this pins the TOOL — the ruleKey drill-down vs the rollup branch, the minRuns /
// limit defaults, the recent-cycle projection (replayLeg boolean), and the
// envelopes (self-learning-frontier P-023 / FB-09).
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, getOrgPg: () => ({ sql: {} }) };
});
vi.mock('../../ablation/scoring', () => ({ buildDeadWeightReport: vi.fn() }));
vi.mock('../../ablation/store', () => ({ listAblationRuns: vi.fn() }));
vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: vi.fn(() => 'ws-active') }));
vi.mock('../coordination/identity', () => ({ resolveAgentIdentity: vi.fn() }));

const mockBuild = vi.mocked(buildDeadWeightReport);
const mockList = vi.mocked(listAblationRuns);
const mockActiveWs = vi.mocked(activeWorkspaceId);
const mockIdentity = vi.mocked(resolveAgentIdentity);

function run(p: Record<string, unknown> = {}) {
  return {
    id: 1,
    finishedAt: '2026-06-10T00:00:00Z',
    ruleKey: 'rule-a',
    ruleHash: 'h',
    ruleExcerpt: 'do the thing',
    verdict: 'dead-weight-candidate',
    passRateDelta: 0,
    scenarioCount: 5,
    capped: false,
    costUsd: 0.1,
    replayLeg: null,
    ...p,
  };
}

function callTool(args: Record<string, unknown>, ctx: Record<string, unknown> = {}) {
  return (
    reportTool as unknown as {
      handler: (a: unknown, c: unknown) => Promise<{ content: Array<{ text: string }> }>;
    }
  ).handler(args, ctx);
}

describe('ablation:report tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIdentity.mockReturnValue({ ownerId: 'su-test' } as ReturnType<typeof resolveAgentIdentity>);
    mockActiveWs.mockReturnValue('ws-active');
    mockBuild.mockReturnValue({ candidates: [], loadBearing: [] } as unknown as ReturnType<typeof buildDeadWeightReport>);
    mockList.mockResolvedValue([] as unknown as Awaited<ReturnType<typeof listAblationRuns>>);
  });

  it('resolves the workspace by precedence', async () => {
    await callTool({}, { principal: { workspaceId: 'ws-prin' } });
    expect(mockList).toHaveBeenCalledWith(expect.anything(), 'ws-prin', expect.anything());
  });

  it('ruleKey drill-down returns that rule\'s rows (default limit 20), no rollup', async () => {
    mockList.mockResolvedValue([run({ id: 7 })] as unknown as Awaited<ReturnType<typeof listAblationRuns>>);
    const res = await callTool({ ruleKey: 'rule-a' });
    expect(mockList).toHaveBeenCalledWith(expect.anything(), 'ws-active', { ruleKey: 'rule-a', limit: 20 });
    expect(mockBuild).not.toHaveBeenCalled();
    const body = JSON.parse(res.content[0].text);
    expect(body).toMatchObject({ workspaceId: 'ws-active', ruleKey: 'rule-a', count: 1 });
  });

  it('rollup reads the full history (limit 1000), scores with minRuns default 2, and projects recent cycles', async () => {
    mockList.mockResolvedValue([
      run({ id: 1, replayLeg: { x: 1 } }),
      run({ id: 2, replayLeg: null }),
    ] as unknown as Awaited<ReturnType<typeof listAblationRuns>>);
    const res = await callTool({});
    expect(mockList).toHaveBeenCalledWith(expect.anything(), 'ws-active', { limit: 1000 });
    expect(mockBuild).toHaveBeenCalledWith(expect.any(Array), { minRuns: 2 });
    const body = JSON.parse(res.content[0].text);
    expect(body.totalCycles).toBe(2);
    // replayLeg projects to a boolean (presence), not the raw object
    expect(body.recentCycles[0]).toMatchObject({ id: 1, replayLeg: true });
    expect(body.recentCycles[1]).toMatchObject({ id: 2, replayLeg: false });
  });

  it('honors minRuns + limit overrides', async () => {
    mockList.mockResolvedValue([run(), run({ id: 2 }), run({ id: 3 })] as unknown as Awaited<
      ReturnType<typeof listAblationRuns>
    >);
    const res = await callTool({ minRuns: 5, limit: 2 });
    expect(mockBuild).toHaveBeenCalledWith(expect.any(Array), { minRuns: 5 });
    const body = JSON.parse(res.content[0].text);
    expect(body.recentCycles).toHaveLength(2); // sliced to limit
  });
});
