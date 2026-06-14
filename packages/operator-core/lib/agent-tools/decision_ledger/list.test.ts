import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import listTool from './list';
import { readDecisionLedger } from '../../decision-ledger/read';
import { activeWorkspaceId } from '../../workspace-registry';
import { resolveAgentIdentity } from '../coordination/identity';

// PG-free unit: the ledger read has its own suite; this pins the TOOL — the
// workspace-resolution precedence, the only-provided-filters spread, the
// sinceHours→sinceMs conversion, the limit default, and the { count, entries }
// envelope (queen-autonomy-policy-2026-06-13 B-13 / P-113).
vi.mock('../../decision-ledger/read', () => ({ readDecisionLedger: vi.fn(), summarizeDecisionLedger: vi.fn() }));
vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: vi.fn(() => 'ws-active') }));
vi.mock('../coordination/identity', () => ({ resolveAgentIdentity: vi.fn() }));

const mockRead = vi.mocked(readDecisionLedger);
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

describe('decision_ledger:list tool', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.clearAllMocks();
    mockIdentity.mockReturnValue({ ownerId: 'su-test' } as ReturnType<typeof resolveAgentIdentity>);
    mockActiveWs.mockReturnValue('ws-active');
    mockRead.mockResolvedValue([] as Awaited<ReturnType<typeof readDecisionLedger>>);
  });
  afterEach(() => vi.useRealTimers());

  it('resolves workspace by precedence (arg > ctx > principal > active)', async () => {
    await callTool({ workspace: 'ws-arg' }, { workspaceId: 'ws-ctx', principal: { workspaceId: 'ws-prin' } });
    expect(mockRead).toHaveBeenCalledWith('ws-arg', expect.anything());
    mockRead.mockClear();
    await callTool({}, { workspaceId: 'ws-ctx', principal: { workspaceId: 'ws-prin' } });
    expect(mockRead).toHaveBeenCalledWith('ws-ctx', expect.anything());
    mockRead.mockClear();
    await callTool({}, { principal: { workspaceId: 'ws-prin' } });
    expect(mockRead).toHaveBeenCalledWith('ws-prin', expect.anything());
    mockRead.mockClear();
    await callTool({}, {});
    expect(mockRead).toHaveBeenCalledWith('ws-active', expect.anything());
  });

  it('passes ONLY limit:50 when no filters are given (no empty filter keys)', async () => {
    await callTool({});
    expect(mockRead).toHaveBeenCalledWith('ws-active', { limit: 50 });
  });

  it('spreads every provided filter and converts sinceHours to sinceMs', async () => {
    await callTool({
      layer: 'disposition',
      category: 'spend-budget',
      posture: 'gated',
      disposition: 'defer',
      sinceHours: 12,
      limit: 100,
    });
    expect(mockRead).toHaveBeenCalledWith('ws-active', {
      layer: 'disposition',
      category: 'spend-budget',
      posture: 'gated',
      disposition: 'defer',
      sinceMs: NOW - 12 * 3_600_000,
      limit: 100,
    });
  });

  it('returns { workspaceId, count, entries }', async () => {
    const entries = [{ id: 1 }, { id: 2 }, { id: 3 }];
    mockRead.mockResolvedValue(entries as unknown as Awaited<ReturnType<typeof readDecisionLedger>>);
    const res = await callTool({ workspace: 'ws-x' });
    expect(JSON.parse(res.content[0].text)).toEqual({ workspaceId: 'ws-x', count: 3, entries });
  });
});
