import { describe, it, expect, beforeEach, vi } from 'vitest';
import resolveTool from './resolve';
import { resolveImprovement } from '../../harness/improvements/resolve-core';
import { resolveAgentIdentity } from '../coordination/identity';

// PG-free unit: resolve-core has its own tests; this suite pins the tool's
// response envelope — specifically the EI-328 discovery-time insight nudge.
vi.mock('../../harness/improvements/resolve-core');
vi.mock('../coordination/identity');

const mockResolve = vi.mocked(resolveImprovement);
const mockIdentity = vi.mocked(resolveAgentIdentity);

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
