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
const getWorkItemCheckpointWithMeta = vi.fn();
const getWorkItemCheckpointFreshness = vi.fn();

vi.mock('../../work-items', () => ({
  getWorkItem: (...args: unknown[]) => getWorkItem(...args),
  getWorkItemDetail: (...args: unknown[]) => getWorkItemDetail(...args),
  getWorkItemThreadWindow: (...args: unknown[]) => getWorkItemThreadWindow(...args),
  SETTLED_WORK_ITEM_STATES: ['passed', 'deprecated', 'resolved', 'closed', 'done', 'dropped'],
}));

vi.mock('../../work-item-checkpoint', () => ({
  getWorkItemCheckpointWithMeta: (...args: unknown[]) => getWorkItemCheckpointWithMeta(...args),
  getWorkItemCheckpointFreshness: (...args: unknown[]) => getWorkItemCheckpointFreshness(...args),
}));

import get, { WORK_ITEMS_GET_BUDGET_MS } from './get';

type Out = { data: { results: Array<Record<string, unknown>> } };
const ctx = { uiClientId: 'su-deadline-test', workspaceId: 'default' };

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

    const pending = get.handler({ id: 'WI-timeout' } as never, ctx as never) as Promise<Out>;
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

    const out = (await get.handler({ id: 'WI-missing' } as never, ctx as never)) as Out;
    expect(out.data.results[0]).toMatchObject({
      ok: false,
      id: 'WI-missing',
      error: "work_item 'WI-missing' not found",
    });
    expect(out.data.results[0]).not.toHaveProperty('retryable');
    expect(out.data.results[0]).toMatchObject({ availability: 'absent' });
  });

  it('runs a projected 10-item summary as one concurrent wave and skips historical enrichments', async () => {
    const ids = Array.from({ length: 10 }, (_, index) => `WI-${index + 1}`);
    getWorkItem.mockImplementation(async (id: string) => {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      return { id, kind: 'feature', family: 'feature', harness: 'papercusp', state: 'open', title: id };
    });
    const metadata = vi.fn();
    const pending = get.handler(
      { ids } as never,
      {
        ...ctx,
        signal: new AbortController().signal,
        metadata,
        sourceProjection: {
          pick: ['results[].id', 'results[].workItem.state', 'results[].workItem.title', 'counts', 'read'],
        },
      } as never,
    ) as Promise<Out & { data: { read: Record<string, unknown> } }>;

    await vi.advanceTimersByTimeAsync(1_001);
    const out = await pending;

    expect(getWorkItem).toHaveBeenCalledTimes(10);
    expect(getWorkItemCheckpointWithMeta).not.toHaveBeenCalled();
    expect(out.data.results).toHaveLength(10);
    expect(out.data.results.every((row) => row.availability === 'available')).toBe(true);
    expect(out.data.read).toMatchObject({
      schemaVersion: 'work-items-get-read-v1',
      mode: 'projected',
      requested: 10,
      available: 10,
      absent: 0,
      unavailable: 0,
      baseReadMaxMs: 1_000,
      enrichmentMaxMs: 0,
    });
    expect(Number(out.data.read.elapsedMs)).toBeLessThan(2_000);
    expect(metadata).toHaveBeenCalledWith(expect.objectContaining({ workItemsGet: out.data.read }));
  });

  it('returns cancelled as unavailable and consumes a late storage rejection', async () => {
    let rejectRead!: (error: Error) => void;
    getWorkItem.mockImplementation(() => new Promise((_resolve, reject) => { rejectRead = reject; }));
    const controller = new AbortController();
    const pending = get.handler(
      { id: 'WI-cancelled' } as never,
      {
        ...ctx,
        signal: controller.signal,
        sourceProjection: { pick: ['results[].id', 'results[].workItem.state', 'read'] },
      } as never,
    ) as Promise<Out>;

    controller.abort();
    const out = await pending;
    expect(out.data.results[0]).toMatchObject({
      id: 'WI-cancelled',
      availability: 'unavailable',
      error: 'cancelled',
      retryable: true,
      phase: 'read',
    });

    rejectRead(new Error('late storage failure'));
    await Promise.resolve();
  });
});
