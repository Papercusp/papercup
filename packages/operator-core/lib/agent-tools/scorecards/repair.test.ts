/** scorecards:repair — callable immediate pending-audit reconciliation. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UnifiedToolContext } from '@papercusp/agent-mcp';

const reconcilePendingGradingAudits = vi.hoisted(() => vi.fn());

vi.mock('../../grading-integrity', () => ({ reconcilePendingGradingAudits }));

import repairTool from './repair';

const makeContext = (): UnifiedToolContext => ({
  log: vi.fn(),
  signal: new AbortController().signal,
  progress: vi.fn(),
  emit: vi.fn(),
  workspaceId: 'papercusp-workspace',
  harnessSlug: 'papercusp',
  runId: 'scorecards-repair-test',
  isSuperuser: true,
  uiClientId: 'su-scorecards-repair-test',
  role: 'su',
  gateBypass: { role: true, capability: true, quota: true },
  transport: 'mcp',
  requestedFormat: 'json',
  contextTier: 'full',
  tx: {},
});

describe('scorecards:repair', () => {
  beforeEach(() => {
    reconcilePendingGradingAudits.mockReset().mockResolvedValue({
      requestedTargetIds: ['EI-target'],
      receipts: [{ issueId: 'EI-target', state: 'launched' }],
    });
  });

  it('forwards explicit target ids, harness, and the complete caller context', async () => {
    const ctx = makeContext();
    const result = await repairTool.handler(
      { targetIds: ['EI-target'], harness: 'papercusp' } as never,
      ctx,
    );

    expect(reconcilePendingGradingAudits).toHaveBeenCalledOnce();
    expect(reconcilePendingGradingAudits).toHaveBeenCalledWith({
      targetIds: ['EI-target'],
      harness: 'papercusp',
      ctx,
    });
    expect(result).toEqual({
      data: {
        ok: true,
        requestedTargetIds: ['EI-target'],
        receipts: [{ issueId: 'EI-target', state: 'launched' }],
      },
    });
  });

  it('omits target selection so the dispatcher owns bounded oldest-first backlog selection', async () => {
    const ctx = makeContext();
    await repairTool.handler({} as never, ctx);

    expect(reconcilePendingGradingAudits).toHaveBeenCalledWith({ ctx });
  });
});
