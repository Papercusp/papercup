/**
 * plan-run-wake.test.ts — resumePlanRunForWake: the plan-run wake channel +
 * its resume-race guard (the wave-3 fix), in ISOLATION.
 *
 * GAP 9: markPlanRunResumed is an atomic claim; ONLY the winner of the flip
 * fires executePlanAgentTurn. A non-claimed call (the run is already `running`
 * mid-turn) must return {ok:false} "already running — wake skipped" and NOT
 * kick a duplicate turn on the same session. All four collaborators are mocked
 * so the branch logic is exercised purely (no PG, no agent spawn).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  getPlanRun: vi.fn(async (): Promise<unknown> => null),
  buildPlanContextBundle: vi.fn(async (): Promise<unknown> => null),
  markPlanRunResumed: vi.fn(async (): Promise<{ claimed: boolean }> => ({ claimed: true })),
  executePlanAgentTurn: vi.fn(async (): Promise<unknown> => ({ status: 'idle' })),
  getRepoRoot: vi.fn(() => '/repo'),
}));

vi.mock('../../agent-tools/plans/runs', () => ({
  getPlanRun: h.getPlanRun,
  markPlanRunResumed: h.markPlanRunResumed,
}));
vi.mock('../../agent-tools/plans/context-bundle', () => ({ buildPlanContextBundle: h.buildPlanContextBundle }));
vi.mock('../../agent-tools/plans/turn', () => ({ executePlanAgentTurn: h.executePlanAgentTurn }));
vi.mock('../../agent-tools/plans/source', () => ({ getRepoRoot: h.getRepoRoot }));

const { resumePlanRunForWake } = await import('./plan-run-wake');

const RUN = { id: 5, planSlug: 'my-plan', sessionId: 'sess-uuid' };
const BUNDLE = { text: 'system seed', contentHash: 'h'.repeat(64) };

beforeEach(() => {
  vi.clearAllMocks();
  h.getPlanRun.mockResolvedValue(RUN);
  h.buildPlanContextBundle.mockResolvedValue(BUNDLE);
});

describe('resumePlanRunForWake — resume-race guard (the wave-3 fix)', () => {
  it('(a) claim WON → executePlanAgentTurn fires exactly once with the wake text, {ok:true}', async () => {
    h.markPlanRunResumed.mockResolvedValueOnce({ claimed: true });
    const r = await resumePlanRunForWake({ runId: 5, wakeText: 'WAKE-NOW' });
    expect(r).toEqual({ ok: true });
    expect(h.markPlanRunResumed).toHaveBeenCalledWith(5, BUNDLE.contentHash);
    expect(h.executePlanAgentTurn).toHaveBeenCalledTimes(1);
    const turnArg = (h.executePlanAgentTurn.mock.calls[0] as unknown as [{ runId: number; sessionId: string; systemPromptText: string; promptText: string; cwd: string }])[0];
    expect(turnArg.runId).toBe(5);
    expect(turnArg.sessionId).toBe('sess-uuid');
    expect(turnArg.systemPromptText).toBe(BUNDLE.text);
    expect(turnArg.promptText).toBe('WAKE-NOW');
    expect(turnArg.cwd).toBe('/repo');
  });

  it('(b) claim LOST (run already running) → NO turn kicked, {ok:false} "already running — wake skipped"', async () => {
    h.markPlanRunResumed.mockResolvedValueOnce({ claimed: false });
    const r = await resumePlanRunForWake({ runId: 5, wakeText: 'WAKE' });
    expect(r.ok).toBe(false);
    expect((r as { ok: false; error: string }).error).toContain('already running');
    expect((r as { ok: false; error: string }).error).toContain('wake skipped');
    // The load-bearing assertion: the loser of the atomic claim NEVER spawns a
    // duplicate turn on the same plan-run session.
    expect(h.executePlanAgentTurn).not.toHaveBeenCalled();
  });

  it('(c) run not found → distinct error, no bundle build, no claim, no turn', async () => {
    h.getPlanRun.mockResolvedValueOnce(null);
    const r = await resumePlanRunForWake({ runId: 404, wakeText: 'WAKE' });
    expect(r.ok).toBe(false);
    expect((r as { ok: false; error: string }).error).toContain('not found');
    expect(h.buildPlanContextBundle).not.toHaveBeenCalled();
    expect(h.markPlanRunResumed).not.toHaveBeenCalled();
    expect(h.executePlanAgentTurn).not.toHaveBeenCalled();
  });

  it('(c) bundle null (plan gone) → a DISTINCT error from not-found, no claim, no turn', async () => {
    h.buildPlanContextBundle.mockResolvedValueOnce(null);
    const r = await resumePlanRunForWake({ runId: 5, wakeText: 'WAKE' });
    expect(r.ok).toBe(false);
    const err = (r as { ok: false; error: string }).error;
    expect(err).toContain('not found for run');
    expect(err).not.toBe('plan run 5 not found'); // distinct from the run-not-found error
    expect(h.markPlanRunResumed).not.toHaveBeenCalled();
    expect(h.executePlanAgentTurn).not.toHaveBeenCalled();
  });
});
