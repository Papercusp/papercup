import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import watchdogStatusTool from './watchdog-status';
import { readWatchdogStatus } from '../../harness/improvements/watchdog';
import {
  readRecentDispatches,
  computeDispatchStats,
} from '../../harness/improvements/dispatch-ledger';
import { activeWorkspaceId } from '../../workspace-registry';
import { resolveAgentIdentity } from '../coordination/identity';
import type { WatchdogTickStatusRow, CollectorStatus } from '../../harness/improvements/watchdog';

// PG-free unit: the readers have their own suites; this pins the tool's
// SUMMARY ROLLUP (the reductions across ticks), the lastRan / failingCollectors
// derivation, the workspace-resolution precedence, and the dispatch-ledger
// graceful-degradation-to-null path (watchdog-audit-2026-06-09 P-010).
vi.mock('../../harness/improvements/watchdog');
vi.mock('../../harness/improvements/dispatch-ledger');
vi.mock('../../workspace-registry');
vi.mock('../coordination/identity');

const mockReadTicks = vi.mocked(readWatchdogStatus);
const mockReadDispatches = vi.mocked(readRecentDispatches);
const mockDispatchStats = vi.mocked(computeDispatchStats);
const mockActiveWs = vi.mocked(activeWorkspaceId);
const mockIdentity = vi.mocked(resolveAgentIdentity);

function collector(name: string, ok: boolean): CollectorStatus {
  return { name, ok, signalCount: ok ? 1 : 0, ...(ok ? {} : { error: 'boom' }) };
}

function tick(p: Partial<WatchdogTickStatusRow> & { tickAt: string }): WatchdogTickStatusRow {
  return {
    installSlug: null,
    status: 'ran',
    signals: 0,
    captured: [],
    declinedDuplicates: 0,
    deferred: 0,
    deferredKeys: [],
    knownOpenKeys: [],
    staleResolvedKeys: [],
    collectors: [],
    selfEscalations: [],
    ...p,
  };
}

function callTool(args: Record<string, unknown>, ctx: Record<string, unknown> = {}) {
  return (
    watchdogStatusTool as unknown as {
      handler: (a: unknown, c: unknown) => Promise<{ content: Array<{ text: string }> }>;
    }
  ).handler(args, ctx);
}

describe('improvements:watchdog-status tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIdentity.mockReturnValue({ ownerId: 'su-test' } as ReturnType<typeof resolveAgentIdentity>);
    mockActiveWs.mockReturnValue('ws-active');
    mockReadTicks.mockResolvedValue([]);
    mockReadDispatches.mockResolvedValue([]);
    mockDispatchStats.mockReturnValue({ total: 0 } as unknown as ReturnType<typeof computeDispatchStats>);
  });

  describe('workspace resolution precedence', () => {
    it('args.workspace wins over everything', async () => {
      await callTool({ workspace: 'ws-arg' }, { workspaceId: 'ws-ctx', principal: { workspaceId: 'ws-prin' } });
      expect(mockReadTicks).toHaveBeenCalledWith('ws-arg', 10);
    });
    it('falls back to ctx.workspaceId', async () => {
      await callTool({}, { workspaceId: 'ws-ctx', principal: { workspaceId: 'ws-prin' } });
      expect(mockReadTicks).toHaveBeenCalledWith('ws-ctx', 10);
    });
    it('then ctx.principal.workspaceId', async () => {
      await callTool({}, { principal: { workspaceId: 'ws-prin' } });
      expect(mockReadTicks).toHaveBeenCalledWith('ws-prin', 10);
    });
    it('then the active workspace', async () => {
      await callTool({}, {});
      expect(mockReadTicks).toHaveBeenCalledWith('ws-active', 10);
    });
  });

  it('passes the limit through (default 10)', async () => {
    await callTool({ limit: 50 });
    expect(mockReadTicks).toHaveBeenCalledWith('ws-active', 50);
  });

  it('rolls up the per-tick counters across ALL ticks (sum), not just the latest', async () => {
    mockReadTicks.mockResolvedValue([
      tick({
        tickAt: 't2',
        captured: ['EI-1', 'EI-2'],
        declinedDuplicates: 1,
        knownOpenKeys: ['k1'],
        staleResolvedKeys: ['s1', 's2'],
        deferred: 3,
        selfEscalations: ['esc-a'],
      }),
      tick({
        tickAt: 't1',
        captured: ['EI-3'],
        declinedDuplicates: 2,
        knownOpenKeys: ['k2', 'k3'],
        staleResolvedKeys: [],
        deferred: 1,
        selfEscalations: ['esc-b', 'esc-c'],
      }),
    ]);
    const res = await callTool({});
    const { summary } = JSON.parse(res.content[0].text);
    expect(summary.ticks).toBe(2);
    expect(summary.captured).toBe(3); // 2 + 1
    expect(summary.declinedDuplicates).toBe(3); // 1 + 2
    expect(summary.knownOpenPrefiltered).toBe(3); // 1 + 2
    expect(summary.staleResolvedPrefiltered).toBe(2); // 2 + 0
    expect(summary.deferred).toBe(4); // 3 + 1
    expect(summary.selfEscalations).toEqual(['esc-a', 'esc-b', 'esc-c']); // flatMap, in order
  });

  it('lastTickAt is the newest tick; lastRanTickAt is the newest tick whose status is "ran"', async () => {
    mockReadTicks.mockResolvedValue([
      tick({ tickAt: 'newest-skipped', status: 'skipped' }),
      tick({ tickAt: 'older-ran', status: 'ran', collectors: [collector('red-test', true)] }),
    ]);
    const res = await callTool({});
    const { summary } = JSON.parse(res.content[0].text);
    expect(summary.lastTickAt).toBe('newest-skipped');
    expect(summary.lastRanTickAt).toBe('older-ran');
  });

  it('failingCollectors reads from the last RAN tick (skipped ticks have no collector signal)', async () => {
    mockReadTicks.mockResolvedValue([
      tick({ tickAt: 't2', status: 'skipped', collectors: [collector('would-be-ignored', false)] }),
      tick({
        tickAt: 't1',
        status: 'ran',
        collectors: [collector('red-test', true), collector('service-down', false), collector('smoke', false)],
      }),
    ]);
    const res = await callTool({});
    const { summary } = JSON.parse(res.content[0].text);
    expect(summary.failingCollectors).toEqual(['service-down', 'smoke']);
  });

  it('degrades the dispatch ledger to null (no throw) when the read fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockReadDispatches.mockRejectedValue(new Error('migration 238 not applied'));
    const res = await callTool({});
    const body = JSON.parse(res.content[0].text);
    expect(body.ok).toBe(true);
    expect(body.dispatches).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('returns dispatch stats + the most recent 10 dispatch rows on success', async () => {
    const rows = Array.from({ length: 15 }, (_, i) => ({ id: `d${i}` })) as unknown as Awaited<
      ReturnType<typeof readRecentDispatches>
    >;
    mockReadDispatches.mockResolvedValue(rows);
    mockDispatchStats.mockReturnValue({ total: 15, armed: 4 } as unknown as ReturnType<typeof computeDispatchStats>);
    const res = await callTool({});
    const body = JSON.parse(res.content[0].text);
    expect(body.dispatches.stats).toEqual({ total: 15, armed: 4 });
    expect(body.dispatches.recent).toHaveLength(10);
    expect(mockDispatchStats).toHaveBeenCalledWith(rows);
  });
});
