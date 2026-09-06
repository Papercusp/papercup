import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import calendarTool from './calendar';
import { readRecentChanges } from '../../change-ledger/change-ledger';
import { computeMutationCalendar, DEFAULT_LIVE_WINDOW_MS } from '../../change-ledger/mutation-calendar';
import { activeWorkspaceId } from '../../workspace-registry';
import { resolveAgentIdentity } from '../coordination/identity';

// PG-free unit: computeMutationCalendar has its own suite; this pins the tool's
// liveWindow math (days→ms, default), the 4×-window read horizon, the limit:1000
// read cap, and the { workspaceId, rowsConsidered, ...calendar } envelope
// (self-learning-frontier P-004 / FB-02 D-003 overlap advisory).
vi.mock('../../change-ledger/change-ledger');
// Spy computeMutationCalendar but keep DEFAULT_LIVE_WINDOW_MS real.
vi.mock('../../change-ledger/mutation-calendar', async (orig) => {
  const actual = (await orig()) as typeof import('../../change-ledger/mutation-calendar');
  return { ...actual, computeMutationCalendar: vi.fn() };
});
vi.mock('../../workspace-registry', () => ({
  activeWorkspaceId: vi.fn(() => 'ws-active'),
  resolveConcreteWorkspaceId: vi.fn((...candidates: Array<string | null | undefined>) =>
    candidates.find((candidate) => typeof candidate === 'string' && candidate.trim() && candidate.trim() !== '*')?.trim() ?? 'ws-active',
  ),
}));
vi.mock('../coordination/identity');

const mockRead = vi.mocked(readRecentChanges);
const mockCalendar = vi.mocked(computeMutationCalendar);
const mockActiveWs = vi.mocked(activeWorkspaceId);
const mockIdentity = vi.mocked(resolveAgentIdentity);

const NOW = 1_700_000_000_000;
const DAY = 86_400_000;

function callTool(args: Record<string, unknown>, ctx: Record<string, unknown> = {}) {
  return (
    calendarTool as unknown as {
      handler: (a: unknown, c: unknown) => Promise<{
        data: {
          workspaceId: string;
          rowsConsidered: number;
          classes: unknown[];
          overlapAdvisory: string | null;
        };
      }>;
    }
  ).handler(args, ctx);
}

describe('change_ledger:calendar tool', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.clearAllMocks();
    mockIdentity.mockReturnValue({ ownerId: 'su-test' } as ReturnType<typeof resolveAgentIdentity>);
    mockActiveWs.mockReturnValue('ws-active');
    mockRead.mockResolvedValue([] as Awaited<ReturnType<typeof readRecentChanges>>);
    mockCalendar.mockReturnValue({ classes: [], overlapAdvisory: null } as unknown as ReturnType<
      typeof computeMutationCalendar
    >);
  });
  afterEach(() => vi.useRealTimers());

  it('defaults the live window to DEFAULT_LIVE_WINDOW_MS and reads 4× that horizon at limit 1000', async () => {
    await callTool({});
    expect(mockRead).toHaveBeenCalledWith('ws-active', {
      limit: 1000,
      sinceMs: NOW - DEFAULT_LIVE_WINDOW_MS * 4,
    });
    expect(mockCalendar).toHaveBeenCalledWith([], { nowMs: NOW, liveWindowMs: DEFAULT_LIVE_WINDOW_MS });
  });

  it('converts liveWindowDays to ms and scales the read horizon 4×', async () => {
    await callTool({ liveWindowDays: 3 });
    const liveMs = 3 * DAY;
    expect(mockRead).toHaveBeenCalledWith('ws-active', { limit: 1000, sinceMs: NOW - liveMs * 4 });
    expect(mockCalendar).toHaveBeenCalledWith([], { nowMs: NOW, liveWindowMs: liveMs });
  });

  it('spreads the calendar result into the envelope alongside workspaceId + rowsConsidered', async () => {
    mockRead.mockResolvedValue([{ id: 'r1' }, { id: 'r2' }] as Awaited<ReturnType<typeof readRecentChanges>>);
    mockCalendar.mockReturnValue({
      classes: [{ mutationClass: 'gym', count: 2, live: true }],
      overlapAdvisory: 'two automated classes live',
    } as unknown as ReturnType<typeof computeMutationCalendar>);
    const res = await callTool({ workspace: 'ws-x' });
    const body = res.data;
    expect(body.workspaceId).toBe('ws-x');
    expect(body.rowsConsidered).toBe(2);
    expect(body.classes).toEqual([{ mutationClass: 'gym', count: 2, live: true }]);
    expect(body.overlapAdvisory).toBe('two automated classes live');
  });

  it('honors workspace precedence (ctx.workspaceId when no arg)', async () => {
    await callTool({}, { workspaceId: 'ws-ctx' });
    expect(mockRead).toHaveBeenCalledWith('ws-ctx', expect.anything());
  });
});
