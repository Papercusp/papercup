import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { lookupByMcpName } from '@papercusp/agent-mcp';
import type { ToolResult as DispatchToolResult } from '@papercusp/tooldef';

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

import tool, { agentReviewAbortCompletionReceipt } from './agent-review';

type ToolResult = { content: Array<{ text: string }>; isError?: boolean };
const call = (args: Record<string, unknown>, ctx: Record<string, unknown> = {}) =>
  tool.handler(args as never, ctx as never) as Promise<ToolResult>;
const body = (result: ToolResult) => JSON.parse(result.content[0]!.text);
const dispatchResult = (value: unknown): DispatchToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(value) }],
});
const attempt = { callId: 'call-1', toolName: 'improvements:agent-review' };

beforeEach(() => {
  vi.clearAllMocks();
  h.identity.mockReturnValue({ ownerId: 'su-reviewer' });
  h.claim.mockResolvedValue({ claimed: false, workItem: null, reason: 'not-found' });
  h.claimNext.mockResolvedValue(null);
  h.resubmit.mockResolvedValue({ resubmitted: true, state: { status: 'pending', round: 2 } });
});

describe('improvements:agent-review public door', () => {
  it('declares a late-completion receipt on the public mutating tool', () => {
    expect(tool.abortCompletionReceipt).toBe(agentReviewAbortCompletionReceipt);
  });

  it('names completed directed and queue claims so callers do not retry them', () => {
    const directed = agentReviewAbortCompletionReceipt(
      { mode: 'claim', id: 'WI-8' },
      dispatchResult({ ok: true, mode: 'claim', claimed: true, workItem: { id: 'WI-8' } }),
      attempt,
    );
    const next = agentReviewAbortCompletionReceipt(
      { mode: 'claim-next' },
      dispatchResult({ ok: true, mode: 'claim-next', claimed: true, workItem: { id: 'WI-9' } }),
      attempt,
    );

    expect(directed).toEqual({ status: 'recorded', effectRef: 'improvements-agent-review:claim:WI-8' });
    expect(next).toEqual({ status: 'recorded', effectRef: 'improvements-agent-review:claim-next:WI-9' });
  });

  it('reports only pre-mutation directed misses as not-recorded and fails closed on ambiguous misses', () => {
    const missing = agentReviewAbortCompletionReceipt(
      { mode: 'claim', id: 'WI-missing' },
      dispatchResult({ ok: true, mode: 'claim', claimed: false, workItem: null, reason: 'not-found' }),
      attempt,
    );
    const repairedThenRefused = agentReviewAbortCompletionReceipt(
      { mode: 'claim', id: 'WI-8' },
      dispatchResult({ ok: true, mode: 'claim', claimed: false, workItem: null, reason: 'agent-review-not-pending' }),
      attempt,
    );
    const queueMiss = agentReviewAbortCompletionReceipt(
      { mode: 'claim-next' },
      dispatchResult({ ok: true, mode: 'claim-next', claimed: false, workItem: null }),
      attempt,
    );

    expect(missing).toEqual({ status: 'not-recorded', reason: 'not-found' });
    expect(repairedThenRefused).toMatchObject({ status: 'recovery-incomplete', failures: ['ambiguous-claim-outcome'] });
    expect(queueMiss).toMatchObject({ status: 'recovery-incomplete', failures: ['ambiguous-claim-outcome'] });
  });

  it('names the resubmitted review round and preserves explicit no-write refusals', () => {
    const recorded = agentReviewAbortCompletionReceipt(
      { mode: 'resubmit', id: 'WI-8' },
      dispatchResult({ ok: true, mode: 'resubmit', resubmitted: true, state: { status: 'pending', round: 2 } }),
      attempt,
    );
    const refused = agentReviewAbortCompletionReceipt(
      { mode: 'resubmit', id: 'WI-8' },
      dispatchResult({ ok: true, mode: 'resubmit', resubmitted: false, reason: 'not-submitter' }),
      attempt,
    );

    expect(recorded).toEqual({ status: 'recorded', effectRef: 'improvements-agent-review:resubmit:WI-8:round:2' });
    expect(refused).toEqual({ status: 'not-recorded', reason: 'not-submitter' });
  });

  it('fails closed when a result cannot prove the requested claim identity', () => {
    const mismatched = agentReviewAbortCompletionReceipt(
      { mode: 'claim', id: 'WI-8' },
      dispatchResult({ ok: true, mode: 'claim', claimed: true, workItem: { id: 'WI-9' } }),
      attempt,
    );
    const incomplete = agentReviewAbortCompletionReceipt(
      { mode: 'resubmit', id: 'WI-8' },
      dispatchResult({ ok: true, mode: 'resubmit', resubmitted: true, state: { status: 'pending' } }),
      attempt,
    );

    expect(mismatched).toMatchObject({ status: 'recovery-incomplete', failures: ['ambiguous-claim-outcome'] });
    expect(incomplete).toMatchObject({ status: 'recovery-incomplete', failures: ['missing-effect-identity'] });
  });

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
