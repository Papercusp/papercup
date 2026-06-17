/**
 * run.test.ts — handler-level tests for experiment:run (G9).
 *
 * PG/LLM-free unit: mocks runExperiment (the pure run-core) so the handler's ONE
 * piece of own logic is isolated — it fires notifySyncInvalidate('learning.experiments')
 * ONLY when `outcome.ok && outcome.result`. A dryRun (plan, no result) and a refusal
 * (ok:false) must NOT invalidate the scoreboard.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import runTool from './run';
import { runExperiment } from '../../experiment/run-core';
import { notifySyncInvalidate } from '../../sync-sse';

vi.mock('@papercusp/db-org', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, getOrgPg: () => ({ sql: {} }) };
});
vi.mock('../../experiment/run-core', () => ({ runExperiment: vi.fn() }));
vi.mock('../../sync-sse', () => ({ notifySyncInvalidate: vi.fn(async () => {}) }));
// The handler constructs these before calling runExperiment — stub so no LLM/governor wiring loads.
vi.mock('../../experiment/replay-ports', () => ({
  experimentReplayRunner: vi.fn(() => ({})),
  experimentJudge: vi.fn(async () => ({})),
}));
vi.mock('../../replay/governed', () => ({ runGovernedReplay: vi.fn() }));
vi.mock('../../experiment/ledger', () => ({ PgExperimentLedger: vi.fn() }));

const mockRun = vi.mocked(runExperiment);
const mockInvalidate = vi.mocked(notifySyncInvalidate);

const baseArgs = {
  testId: 'replay',
  batteryId: 'b1',
  arms: [{ id: 'baseline', knobs: {} }],
  cases: [{ caseId: 'c1', context: 'ctx', intent: 'do it' }],
  repeats: 1,
};

function callTool(args: Record<string, unknown> = {}, ctx: Record<string, unknown> = {}) {
  return (
    runTool as unknown as {
      handler: (a: unknown, c: unknown) => Promise<{ content: Array<{ text: string }> }>;
    }
  ).handler({ ...baseArgs, ...args }, ctx);
}

describe('experiment:run tool — scoreboard invalidation gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('invalidates learning.experiments exactly once on a real result', async () => {
    mockRun.mockResolvedValue({ ok: true, result: { winner: 'cand', arms: [] } as never });
    const res = await callTool();
    expect(mockInvalidate).toHaveBeenCalledTimes(1);
    expect(mockInvalidate).toHaveBeenCalledWith('learning.experiments');
    // the handler still returns the raw outcome
    expect(JSON.parse(res.content[0].text)).toMatchObject({ ok: true });
  });

  it('does NOT invalidate on a dryRun (ok but plan-only, no result)', async () => {
    mockRun.mockResolvedValue({ ok: true, plan: { cells: 1 } as never });
    await callTool({ dryRun: true });
    expect(mockInvalidate).not.toHaveBeenCalled();
  });

  it('does NOT invalidate on a refusal (ok:false, no result)', async () => {
    mockRun.mockResolvedValue({ ok: false, refused: { reason: 'flag off' } });
    await callTool();
    expect(mockInvalidate).not.toHaveBeenCalled();
  });
});
