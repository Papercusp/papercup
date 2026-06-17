import { describe, it, expect, beforeEach, vi } from 'vitest';
import resolveTool from './resolve';
import { resolveImprovement } from '../../harness/improvements/resolve-core';
import { resolveAgentIdentity } from '../coordination/identity';
import { recordPrediction } from '../../calibration/capture';

// PG-free unit: resolve-core has its own tests; this suite pins the tool's
// response envelope — the EI-328 discovery-time insight nudge — and the
// fire-and-forget calibration bet (P-041 / FB-13: fixed IS a survival claim).
vi.mock('../../harness/improvements/resolve-core');
vi.mock('../coordination/identity');
vi.mock('../../calibration/capture', () => ({ recordPrediction: vi.fn() }));

const mockResolve = vi.mocked(resolveImprovement);
const mockIdentity = vi.mocked(resolveAgentIdentity);
const mockRecord = vi.mocked(recordPrediction);

// The bet is fired as `void import('../../calibration/capture').then(...)`, so
// it settles a tick AFTER the handler returns. Flush the microtask queue so the
// mock has been invoked before we assert on it.
const flush = () => new Promise((r) => setTimeout(r, 0));

function callTool(args: Record<string, unknown>) {
  return (resolveTool as unknown as { handler: (a: unknown, c: unknown) => Promise<{ content: Array<{ text: string }> }> }).handler(
    args,
    {} as unknown,
  );
}

describe('improvements:resolve tool envelope', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIdentity.mockReturnValue({ ownerId: 'su-test' } as ReturnType<typeof resolveAgentIdentity>);
    mockResolve.mockResolvedValue({ ok: true, id: 'EI-1', outcome: 'fixed', state: 'resolved' } as Awaited<
      ReturnType<typeof resolveImprovement>
    >);
    mockRecord.mockResolvedValue({ recorded: true } as Awaited<ReturnType<typeof recordPrediction>>);
  });

  it('outcome fixed carries the same-turn insightCheck nudge (EI-328 / policies §19)', async () => {
    const res = await callTool({ id: 'EI-1', outcome: 'fixed', summary: 'root cause found + fixed', testsRun: 'vitest run x — green' });
    const body = JSON.parse(res.content[0].text) as { insightCheck?: string };
    expect(body.insightCheck).toBeTruthy();
    expect(body.insightCheck).toMatch(/same turn/i);
    expect(body.insightCheck).toMatch(/agent-insights/);
    expect(body.insightCheck).toMatch(/recurring/i);
  });

  it('non-fixed outcomes stay nudge-free (nothing was proven — no insight boundary)', async () => {
    mockResolve.mockResolvedValue({ ok: true, id: 'EI-1', outcome: 'could-not-fix', state: 'open' } as Awaited<
      ReturnType<typeof resolveImprovement>
    >);
    const res = await callTool({ id: 'EI-1', outcome: 'could-not-fix', summary: 'tried X and Y, both dead ends' });
    const body = JSON.parse(res.content[0].text) as { insightCheck?: string };
    expect(body.insightCheck).toBeUndefined();
  });

  it('passes the caller identity + args through to resolve-core unchanged', async () => {
    await callTool({ id: 'EI-2', outcome: 'fixed', summary: 'fixed it for real this time', testsRun: 'cmd — green', commit: 'abc123' });
    expect(mockResolve).toHaveBeenCalledWith({
      id: 'EI-2',
      outcome: 'fixed',
      summary: 'fixed it for real this time',
      testsRun: 'cmd — green',
      commit: 'abc123',
      by: 'su-test',
    });
  });
});

describe('improvements:resolve calibration bet (P-041 / FB-13, fix-survival)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIdentity.mockReturnValue({ ownerId: 'su-test' } as ReturnType<typeof resolveAgentIdentity>);
    mockResolve.mockResolvedValue({ ok: true, id: 'EI-1', outcome: 'fixed', state: 'resolved' } as Awaited<
      ReturnType<typeof resolveImprovement>
    >);
    mockRecord.mockResolvedValue({ recorded: true } as Awaited<ReturnType<typeof recordPrediction>>);
  });

  it('records a fix-survival bet on outcome fixed, keyed to the improvement id, with the stated confidence', async () => {
    await callTool({ id: 'EI-7', outcome: 'fixed', summary: 'root cause found + fixed', testsRun: 'vitest — green', confidence: 0.9 });
    await flush();
    expect(mockRecord).toHaveBeenCalledTimes(1);
    expect(mockRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        predictor: 'su-test',
        domain: 'fix-survival',
        subjectKind: 'improvement',
        subjectId: 'EI-7',
        probability: 0.9,
      }),
    );
  });

  it('omits probability entirely when no confidence is given (cheap implicit prior)', async () => {
    await callTool({ id: 'EI-8', outcome: 'fixed', summary: 'fixed, no stated confidence', testsRun: 'vitest — green' });
    await flush();
    expect(mockRecord).toHaveBeenCalledTimes(1);
    const arg = mockRecord.mock.calls[0][0] as Record<string, unknown>;
    expect(arg.subjectId).toBe('EI-8');
    expect('probability' in arg).toBe(false);
  });

  it('does NOT record a bet for outcome could-not-fix (nothing was claimed survived)', async () => {
    mockResolve.mockResolvedValue({ ok: true, id: 'EI-9', outcome: 'could-not-fix', state: 'open' } as Awaited<
      ReturnType<typeof resolveImprovement>
    >);
    await callTool({ id: 'EI-9', outcome: 'could-not-fix', summary: 'tried X and Y, both dead ends' });
    await flush();
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it('does NOT record a bet for outcome needs-human', async () => {
    mockResolve.mockResolvedValue({ ok: true, id: 'EI-10', outcome: 'needs-human', state: 'open' } as Awaited<
      ReturnType<typeof resolveImprovement>
    >);
    await callTool({ id: 'EI-10', outcome: 'needs-human', summary: 'touches a protected surface — route to a human' });
    await flush();
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it('a rejecting recordPrediction never breaks resolve — the core result still returns', async () => {
    mockRecord.mockRejectedValue(new Error('calibration pool exploded'));
    const res = await callTool({ id: 'EI-11', outcome: 'fixed', summary: 'fixed it', testsRun: 'vitest — green', confidence: 0.5 });
    await flush();
    const body = JSON.parse(res.content[0].text) as { ok?: boolean; insightCheck?: string };
    expect(body.ok).toBe(true);
    expect(body.insightCheck).toBeTruthy();
    expect(mockRecord).toHaveBeenCalledTimes(1);
  });
});
