import { describe, expect, it, vi } from 'vitest';
import { startOnDemandBackendWithWatermark } from './on-demand-start';

/** Records the interleaving of watermark stamps and the start so ORDER is what gets asserted. */
function recorder(startResult: { ok: boolean; error?: string }, opts: { markBusyFails?: boolean } = {}) {
  const events: string[] = [];
  const deps = {
    markBusy: vi.fn(async () => {
      events.push('markBusy');
      if (opts.markBusyFails) throw new Error('pg down');
    }),
    start: vi.fn(async () => {
      events.push('start');
      return startResult;
    }),
    log: vi.fn(),
  };
  return { events, deps };
}

describe('startOnDemandBackendWithWatermark (WI-10006360)', () => {
  it('stamps the idle watermark BEFORE the start, so a sweep at readiness cannot reap it', () => {
    // The race: a stopped backend's last_busy_at is older than its TTL. If the only stamp lands
    // after readiness, a reaper sweep between "slots read idle" and that stamp stops the backend
    // before it serves the request that started it (measured: ~2s after a 3m42s cold start).
    const { events, deps } = recorder({ ok: true });
    return startOnDemandBackendWithWatermark('ornith-llamaserver', deps).then((r) => {
      expect(r).toEqual({ ok: true });
      expect(events).toEqual(['markBusy', 'start', 'markBusy']);
    });
  });

  it('does not re-stamp after a failed start (a dead backend must age out normally)', async () => {
    const { events, deps } = recorder({ ok: false, error: 'start failed' });
    const r = await startOnDemandBackendWithWatermark('b', deps);
    expect(r).toEqual({ ok: false, error: 'start failed' });
    expect(events).toEqual(['markBusy', 'start']);
  });

  it('never fails the start because a watermark write failed — it warns instead', async () => {
    const { events, deps } = recorder({ ok: true }, { markBusyFails: true });
    const r = await startOnDemandBackendWithWatermark('b', deps);
    expect(r.ok).toBe(true);
    expect(events).toEqual(['markBusy', 'start', 'markBusy']);
    const warnings = deps.log.mock.calls.filter((c) => c[0] === 'warn').map((c) => String(c[1]));
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain('could not pre-stamp');
    expect(warnings[1]).toContain('could not stamp');
  });
});
