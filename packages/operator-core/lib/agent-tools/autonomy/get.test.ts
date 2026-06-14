import { describe, it, expect, beforeEach, vi } from 'vitest';
import getTool from './get';
import { isAutonomyCategory } from '../../autonomy/categories';
import { readAutonomyPolicy, getAutonomyCategoryPolicy } from '../../autonomy/policy-store';
import { effectiveCeiling } from '../../autonomy/policy';
import { activeWorkspaceId } from '../../workspace-registry';

// PG-free unit: the policy store + effectiveCeiling have their own suites; this
// pins the TOOL — the unknown-category guard, the single-row vs all-rows branch,
// the derived effectiveCeiling decoration, and the envelope (B-03 / P-022).
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, getOrgPg: () => ({ sql: {} }) };
});
vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: vi.fn(() => 'ws-active') }));
vi.mock('../../autonomy/categories', () => ({ isAutonomyCategory: vi.fn() }));
vi.mock('../../autonomy/policy-store', () => ({
  readAutonomyPolicy: vi.fn(),
  getAutonomyCategoryPolicy: vi.fn(),
}));
vi.mock('../../autonomy/policy', () => ({ effectiveCeiling: vi.fn() }));

const mockIsCat = vi.mocked(isAutonomyCategory);
const mockReadAll = vi.mocked(readAutonomyPolicy);
const mockGetOne = vi.mocked(getAutonomyCategoryPolicy);
const mockEffective = vi.mocked(effectiveCeiling);
const mockActiveWs = vi.mocked(activeWorkspaceId);

function callTool(args: Record<string, unknown>, ctx: Record<string, unknown> = {}) {
  return (
    getTool as unknown as {
      handler: (a: unknown, c: unknown) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
    }
  ).handler(args, ctx);
}

describe('autonomy:policy_get tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockActiveWs.mockReturnValue('ws-active');
    mockIsCat.mockReturnValue(true);
    mockEffective.mockReturnValue('low' as ReturnType<typeof effectiveCeiling>);
    mockGetOne.mockResolvedValue({ category: 'docs-publish', ceiling: 'medium', graduatedLevel: 'low', locked: false } as unknown as Awaited<
      ReturnType<typeof getAutonomyCategoryPolicy>
    >);
    mockReadAll.mockResolvedValue([
      { category: 'docs-publish', ceiling: 'medium' },
      { category: 'system-control', ceiling: 'never-auto' },
    ] as Awaited<ReturnType<typeof readAutonomyPolicy>>);
  });

  it('rejects an unknown category with isError (does not hit the store)', async () => {
    mockIsCat.mockReturnValue(false);
    const res = await callTool({ category: 'not-real' });
    expect(res.isError).toBe(true);
    const body = JSON.parse(res.content[0].text);
    expect(body).toMatchObject({ ok: false, reason: 'unknown_category', category: 'not-real' });
    expect(mockGetOne).not.toHaveBeenCalled();
  });

  it('returns the single category policy decorated with effectiveCeiling', async () => {
    const res = await callTool({ category: 'docs-publish' }, { principal: { workspaceId: 'ws-prin' } });
    expect(mockGetOne).toHaveBeenCalledWith(expect.anything(), 'ws-prin', 'docs-publish');
    const body = JSON.parse(res.content[0].text);
    expect(body.ok).toBe(true);
    expect(body.workspaceId).toBe('ws-prin');
    expect(body.policy.effectiveCeiling).toBe('low');
    expect(body.policy.category).toBe('docs-publish');
  });

  it('returns ALL categories (effectiveCeiling on each) when no category arg', async () => {
    const res = await callTool({});
    expect(mockReadAll).toHaveBeenCalledWith(expect.anything(), 'ws-active');
    const body = JSON.parse(res.content[0].text);
    expect(body.policy).toHaveLength(2);
    expect(body.policy.every((p: { effectiveCeiling: string }) => p.effectiveCeiling === 'low')).toBe(true);
    expect(mockGetOne).not.toHaveBeenCalled();
  });
});
