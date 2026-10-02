import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { lookupByMcpName } from '@papercusp/agent-mcp';

const h = vi.hoisted(() => ({
  claim: vi.fn(),
  claimNext: vi.fn(),
  resubmit: vi.fn(),
  identity: vi.fn(() => ({ ownerId: 'su-reviewer' })),
}));

vi.mock('../../harness/improvements/agent-review', () => ({
  claimAgentReview: h.claim,
  claimNextAgentReview: h.claimNext,
  resubmitAgentReview: h.resubmit,
}));
vi.mock('../coordination/identity', () => ({ resolveAgentIdentity: h.identity }));

import tool from './agent-review';

type ToolResult = { content: Array<{ text: string }>; isError?: boolean };
const call = (args: Record<string, unknown>, ctx: Record<string, unknown> = {}) =>
  tool.handler(args as never, ctx as never) as Promise<ToolResult>;
const body = (result: ToolResult) => JSON.parse(result.content[0]!.text);

beforeEach(() => {
  vi.clearAllMocks();
  h.identity.mockReturnValue({ ownerId: 'su-reviewer' });
  h.claim.mockResolvedValue({ claimed: false, workItem: null, reason: 'not-found' });
  h.claimNext.mockResolvedValue(null);
  h.resubmit.mockResolvedValue({ resubmitted: true, state: { status: 'pending', round: 2 } });
});

describe('improvements:agent-review public door', () => {
  it('claims the requested second pending item without consuming the first', async () => {
    h.claim.mockResolvedValue({
      claimed: true,
      workItem: {
        id: 'WI-8',
        title: 'review me second',
        payload: { agentReview: { status: 'pending', submittedBy: 'su-filer', ledgerIdeaId: 'agent-review:WI-8', round: 1 } },
      },
    });

    const out = await call({ mode: 'claim', id: 'WI-8' }, { harnessSlug: 'papercusp' });

    expect(h.claim).toHaveBeenCalledWith({
      id: 'WI-8',
      reviewer: 'su-reviewer',
      harnessSlug: 'papercusp',
    });
    expect(h.claimNext).not.toHaveBeenCalled();
    expect(body(out)).toEqual({
      ok: true,
      mode: 'claim',
      claimed: true,
      workItem: {
        id: 'WI-8',
        title: 'review me second',
        payload: { agentReview: { status: 'pending', submittedBy: 'su-filer', ledgerIdeaId: 'agent-review:WI-8', round: 1 } },
      },
      ledgerIdeaId: 'agent-review:WI-8',
      gradeWith: { ideaId: 'agent-review:WI-8' },
    });
  });

  it('claim-next derives reviewer identity and concrete harness from the caller context', async () => {
    h.claimNext.mockResolvedValue({
      id: 'WI-7',
      title: 'review me',
      payload: { agentReview: { status: 'pending', submittedBy: 'su-filer', ledgerIdeaId: 'agent-review:WI-7', round: 1 } },
    });

    const out = await call({ mode: 'claim-next' }, { harnessSlug: 'papercusp' });

    expect(h.claimNext).toHaveBeenCalledWith({ reviewer: 'su-reviewer', harnessSlug: 'papercusp' });
    expect(body(out)).toEqual({
      ok: true,
      mode: 'claim-next',
      claimed: true,
      workItem: {
        id: 'WI-7',
        title: 'review me',
        payload: { agentReview: { status: 'pending', submittedBy: 'su-filer', ledgerIdeaId: 'agent-review:WI-7', round: 1 } },
      },
      ledgerIdeaId: 'agent-review:WI-7',
      gradeWith: { ideaId: 'agent-review:WI-7' },
    });
  });

  it('claim-next fails loud when no single harness is resolvable', async () => {
    const out = await call({ mode: 'claim-next' }, { harnessSlug: '*' });

    expect(out.isError).toBe(true);
    expect(body(out)).toMatchObject({ error: 'harness_required', tool: 'improvements:agent-review' });
    expect(h.claimNext).not.toHaveBeenCalled();
  });

  it('returns an explicit clean miss when the review lane is empty', async () => {
    const out = await call({ mode: 'claim-next', harness: 'other-harness' }, { harnessSlug: 'papercusp' });

    expect(h.claimNext).toHaveBeenCalledWith({ reviewer: 'su-reviewer', harnessSlug: 'other-harness' });
    expect(body(out)).toEqual({ ok: true, mode: 'claim-next', claimed: false, workItem: null });
  });

  it('resubmit derives submittedBy from the caller and forwards only the named item', async () => {
    const out = await call({ mode: 'resubmit', id: 'WI-7' }, { harnessSlug: '*' });

    expect(h.resubmit).toHaveBeenCalledWith({ id: 'WI-7', submittedBy: 'su-reviewer' });
    expect(body(out)).toMatchObject({ ok: true, mode: 'resubmit', resubmitted: true });
  });

  it('is projected under its public MCP name and imported by the production registry', () => {
    const registered = lookupByMcpName('improvements:agent-review');
    expect(registered).toBeDefined();
    expect(registered!.capabilities).toContain('work_items:write');

    const registry = readFileSync(fileURLToPath(new URL('../index.ts', import.meta.url)), 'utf8');
    expect(registry).toMatch(/import\s+['"]\.\/improvements\/agent-review['"]/);
  });
});
