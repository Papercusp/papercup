/**
 * work_items:get — bounded read deadline (EI-22462490203993359).
 *
 * A pool-stalled base read must return a keyed, retryable timeout result before
 * the MCP request deadline. It must never be rendered as not-found, because
 * that would invite a caller to act on an item whose read never completed.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { DbCallDeadlineError } from '@papercusp/db-org';
import { OrgTxnTimeoutError } from '../../pg-bounded-txn';

const getWorkItem = vi.fn();
const getWorkItemsByIds = vi.fn();
const getWorkItemDetail = vi.fn();
const getWorkItemThreadWindow = vi.fn();
const getWorkItemCheckpointWithMeta = vi.fn();
const getWorkItemCheckpointFreshness = vi.fn();
const listSpecEvidence = vi.fn();

vi.mock('../../work-items', () => ({
  getWorkItem: (...args: unknown[]) => getWorkItem(...args),
  getWorkItemsByIds: (...args: unknown[]) => getWorkItemsByIds(...args),
  getWorkItemDetail: (...args: unknown[]) => getWorkItemDetail(...args),
  getWorkItemThreadWindow: (...args: unknown[]) => getWorkItemThreadWindow(...args),
  SETTLED_WORK_ITEM_STATES: ['passed', 'deprecated', 'resolved', 'closed', 'done', 'dropped'],
}));

vi.mock('../../work-item-checkpoint', () => ({
  getWorkItemCheckpointWithMeta: (...args: unknown[]) => getWorkItemCheckpointWithMeta(...args),
  getWorkItemCheckpointFreshness: (...args: unknown[]) => getWorkItemCheckpointFreshness(...args),
}));

vi.mock('../plans/spec-evidence-store', async (original) => ({
  ...(await original<typeof import('../plans/spec-evidence-store')>()),
  listSpecEvidence: (...args: unknown[]) => listSpecEvidence(...args),
}));

import get, { WORK_ITEMS_GET_BUDGET_MS, WORK_ITEMS_GET_MAX_CONCURRENCY } from './get';

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

  it('bounds a full-detail read that never settles instead of waiting for the MCP deadline', async () => {
    getWorkItemDetail.mockImplementation(() => new Promise(() => {}));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const pending = get.handler({ id: 'WI-detail-timeout', detail: true } as never, ctx as never) as Promise<Out>;
    await vi.advanceTimersByTimeAsync(WORK_ITEMS_GET_BUDGET_MS + 100);

    const out = await pending;
    expect(out.data.results[0]).toMatchObject({
      ok: false,
      id: 'WI-detail-timeout',
      availability: 'unavailable',
      error: 'timeout',
      retryable: true,
      phase: 'read',
      budgetMs: WORK_ITEMS_GET_BUDGET_MS,
    });
    expect(out.data.results[0]).not.toMatchObject({ error: expect.stringContaining('not found') });
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('work_items:get:WI-detail-timeout exceeded'));

    warnSpy.mockRestore();
  });

  it('bounds resume enrichment when a checkpoint dependency never settles', async () => {
    getWorkItem.mockResolvedValue({
      id: 'WI-resume-timeout',
      kind: 'bug',
      family: 'issue',
      harness: 'papercusp',
      state: 'open',
      title: 'resume timeout',
      assignee: 'su-test',
    });
    getWorkItemCheckpointWithMeta.mockImplementation(() => new Promise(() => {}));
    getWorkItemCheckpointFreshness.mockResolvedValue({ verdict: 'fresh' });
    listSpecEvidence.mockResolvedValue([]);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const pending = get.handler(
      { id: 'WI-resume-timeout', resume: true } as never,
      ctx as never,
    ) as Promise<Out>;
    await vi.advanceTimersByTimeAsync(WORK_ITEMS_GET_BUDGET_MS + 100);

    const out = await pending;
    expect(out.data.results[0]).toMatchObject({
      ok: false,
      id: 'WI-resume-timeout',
      availability: 'unavailable',
      error: 'timeout',
      retryable: true,
      phase: 'read',
      budgetMs: WORK_ITEMS_GET_BUDGET_MS,
    });
    expect(getWorkItemCheckpointWithMeta).toHaveBeenCalledOnce();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('work_items:get:WI-resume-timeout exceeded'));

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

  it('runs a payload-dependent 10-item summary in a bounded concurrent pool and skips historical enrichments', async () => {
    const ids = Array.from({ length: 10 }, (_, index) => `WI-${index + 1}`);
    let active = 0;
    let peak = 0;
    getWorkItem.mockImplementation(async (id: string) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      active -= 1;
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
          pick: [
            'results[].id',
            'results[].workItem.state',
            'results[].workItem.title',
            'results[].workItem.payload.futureField',
            'counts',
            'read',
          ],
        },
      } as never,
    ) as Promise<Out & { data: { read: Record<string, unknown> } }>;

    await vi.advanceTimersByTimeAsync(3_001);
    const out = await pending;

    expect(getWorkItem).toHaveBeenCalledTimes(10);
    expect(peak).toBe(WORK_ITEMS_GET_MAX_CONCURRENCY);
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
    expect(Number(out.data.read.elapsedMs)).toBeLessThan(4_000);
    expect(metadata).toHaveBeenCalledWith(expect.objectContaining({ workItemsGet: out.data.read }));
  });

  it('uses one set-based read for projected multi-id completion evidence', async () => {
    const ids = ['WI-batch-1', 'WI-batch-2', 'WI-batch-3', 'WI-batch-4', 'WI-batch-5', 'WI-batch-6'];
    getWorkItemsByIds.mockResolvedValue(
      ids.map((id) => ({
        id,
        kind: 'bug',
        family: 'issue',
        harness: 'papercusp',
        state: 'done',
        title: id,
        terminalCompletionEvidence: { summary: `${id} complete` },
      })),
    );

    const out = (await get.handler(
      { ids, detail: true, threadLimit: 0 } as never,
      {
        ...ctx,
        sourceProjection: {
          pick: [
            'results[].id',
            'results[].workItem.state',
            'results[].completion.filesChanged',
            'results[].completion.testsRun',
            'results[].completion.testResult',
            'read',
          ],
        },
      } as never,
    )) as Out & { data: { read: Record<string, unknown> } };

    expect(getWorkItemsByIds).toHaveBeenCalledOnce();
    expect(getWorkItemsByIds).toHaveBeenCalledWith(
      ids,
      undefined,
      { includeBody: false, payloadProjection: 'completionEvidence' },
    );
    expect(getWorkItem).not.toHaveBeenCalled();
    expect(out.data.results).toHaveLength(ids.length);
    expect(out.data.results.every((row) => row.availability === 'available')).toBe(true);
    expect(out.data.read).toMatchObject({ requested: ids.length, available: ids.length, unavailable: 0 });
  });

  it('runs detail=true with threadLimit in the bounded pool instead of serializing the batch', async () => {
    const ids = ['WI-detail-1', 'WI-detail-2', 'WI-detail-3', 'WI-detail-4'];
    let active = 0;
    let peak = 0;
    getWorkItem.mockImplementation(async (id: string) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      active -= 1;
      return { id, kind: 'bug', family: 'issue', harness: 'papercusp', state: 'open', title: id };
    });
    getWorkItemThreadWindow.mockResolvedValue({ total: 1, posts: [], topics: [] });

    const pending = get.handler(
      { ids, detail: true, threadLimit: 5 } as never,
      {
        ...ctx,
        sourceProjection: {
          pick: ['results[].id', 'results[].workItem.state', 'results[].threadWindow', 'counts', 'read'],
        },
      } as never,
    ) as Promise<Out>;

    await vi.advanceTimersByTimeAsync(1_001);
    const out = await pending;

    expect(getWorkItemDetail).not.toHaveBeenCalled();
    expect(getWorkItem).toHaveBeenCalledTimes(ids.length);
    expect(getWorkItemThreadWindow).toHaveBeenCalledTimes(ids.length);
    expect(peak).toBe(Math.min(ids.length, WORK_ITEMS_GET_MAX_CONCURRENCY));
    expect(out.data.results).toHaveLength(ids.length);
    expect(out.data.results.every((row) => row.availability === 'available')).toBe(true);
    expect(
      out.data.results.every(
        (row) => (row.threadWindow as { total?: number } | undefined)?.total === 1,
      ),
    ).toBe(true);
  });

  it('keeps detail:true with threadLimit:0 on the lean completion-evidence source path', async () => {
    getWorkItem.mockResolvedValue({
      id: 'WI-terminal-detail-projection',
      kind: 'bug',
      family: 'issue',
      harness: 'papercusp',
      state: 'resolved',
      title: 'terminal item',
      terminalCompletionEvidence: { summary: 'already verified' },
    });

    const out = await get.handler(
      {
        id: 'WI-terminal-detail-projection',
        detail: true,
        threadLimit: 0,
      } as never,
      {
        ...ctx,
        sourceProjection: {
          pick: [
            'results[].id',
            'results[].workItem.terminalCompletionEvidence',
            'counts',
            'read',
          ],
        },
      } as never,
    ) as Out;

    expect(getWorkItemDetail).not.toHaveBeenCalled();
    expect(getWorkItem).toHaveBeenCalledWith(
      'WI-terminal-detail-projection',
      undefined,
      { includeBody: false, payloadProjection: 'completionEvidence' },
    );
    expect(out.data.results[0]).toMatchObject({
      ok: true,
      id: 'WI-terminal-detail-projection',
      availability: 'available',
    });
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

  it.each([
    ['bounded transaction lock timeout', () => new OrgTxnTimeoutError('55P03', new Error('lock timeout')), '55P03'],
    ['raw PostgreSQL statement timeout', () => Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' }), '57014'],
  ])('maps %s to a retryable unavailable result instead of a generic bulk error', async (_label, makeError, pgCode) => {
    getWorkItem.mockRejectedValueOnce(makeError());

    const out = (await get.handler({ id: 'WI-contention' } as never, ctx as never)) as Out;
    expect(out.data.results[0]).toMatchObject({
      ok: false,
      id: 'WI-contention',
      availability: 'unavailable',
      error: 'timeout',
      retryable: true,
      phase: 'read',
      pgCode,
    });
    expect(out.data.results[0].message).toContain('retry shortly');
  });

  it('maps a pool acquisition deadline to the same retryable unavailable contract without inventing a PG code', async () => {
    getWorkItem.mockRejectedValueOnce(
      new DbCallDeadlineError('work_items:get:acquire', 8_000, 8_000, 'org-admin'),
    );

    const out = (await get.handler({ id: 'WI-pool-deadline' } as never, ctx as never)) as Out;
    expect(out.data.results[0]).toMatchObject({
      ok: false,
      id: 'WI-pool-deadline',
      availability: 'unavailable',
      error: 'timeout',
      retryable: true,
      phase: 'read',
    });
    expect(out.data.results[0].pgCode).toBeUndefined();
    expect(out.data.results[0].message).toContain('retry shortly');
  });
});
