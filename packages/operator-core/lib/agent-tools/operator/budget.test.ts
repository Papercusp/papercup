/**
 * operator:budget — MCP tool handler coverage (Gap 4, wave-8).
 *
 * Pins the parts no other test reaches:
 *   - op:'set' spend-authority gate: a non-operator role MUST throw and
 *     MUST NOT reach setBudget (escalation guard at budget.ts ~L43).
 *   - op:'set' as operator forwards args.dailyCapUsd to setBudget verbatim.
 *   - op:'get' maps checkBudget() into the documented envelope, including
 *     `configured: !!state` and `spendHistory: state?.spend ?? []`.
 *
 * The lib (`checkBudget`/`setBudget`) is mocked so the handler is tested in
 * isolation. `tool.handler` is the raw role-gated handler — it does NOT run
 * the Zod `args` validation (the projection wrapper does, at dispatch time),
 * so we drive it with already-shaped args.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const MAKE_CTX = (over: Record<string, unknown> = {}) =>
  ({
    log: vi.fn(),
    signal: new AbortController().signal,
    progress: vi.fn(),
    workspaceId: 'default',
    harnessSlug: 'sheets',
    role: 'operator' as const,
    runId: 'run_T',
    spawnId: 'spw_T',
    ...over,
  }) as never;

function parsePayload(result: { content: Array<{ text: string }> }): Record<string, unknown> {
  return JSON.parse(result.content[0].text);
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.doUnmock('../../operator-budget');
});

describe('operator:budget — set (role gate)', () => {
  it('THROWS and never calls setBudget when ctx.role !== operator', async () => {
    const setBudget = vi.fn(async () => ({ dailyCapUsd: 20, spend: [] }));
    const checkBudget = vi.fn();
    vi.doMock('../../operator-budget', () => ({ setBudget, checkBudget }));
    const { default: tool } = await import('./budget');

    await expect(
      tool.handler({ op: 'set', dailyCapUsd: 50 }, MAKE_CTX({ role: 'architect' })),
    ).rejects.toThrow(/operator role/);
    // escalation guard: the spend-authority write must never fire for a non-operator
    expect(setBudget).not.toHaveBeenCalled();
  });

  it('throws for every non-operator SU role (worker/validator/reviewer/queen)', async () => {
    const setBudget = vi.fn(async () => ({ dailyCapUsd: 20, spend: [] }));
    vi.doMock('../../operator-budget', () => ({ setBudget, checkBudget: vi.fn() }));
    const { default: tool } = await import('./budget');
    for (const role of ['worker', 'validator', 'reviewer', 'mug', 'documenter']) {
      await expect(
        tool.handler({ op: 'set', dailyCapUsd: 10 }, MAKE_CTX({ role })),
      ).rejects.toThrow();
    }
    expect(setBudget).not.toHaveBeenCalled();
  });

  it('calls setBudget(args.dailyCapUsd) and returns ok envelope when role === operator', async () => {
    const setBudget = vi.fn(async (cap: number) => ({ dailyCapUsd: cap, spend: [] }));
    vi.doMock('../../operator-budget', () => ({ setBudget, checkBudget: vi.fn() }));
    const { default: tool } = await import('./budget');

    const result = await tool.handler({ op: 'set', dailyCapUsd: 42 }, MAKE_CTX({ role: 'operator' }));
    expect(setBudget).toHaveBeenCalledTimes(1);
    expect(setBudget).toHaveBeenCalledWith(42);
    expect(parsePayload(result as never)).toEqual({ ok: true, dailyCapUsd: 42 });
  });
});

describe('operator:budget — get (envelope mapping)', () => {
  it('maps checkBudget output into the documented envelope (configured:true)', async () => {
    const state = { dailyCapUsd: 20, spend: [{ date: '2026-06-17', usd: 3.5 }] };
    const checkBudget = vi.fn(async () => ({
      exceeded: false,
      todaySpendUsd: 3.5,
      capUsd: 20,
      state,
    }));
    const setBudget = vi.fn();
    vi.doMock('../../operator-budget', () => ({ checkBudget, setBudget }));
    const { default: tool } = await import('./budget');

    const result = await tool.handler({ op: 'get' }, MAKE_CTX({ role: 'worker' }));
    expect(parsePayload(result as never)).toEqual({
      configured: true,
      dailyCapUsd: 20,
      todaySpendUsd: 3.5,
      exceeded: false,
      spendHistory: state.spend,
    });
    // get is any role; setBudget must never be touched on a read
    expect(setBudget).not.toHaveBeenCalled();
  });

  it('reports configured:false and spendHistory:[] when no budget is set (state:null)', async () => {
    const checkBudget = vi.fn(async () => ({
      exceeded: false,
      todaySpendUsd: 0,
      capUsd: 0,
      state: null,
    }));
    vi.doMock('../../operator-budget', () => ({ checkBudget, setBudget: vi.fn() }));
    const { default: tool } = await import('./budget');

    const result = await tool.handler({ op: 'get' }, MAKE_CTX({ role: 'operator' }));
    expect(parsePayload(result as never)).toEqual({
      configured: false,
      dailyCapUsd: 0,
      todaySpendUsd: 0,
      exceeded: false,
      spendHistory: [],
    });
  });

  it('propagates exceeded:true through the envelope', async () => {
    const state = { dailyCapUsd: 5, spend: [{ date: '2026-06-17', usd: 5 }] };
    const checkBudget = vi.fn(async () => ({ exceeded: true, todaySpendUsd: 5, capUsd: 5, state }));
    vi.doMock('../../operator-budget', () => ({ checkBudget, setBudget: vi.fn() }));
    const { default: tool } = await import('./budget');

    const result = await tool.handler({ op: 'get' }, MAKE_CTX());
    expect(parsePayload(result as never).exceeded).toBe(true);
    expect(parsePayload(result as never).configured).toBe(true);
  });
});
