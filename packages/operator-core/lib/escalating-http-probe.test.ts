import { describe, it, expect, vi } from 'vitest';
import { probeHttpReachable } from './escalating-http-probe';

const timeoutErr = () => Object.assign(new Error('timed out'), { name: 'TimeoutError' });
const resp = (status: number) => ({ status }) as Response;

describe('probeHttpReachable (shared escalating-timeout probe — EI-1693/WI-266)', () => {
  it('reachable on the first answer, no retry', async () => {
    const f = vi.fn(async () => resp(200));
    const r = await probeHttpReachable('http://x/healthz', { timeouts: [5, 5], gapMs: 0, fetchImpl: f });
    expect(r).toEqual({ reachable: true, detail: 'HTTP 200' });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('a transient timeout THEN a 503 (alive, pacing) → reachable, notes the retry', async () => {
    let n = 0;
    const f = vi.fn(async () => { if (n++ === 0) throw timeoutErr(); return resp(503); });
    const r = await probeHttpReachable('http://x/healthz', { timeouts: [5, 50], gapMs: 0, fetchImpl: f });
    expect(r.reachable).toBe(true);
    expect(r.detail).toBe('HTTP 503 (after 1 retry)');
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('unreachable only when EVERY escalating attempt fails', async () => {
    const f = vi.fn(async () => { throw timeoutErr(); });
    const r = await probeHttpReachable('http://x/healthz', { timeouts: [5, 5], gapMs: 0, fetchImpl: f });
    expect(r.reachable).toBe(false);
    expect(r.detail).toMatch(/attempts, escalating to 5ms/);
    expect(f).toHaveBeenCalledTimes(2);
  });
});
