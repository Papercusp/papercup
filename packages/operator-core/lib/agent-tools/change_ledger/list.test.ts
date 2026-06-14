import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import listTool from './list';
import { readRecentChanges } from '../../change-ledger/change-ledger';
import { activeWorkspaceId } from '../../workspace-registry';
import { resolveAgentIdentity } from '../coordination/identity';

// PG-free unit: readRecentChanges has its own suite; this pins the tool's
// workspace-resolution precedence, the limit default, the sinceHours→sinceMs
// conversion, mutationClass pass-through, and the { workspaceId, count, changes }
// envelope (self-learning-frontier P-004 / FB-02).
vi.mock('../../change-ledger/change-ledger');
vi.mock('../../workspace-registry');
vi.mock('../coordination/identity');

const mockRead = vi.mocked(readRecentChanges);
const mockActiveWs = vi.mocked(activeWorkspaceId);
const mockIdentity = vi.mocked(resolveAgentIdentity);

const NOW = 1_700_000_000_000;

function callTool(args: Record<string, unknown>, ctx: Record<string, unknown> = {}) {
  return (
    listTool as unknown as {
      handler: (a: unknown, c: unknown) => Promise<{ content: Array<{ text: string }> }>;
    }
  ).handler(args, ctx);
}

describe('change_ledger:list tool', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.clearAllMocks();
    mockIdentity.mockReturnValue({ ownerId: 'su-test' } as ReturnType<typeof resolveAgentIdentity>);
    mockActiveWs.mockReturnValue('ws-active');
    mockReadTicks();
  });
  afterEach(() => vi.useRealTimers());

  function mockReadTicks(rows: unknown[] = []) {
    mockRead.mockResolvedValue(rows as Awaited<ReturnType<typeof readRecentChanges>>);
  }

  it('resolves the workspace by precedence (arg > ctx > principal > active)', async () => {
    await callTool({ workspace: 'ws-arg' }, { workspaceId: 'ws-ctx' });
    expect(mockRead).toHaveBeenCalledWith('ws-arg', expect.anything());
    mockRead.mockClear();
    await callTool({}, { workspaceId: 'ws-ctx' });
    expect(mockRead).toHaveBeenCalledWith('ws-ctx', expect.anything());
    mockRead.mockClear();
    await callTool({}, { principal: { workspaceId: 'ws-prin' } });
    expect(mockRead).toHaveBeenCalledWith('ws-prin', expect.anything());
    mockRead.mockClear();
    await callTool({}, {});
    expect(mockRead).toHaveBeenCalledWith('ws-active', expect.anything());
  });

  it('defaults limit to 50 and leaves sinceMs undefined when sinceHours is absent', async () => {
    await callTool({});
    expect(mockRead).toHaveBeenCalledWith('ws-active', {
      limit: 50,
      mutationClass: undefined,
      sinceMs: undefined,
    });
  });

  it('converts sinceHours to an absolute sinceMs cutoff and passes mutationClass + limit', async () => {
    await callTool({ limit: 200, mutationClass: 'gym', sinceHours: 24 });
    expect(mockRead).toHaveBeenCalledWith('ws-active', {
      limit: 200,
      mutationClass: 'gym',
      sinceMs: NOW - 24 * 3_600_000,
    });
  });

  it('returns { workspaceId, count, changes } from the read', async () => {
    const rows = [{ id: 'c1' }, { id: 'c2' }];
    mockReadTicks(rows);
    const res = await callTool({ workspace: 'ws-x' });
    const body = JSON.parse(res.content[0].text);
    expect(body).toEqual({ workspaceId: 'ws-x', count: 2, changes: rows });
  });
});
