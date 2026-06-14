import { describe, it, expect, beforeEach, vi } from 'vitest';
import listTool from './tripwire_list';
import { listRecentTripwires } from '../../autonomy/tripwire/store';
import { isAutonomyCategory } from '../../autonomy/categories';
import { activeWorkspaceId } from '../../workspace-registry';

// PG-free unit: the store read has its own suite; this pins the TOOL — the
// category validation (silently drops an unknown category from the filter), the
// only-provided-filters spread, and the { count, tripwires } envelope (B-16 / P-080).
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, getOrgPg: () => ({ sql: {} }) };
});
vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: vi.fn(() => 'ws-active') }));
vi.mock('../../autonomy/tripwire/store', () => ({ listRecentTripwires: vi.fn() }));
vi.mock('../../autonomy/categories', () => ({ isAutonomyCategory: vi.fn() }));

const mockList = vi.mocked(listRecentTripwires);
const mockIsCat = vi.mocked(isAutonomyCategory);
const mockActiveWs = vi.mocked(activeWorkspaceId);

function callTool(args: Record<string, unknown>, ctx: Record<string, unknown> = {}) {
  return (
    listTool as unknown as {
      handler: (a: unknown, c: unknown) => Promise<{ content: Array<{ text: string }> }>;
    }
  ).handler(args, ctx);
}

describe('autonomy:tripwire_list tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockActiveWs.mockReturnValue('ws-active');
    mockIsCat.mockReturnValue(true);
    mockList.mockResolvedValue([{ id: 'tw-1' }, { id: 'tw-2' }] as Awaited<ReturnType<typeof listRecentTripwires>>);
  });

  it('passes no filters when args are empty', async () => {
    await callTool({});
    expect(mockList).toHaveBeenCalledWith(expect.anything(), 'ws-active', {});
  });

  it('forwards status, a VALID category, and limit', async () => {
    await callTool({ status: 'armed', category: 'docs-publish', limit: 10 });
    expect(mockList).toHaveBeenCalledWith(expect.anything(), 'ws-active', {
      status: 'armed',
      category: 'docs-publish',
      limit: 10,
    });
  });

  it('drops an unknown category from the filter (does not pass it through)', async () => {
    mockIsCat.mockReturnValue(false);
    await callTool({ category: 'not-a-category', status: 'tripped' });
    expect(mockList).toHaveBeenCalledWith(expect.anything(), 'ws-active', { status: 'tripped' });
  });

  it('returns { count, tripwires } from the read', async () => {
    const res = await callTool({}, { principal: { workspaceId: 'ws-prin' } });
    const body = JSON.parse(res.content[0].text);
    expect(body).toMatchObject({ ok: true, workspaceId: 'ws-prin', count: 2 });
    expect(body.tripwires).toHaveLength(2);
  });
});
