/**
 * keyless-digest.test.ts — the improvements:keyless-digest HANDLER wiring (the policy
 * cores readOpenKeylessIssues/summarizeKeylessBacklog/planKeylessReview are mocked + unit-
 * tested separately). Pins that the handler samples the open keyless backlog, feeds it to
 * the summary + review planners with the resolved limits (defaults applied), and projects
 * { ok, policy, summary, review } — read-only (closes nothing). A regression that drops a
 * limit or mis-wires the planners is what this catches.
 *
 * In-tree (operator-core, tab-visible).
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/improvements/keyless-digest.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../coordination/identity', () => ({ resolveAgentIdentity: vi.fn(() => ({ ownerId: 'me' })) }));
vi.mock('../../harness/improvements/keyless-ei-policy', () => ({
  readOpenKeylessIssues: vi.fn(),
  summarizeKeylessBacklog: vi.fn(() => ({ total: 10, keyless: 4 })),
  planKeylessReview: vi.fn(() => [{ id: 'EI-1', disposition: 'claim-or-close' }]),
  KEYLESS_EI_POLICY: { name: 'keyless-policy' },
  DEFAULT_KEYLESS_REVIEW_LIMIT: 25,
}));

import { readOpenKeylessIssues, summarizeKeylessBacklog, planKeylessReview } from '../../harness/improvements/keyless-ei-policy';
const readM = vi.mocked(readOpenKeylessIssues);
const sumM = vi.mocked(summarizeKeylessBacklog);
const planM = vi.mocked(planKeylessReview);
const tool = (await import('./keyless-digest')).default;

type Out = { content: { text: string }[] };
const call = (args: Record<string, unknown> = {}) => tool.handler(args as never, {} as never) as Promise<Out>;
const body = (o: Out) => JSON.parse(o.content[0]!.text);

beforeEach(() => {
  vi.clearAllMocks();
  readM.mockResolvedValue({ total: 10, rows: [{ id: 'EI-1' }] } as never);
});

describe('improvements:keyless-digest handler', () => {
  it('samples the backlog and projects policy + summary + review', async () => {
    const b = body(await call());
    expect(b).toMatchObject({
      ok: true,
      policy: { name: 'keyless-policy' },
      summary: { total: 10, keyless: 4 },
      review: [{ id: 'EI-1', disposition: 'claim-or-close' }],
    });
    expect(readM).toHaveBeenCalledWith(500); // default sampleLimit
    expect(sumM).toHaveBeenCalled();
    expect(planM.mock.calls[0]![2]).toMatchObject({ limit: 25 }); // default reviewLimit
  });

  it('honors explicit reviewLimit / sampleLimit', async () => {
    await call({ reviewLimit: 5, sampleLimit: 100 });
    expect(readM).toHaveBeenCalledWith(100);
    expect(planM.mock.calls[0]![2]).toMatchObject({ limit: 5 });
  });
});
