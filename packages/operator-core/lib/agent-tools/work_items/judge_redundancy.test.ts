/**
 * judge_redundancy.test.ts — the work_items:judge_redundancy HANDLER error-reason
 * mapping + delegation (judgeRedundancyGroup, the build→judge→adopt core, is tested
 * separately; the LLM client is lazily imported and mocked). This pins the handler's
 * own logic: the reason→message mapping a caller reads —
 *   • item-not-found → "work-item <id> not found"
 *   • otherwise      → "need ≥2 complete replicas to judge (have N)"
 * the success passthrough, and the try/catch that turns a thrown error into an {ok:false}
 * result rather than a crash. A regression that swaps those messages, or lets the group
 * call throw out of the tool, is what this catches.
 *
 * In-tree (operator-core, tab-visible).
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/work_items/judge_redundancy.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../work-item-redundancy', () => ({
  judgeRedundancyGroup: vi.fn(),
  resolveReplicaPotSlug: vi.fn(async () => 'hive-x'),
}));
vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: vi.fn(() => 'default') }));
vi.mock('../../llm-testing/llm-client', () => ({ llmCall: vi.fn() }));

import { judgeRedundancyGroup } from '../../work-item-redundancy';
const judgeM = vi.mocked(judgeRedundancyGroup);
const tool = (await import('./judge_redundancy')).default;

type Out = { data: unknown };
const call = (args: Record<string, unknown> = {}) =>
  tool.handler({ id: 'F-1', harness: 'web', ...args } as never, {} as never) as Promise<Out>;
const body = (o: Out) => o.data as any;

beforeEach(() => vi.clearAllMocks());

describe('work_items:judge_redundancy handler', () => {
  it('maps item-not-found to a clear message', async () => {
    judgeM.mockResolvedValue({ ok: false, reason: 'item-not-found' } as never);
    const b = body(await call());
    expect(b.ok).toBe(false);
    expect(b.reason).toBe('item-not-found');
    expect(String(b.error)).toMatch(/F-1.*not found/i);
  });

  it('maps insufficient replicas to a "need ≥2 (have N)" message', async () => {
    judgeM.mockResolvedValue({ ok: false, reason: 'insufficient-replicas', completeCount: 1 } as never);
    const b = body(await call());
    expect(b.ok).toBe(false);
    expect(String(b.error)).toMatch(/≥2|2 complete/i);
    expect(String(b.error)).toMatch(/have 1/);
  });

  it('returns the judge result on success', async () => {
    judgeM.mockResolvedValue({ ok: true, winner: { replicaIndex: 2, composite: 0.9 }, replicas: [] } as never);
    const b = body(await call());
    expect(b).toMatchObject({ ok: true, winner: { replicaIndex: 2, composite: 0.9 } });
  });

  it('turns a thrown error into an {ok:false} result (never crashes the tool)', async () => {
    judgeM.mockRejectedValue(new Error('pg exploded'));
    const b = body(await call());
    expect(b).toMatchObject({ ok: false });
    expect(String(b.error)).toMatch(/pg exploded/);
  });
});
