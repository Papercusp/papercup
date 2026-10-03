import { afterEach, describe, expect, it, vi } from 'vitest';
import { LspAdmissionController, lspAdmissionClass, runLspAdmission, type LspAdmissionContext, type LspAdmissionReceipt } from './lsp-admission';

const deferred = <T = void>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
};
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const context = (id: string, extra: Partial<LspAdmissionContext> = {}): LspAdmissionContext => ({
  workspaceId: 'test-lsp', requestId: id, language: 'typescript', projectRoot: '/repo', op: 'references',
  actor: 'a', deadlineAtMs: Date.now() + 60_000, ...extra,
});
const receipt = (): LspAdmissionReceipt => ({ start: vi.fn(async () => {}), finish: vi.fn(async () => {}), cancel: vi.fn(async () => {}) });
afterEach(() => { vi.useRealTimers(); });

describe('LSP class admission', () => {
  it('keeps definitions and different symbol costs independent of a blocked scan', async () => {
    const persisted = receipt();
    const enqueue = vi.fn(async () => persisted);
    const controller = new LspAdmissionController({ enqueue });
    const scan = deferred();
    const first = controller.run(context('scan', { symbolCost: 'scan' }), () => scan.promise);
    const secondTask = vi.fn(async () => 'second');
    const second = controller.run(context('queued-scan', { symbolCost: 'scan' }), secondTask);
    await flush();
    await expect(controller.run(context('definition', { op: 'symbol' }), async () => 'cheap')).resolves.toBe('cheap');
    await expect(controller.run(context('index-hit', { symbolCost: 'index-hit' }), async () => 'index-hit')).resolves.toBe('index-hit');
    expect(secondTask).not.toHaveBeenCalled();
    expect(controller.snapshot().classes.find(c => c.classKey === lspAdmissionClass(context('x', { symbolCost: 'scan' })))?.queued).toBe(1);
    scan.resolve();
    await first; await expect(second).resolves.toBe('second');
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(persisted.start).toHaveBeenCalledTimes(1);
    expect(persisted.finish).toHaveBeenCalledTimes(1);
  });

  it('serves another agent before the first agents backlog and respects priority', async () => {
    const controller = new LspAdmissionController({ enqueue: async () => receipt(), controller: { healthySamplesPerIncrease: 100 } });
    const hold = deferred();
    const first = controller.run(context('first'), () => hold.promise);
    const order: string[] = [];
    const submit = (id: string, actor: string, priority = 0) => controller.run(context(id, { actor, priority }), async () => { order.push(id); });
    const a1 = submit('a1', 'a'); const a2 = submit('a2', 'a'); const b1 = submit('b1', 'b');
    const urgent = submit('urgent', 'a', 10);
    await flush(); hold.resolve();
    await Promise.all([first, a1, a2, b1, urgent]);
    expect(order).toEqual(['urgent', 'b1', 'a1', 'a2']);
  });

  it('expires queued requests without executing them and cancels their durable receipt', async () => {
    vi.useFakeTimers();
    const queuedReceipt = receipt();
    const controller = new LspAdmissionController({ enqueue: async () => queuedReceipt });
    const hold = deferred();
    const first = controller.run(context('first'), () => hold.promise);
    const task = vi.fn(async () => 'late');
    const queued = controller.run(context('queued', { deadlineAtMs: Date.now() + 20 }), task);
    const rejected = expect(queued).rejects.toMatchObject({ code: 'deadline' });
    await flush(); await vi.advanceTimersByTimeAsync(20); await rejected;
    expect(task).not.toHaveBeenCalled();
    expect(queuedReceipt.cancel).toHaveBeenCalledTimes(1);
    expect(controller.snapshot().classes[0].queued).toBe(0);
    hold.resolve(); await first;
  });

  it('retains occupied capacity after cancellation until the wire task actually settles', async () => {
    const controller = new LspAdmissionController({ enqueue: async () => receipt(), controller: { healthySamplesPerIncrease: 100 } });
    const abort = new AbortController(); const hold = deferred();
    const first = controller.run(context('first', { signal: abort.signal }), () => hold.promise);
    const rejected = expect(first).rejects.toMatchObject({ code: 'cancelled' });
    const task = vi.fn(async () => 'next');
    const next = controller.run(context('next'), task);
    await flush(); abort.abort(); await rejected; await flush();
    expect(task).not.toHaveBeenCalled(); expect(controller.snapshot().classes[0].inFlight).toBe(1);
    hold.resolve(); await expect(next).resolves.toBe('next');
  });

  it('cancels a receipt materialized after the caller abandoned persistence', async () => {
    const saving = deferred<LspAdmissionReceipt>(); const persisted = receipt();
    const controller = new LspAdmissionController({ enqueue: () => saving.promise });
    const hold = deferred(); const first = controller.run(context('first'), () => hold.promise);
    const abort = new AbortController(); const task = vi.fn(async () => {});
    const queued = controller.run(context('queued', { signal: abort.signal }), task);
    const rejected = expect(queued).rejects.toMatchObject({ code: 'cancelled' });
    abort.abort(); await rejected; saving.resolve(persisted); await flush();
    expect(persisted.cancel).toHaveBeenCalledTimes(1); expect(task).not.toHaveBeenCalled();
    hold.resolve(); await first;
  });

  it('refuses failed pressure persistence and resumes unbounded upward probes after clean work', async () => {
    const controller = new LspAdmissionController({ enqueue: async () => { throw new Error('store unavailable'); }, controller: { healthySamplesPerIncrease: 1 } });
    const hold = deferred(); const first = controller.run(context('first'), () => hold.promise);
    const task = vi.fn(async () => {});
    await expect(controller.run(context('queued'), task)).rejects.toMatchObject({ code: 'persistence' });
    expect(task).not.toHaveBeenCalled(); hold.resolve(); await first;
    for (let i = 0; i < 12; i++) await controller.run(context(`probe-${i}`), async () => {});
    expect(controller.snapshot().classes[0].desiredWindow).toBeGreaterThan(12);
  });

  it('returns an explicit degraded deadline answer rather than a certified empty', async () => {
    const task = vi.fn();
    const answer = await runLspAdmission(context('expired', { deadlineAtMs: Date.now() - 1 }), task);
    expect(answer.freshness.health).toBe('degraded'); expect(answer.error).toContain('deadline');
    expect(answer.truncation.totalAvailable).toBeNull(); expect(task).not.toHaveBeenCalled();
  });
});
