import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promptAblationOp, setPromptAblationOpDeps } from './prompt-ablation';
import { runPromptAblation } from '../../ablation/run.js';

// Unit: runPromptAblation has its own suite; this pins the deterministic-step
// WRAPPER — workspaceId guard, installSlug default, deps seam, and the nested
// outcome→result flattening (verdict lives at result.score.verdict)
// (deterministic-blueprints-migration P-121, D-004).
vi.mock('../../coord-ops/registry.js', () => ({ registerCoordOp: vi.fn() }));
vi.mock('../../ablation/run.js', () => ({ runPromptAblation: vi.fn() }));

const mockRun = vi.mocked(runPromptAblation);
const run = (a: Record<string, unknown>, ctx: Record<string, unknown>) =>
  (promptAblationOp.run as (a: unknown, c: unknown) => Promise<Record<string, unknown>>)(a, ctx);

describe('prompt:ablation deterministic step op', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRun.mockResolvedValue({
      ran: true,
      result: {
        runRowId: 'run-9',
        ruleKey: 'rule-x',
        score: { verdict: 'dead-weight-candidate' },
        costUsd: 1.5,
        capped: false,
        replayLegRan: true,
      },
    } as unknown as Awaited<ReturnType<typeof runPromptAblation>>);
  });
  afterEach(() => setPromptAblationOpDeps(null));

  it('throws when ctx.workspaceId is absent', async () => {
    await expect(run({}, {})).rejects.toThrow(/requires ctx.workspaceId/);
  });

  it('defaults installSlug to "op" and forwards args as payload', async () => {
    await run({ ruleKey: 'rule-x', repeat: 2 }, { workspaceId: 'ws-1' });
    expect(mockRun).toHaveBeenCalledWith(
      { workspaceId: 'ws-1', installSlug: 'op', payload: { ruleKey: 'rule-x', repeat: 2 } },
      {},
    );
  });

  it('threads injected deps through the set-seam', async () => {
    const deps = { flag: async () => false };
    setPromptAblationOpDeps(deps as never);
    await run({}, { workspaceId: 'ws-1', harnessSlug: 'h' });
    expect(mockRun).toHaveBeenCalledWith(expect.objectContaining({ installSlug: 'h' }), deps);
  });

  it('flattens the cycle result, reading the verdict from result.score.verdict', async () => {
    const out = await run({}, { workspaceId: 'ws-1' });
    expect(out).toMatchObject({
      ran: true,
      runRowId: 'run-9',
      ruleKey: 'rule-x',
      verdict: 'dead-weight-candidate',
      costUsd: 1.5,
      capped: false,
      replayLegRan: true,
    });
  });

  it('passes a gate-skip outcome through (no result fields)', async () => {
    mockRun.mockResolvedValue({ ran: false, skipReason: 'flag-off' } as unknown as Awaited<
      ReturnType<typeof runPromptAblation>
    >);
    const out = await run({}, { workspaceId: 'ws-1' });
    expect(out).toMatchObject({ ran: false, skipReason: 'flag-off' });
    expect(out.verdict).toBeUndefined();
  });
});
