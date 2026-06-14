import { describe, it, expect, beforeEach, vi } from 'vitest';
import gradTool from './graduation_status';
import { readTripwireEvidence } from '../../autonomy/tripwire/store';
import { readAutonomyPolicy } from '../../autonomy/policy-store';
import { effectiveCeiling } from '../../autonomy/policy';
import {
  computeAutonomyStandings,
  computeCategoryGraduationTargets,
  parseGradKey,
} from '../../autonomy/tripwire/graduation';
import { activeWorkspaceId } from '../../workspace-registry';

// PG-free unit: the graduation math has its own suite; this pins the TOOL's
// compose pipeline (evidence → standings → policy → targets), the lookback
// default, the standings projection (parseGradKey split), the ceilings
// decoration, and the envelope (B-16 / P-082).
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, getOrgPg: () => ({ sql: {} }) };
});
vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: vi.fn(() => 'ws-active') }));
vi.mock('../../autonomy/tripwire/store', () => ({ readTripwireEvidence: vi.fn() }));
vi.mock('../../autonomy/policy-store', () => ({ readAutonomyPolicy: vi.fn() }));
vi.mock('../../autonomy/policy', () => ({ effectiveCeiling: vi.fn() }));
vi.mock('../../autonomy/tripwire/graduation', () => ({
  computeAutonomyStandings: vi.fn(),
  computeCategoryGraduationTargets: vi.fn(),
  parseGradKey: vi.fn(),
  DEFAULT_AUTONOMY_GRADUATION_POLICY: { windows: 3 },
}));

const mockEvidence = vi.mocked(readTripwireEvidence);
const mockReadPolicy = vi.mocked(readAutonomyPolicy);
const mockEffective = vi.mocked(effectiveCeiling);
const mockStandings = vi.mocked(computeAutonomyStandings);
const mockTargets = vi.mocked(computeCategoryGraduationTargets);
const mockParse = vi.mocked(parseGradKey);
const mockActiveWs = vi.mocked(activeWorkspaceId);

function callTool(args: Record<string, unknown>, ctx: Record<string, unknown> = {}) {
  return (
    gradTool as unknown as {
      handler: (a: unknown, c: unknown) => Promise<{ content: Array<{ text: string }> }>;
    }
  ).handler(args, ctx);
}

describe('autonomy:graduation_status tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockActiveWs.mockReturnValue('ws-active');
    mockEvidence.mockResolvedValue([] as Awaited<ReturnType<typeof readTripwireEvidence>>);
    mockStandings.mockReturnValue([
      {
        findingClass: 'docs-publish::product',
        cleanStreak: 3,
        totalClean: 5,
        totalRecurred: 0,
        totalDirty: 0,
        pendingWindow: false,
        eligible: true,
        eligibleTier: 'low',
      },
    ] as unknown as ReturnType<typeof computeAutonomyStandings>);
    mockParse.mockReturnValue({ category: 'docs-publish', findingClass: 'product' } as unknown as ReturnType<typeof parseGradKey>);
    mockReadPolicy.mockResolvedValue([
      { category: 'docs-publish', ceiling: 'medium', graduatedLevel: 'low', locked: false },
    ] as unknown as Awaited<ReturnType<typeof readAutonomyPolicy>>);
    mockTargets.mockReturnValue([{ category: 'docs-publish', target: 'low' }] as unknown as ReturnType<
      typeof computeCategoryGraduationTargets
    >);
    mockEffective.mockReturnValue('low' as ReturnType<typeof effectiveCeiling>);
  });

  it('defaults the lookback to 90 days and reads evidence with it', async () => {
    await callTool({});
    expect(mockEvidence).toHaveBeenCalledWith(
      expect.anything(),
      'ws-active',
      expect.objectContaining({ lookbackDays: 90 }),
    );
  });

  it('honors an explicit lookbackDays', async () => {
    await callTool({ lookbackDays: 30 });
    expect(mockEvidence).toHaveBeenCalledWith(expect.anything(), 'ws-active', expect.objectContaining({ lookbackDays: 30 }));
  });

  it('projects standings via parseGradKey and decorates ceilings with effectiveCeiling', async () => {
    const res = await callTool({}, { principal: { workspaceId: 'ws-prin' } });
    const body = JSON.parse(res.content[0].text);
    expect(body.workspaceId).toBe('ws-prin');
    expect(body.standings[0]).toMatchObject({ category: 'docs-publish', findingClass: 'product', cleanStreak: 3, eligible: true });
    expect(body.targets).toEqual([{ category: 'docs-publish', target: 'low' }]);
    expect(body.ceilings[0]).toMatchObject({ category: 'docs-publish', ceiling: 'medium', effectiveCeiling: 'low' });
  });
});
