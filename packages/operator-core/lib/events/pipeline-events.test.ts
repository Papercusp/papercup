/**
 * pipeline-events.test.ts — the pipeline fire-point emissions, pure via
 * injected seams (plugin-system-hive-port-2026-06-11 P-004 / D-003).
 */
import { describe, expect, it, vi } from 'vitest';
import { emitPipelineEvent, pipelineEventKey } from './pipeline-events';

const flush = () => new Promise((r) => setTimeout(r, 0));

const seams = () => ({
  emit: vi.fn(async () => ({ ok: true as const, key: '', woken: 0, notified: [], msgId: null })),
  system: vi.fn(),
});

describe('pipelineEventKey', () => {
  it('builds the exact await keys per event name', () => {
    expect(pipelineEventKey({ name: 'launch', harnessSlug: 'h' })).toBe('pipeline:launch:h');
    expect(pipelineEventKey({ name: 'step-start', harnessSlug: 'h', featureId: 'F-001', role: 'worker' }))
      .toBe('pipeline:step-start:h:F-001:worker');
    expect(pipelineEventKey({ name: 'step-done', harnessSlug: 'h', featureId: 'F-001', role: 'validator' }))
      .toBe('pipeline:step-done:h:F-001:validator');
    expect(pipelineEventKey({ name: 'done', harnessSlug: 'h', featureId: 'F-001' })).toBe('pipeline:done:h:F-001');
    expect(pipelineEventKey({ name: 'escalate', harnessSlug: 'h', featureId: 'F-001' })).toBe('pipeline:escalate:h:F-001');
  });
});

describe('emitPipelineEvent', () => {
  it('fires both legs: the reaction matcher (synchronously) and the awaited event', async () => {
    const deps = seams();
    emitPipelineEvent(
      { name: 'step-done', harnessSlug: 'h', featureId: 'F-001', role: 'worker', runId: 'h:F-001:worker:t3', exitCode: 0, durationMs: 1234 },
      deps,
    );
    // Reaction leg is synchronous up to the schedule point.
    expect(deps.system).toHaveBeenCalledOnce();
    expect(deps.system.mock.calls[0][0]).toMatchObject({
      tool: 'pipeline:step-done',
      harnessSlug: 'h',
      args: { name: 'step-done', harness: 'h', feature: 'F-001', role: 'worker', exitCode: 0, durationMs: 1234 },
    });
    await flush();
    expect(deps.emit).toHaveBeenCalledOnce();
    expect(deps.emit.mock.calls[0][0]).toMatchObject({
      key: 'pipeline:step-done:h:F-001:worker',
      source: 'pipeline',
      payload: expect.objectContaining({ runId: 'h:F-001:worker:t3' }),
    });
  });

  it('escalate carries the reason on both legs', async () => {
    const deps = seams();
    emitPipelineEvent({ name: 'escalate', harnessSlug: 'h', featureId: 'F-002', reason: 'stuck' }, deps);
    await flush();
    expect(deps.system.mock.calls[0][0].args).toMatchObject({ reason: 'stuck' });
    expect(deps.emit.mock.calls[0][0]).toMatchObject({
      key: 'pipeline:escalate:h:F-002',
      summary: expect.stringContaining('stuck'),
    });
  });

  it('never throws/rejects when a leg fails (fail-soft)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const deps = {
      emit: vi.fn(async () => { throw new Error('pg down'); }),
      system: vi.fn(() => { throw new Error('matcher exploded'); }),
    };
    expect(() => emitPipelineEvent({ name: 'launch', harnessSlug: 'h' }, deps as never)).not.toThrow();
    await flush();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('a missing event_awaits relation is silent fail-soft (partial test schemas)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const deps = {
      emit: vi.fn(async () => { throw new Error('relation "event_awaits" does not exist'); }),
      system: vi.fn(),
    };
    emitPipelineEvent({ name: 'done', harnessSlug: 'h', featureId: 'F-003' }, deps as never);
    await flush();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
