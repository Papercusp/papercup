/**
 * work_items:get — bounded read deadline (EI-22462490203993359).
 *
 * A pool-stalled base read must return a keyed, retryable timeout result before
 * the MCP request deadline. It must never be rendered as not-found, because
 * that would invite a caller to act on an item whose read never completed.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

const getWorkItem = vi.fn();
const getWorkItemDetail = vi.fn();
const getWorkItemThreadWindow = vi.fn();

vi.mock('../../work-items', () => ({
  getWorkItem: (...args: unknown[]) => getWorkItem(...args),
  getWorkItemDetail: (...args: unknown[]) => getWorkItemDetail(...args),
  getWorkItemThreadWindow: (...args: unknown[]) => getWorkItemThreadWindow(...args),
  SETTLED_WORK_ITEM_STATES: ['passed', 'deprecated', 'resolved', 'closed', 'done', 'dropped'],
}));

vi.mock('../../work-item-checkpoint', () => ({
  getWorkItemCheckpointWithMeta: vi.fn(),
  getWorkItemCheckpointFreshness: vi.fn(),
}));

import get, { WORK_ITEMS_GET_BUDGET_MS } from './get';

type Out = { data: { results: Array<Record<string, unknown>> } };
const ctx = { uiClientId: 'su-deadline-test', workspaceId: 'default' } as never;

describe('work_items:get bounded read deadline (EI-22462490203993359)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns a retryable timeout instead of not-found when the base read never settles', async () => {
    getWorkItem.mockImplementation(() => new Promise(() => {}));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const pending = get.handler({ id: 'WI-timeout' } as never, ctx) as Promise<Out>;
    await vi.advanceTimersByTimeAsync(WORK_ITEMS_GET_BUDGET_MS + 100);

    const out = await pending;
    expect(out.data.results[0]).toMatchObject({
      ok: false,
      id: 'WI-timeout',
      error: 'timeout',
      retryable: true,
      phase: 'read',
      budgetMs: WORK_ITEMS_GET_BUDGET_MS,
    });
    expect(out.data.results[0]).not.toMatchObject({ error: expect.stringContaining('not found') });
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('work_items:get:WI-timeout exceeded'));

    warnSpy.mockRestore();
  });

  it('keeps a completed not-found read distinct from timeout', async () => {
    getWorkItem.mockResolvedValue(null);

    const out = (await get.handler({ id: 'WI-missing' } as never, ctx)) as Out;
    expect(out.data.results[0]).toMatchObject({
      ok: false,
      id: 'WI-missing',
      error: "work_item 'WI-missing' not found",
    });
    expect(out.data.results[0]).not.toHaveProperty('retryable');
  });
});
