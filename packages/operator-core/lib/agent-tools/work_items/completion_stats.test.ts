/**
 * completion_stats.test.ts — the work_items:completion_stats TOOL (getCompletionIntegrityStats
 * itself has its own PG-backed integration coverage in work-items.integration.test.ts, describe
 * 'WI-1405 — genuine-completions metric'). This pins the tool wiring: it passes `harness`
 * through and returns the stats spread under `{ ok: true, ... }`.
 *
 * In-tree (operator-core, tab-visible).
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/work_items/completion_stats.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../work-items', () => ({ getCompletionIntegrityStats: vi.fn() }));

import { getCompletionIntegrityStats } from '../../work-items';
const mockStats = vi.mocked(getCompletionIntegrityStats);
const tool = (await import('./completion_stats')).default;

function callTool(args: Record<string, unknown>) {
  return (
    tool as unknown as { handler: (a: unknown, c?: unknown) => Promise<{ content: Array<{ text: string }> }> }
  ).handler(args, {});
}

describe('work_items:completion_stats tool', () => {
  beforeEach(() => vi.clearAllMocks());

  it('passes `harness` through to getCompletionIntegrityStats and returns { ok, ...stats }', async () => {
    mockStats.mockResolvedValue({
      harness: 'papercusp',
      terminalTotal: 10,
      genuineCompletions: 6,
      dedupOrUnverified: 4,
    });
    const res = await callTool({ harness: 'papercusp' });
    expect(mockStats).toHaveBeenCalledWith('papercusp');
    expect(JSON.parse(res.content[0].text)).toEqual({
      ok: true,
      harness: 'papercusp',
      terminalTotal: 10,
      genuineCompletions: 6,
      dedupOrUnverified: 4,
    });
  });
});
