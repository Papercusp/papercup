import { describe, it, expect } from 'vitest';
import { runWithRateLimitTolerance, type DecideInvokeResult } from './decide-rate-limit';

/** A failed decide invoke whose output is the claude/codex transient-429 text (→ `rate_limited`). */
const rl = (extra = ''): DecideInvokeResult => ({
  output: `API Error: Server is temporarily limiting requests (not your usage limit) · Rate limited${extra}`,
  exitCode: 1,
});
const ok = (line = 'NEXT_WORKER F-1'): DecideInvokeResult => ({ output: line, exitCode: 0 });

/** A runner that returns a scripted sequence (last entry repeats once exhausted). */
function scripted(seq: DecideInvokeResult[]): { run: () => Promise<DecideInvokeResult>; calls: () => number } {
  let i = 0;
  return {
    run: async () => seq[Math.min(i++, seq.length - 1)],
    calls: () => i,
  };
}

function harness(seq: DecideInvokeResult[], opts: Partial<Parameters<typeof runWithRateLimitTolerance>[0]> = {}) {
  const waits: number[] = [];
  const s = scripted(seq);
  const result = runWithRateLimitTolerance({
    run: s.run,
    backend: 'claude-code',
    sleep: async (ms) => void waits.push(ms),
    now: () => 0,
    ...opts,
  });
  return { result, waits, calls: s.calls };
}

describe('runWithRateLimitTolerance', () => {
  it('returns a clean decision on the first try without waiting', async () => {
    const h = harness([ok()]);
    const r = await h.result;
    expect(r).toEqual(ok());
    expect(h.calls()).toBe(1);
    expect(h.waits).toEqual([]);
  });

  it('absorbs a transient 429 then succeeds (waits, re-invokes)', async () => {
    const h = harness([rl(), rl(), ok()]);
    const r = await h.result;
    expect(r.exitCode).toBe(0);
    expect(r.output).toBe('NEXT_WORKER F-1');
    expect(h.calls()).toBe(3); // two rate-limited + one success
    expect(h.waits.length).toBe(2); // one wait before each retry
  });

  it('honors the server retry-after when the message carries one', async () => {
    // "try again in 12 seconds" → 12_000ms; the fallback backoff is NOT used.
    const h = harness([rl(' — try again in 12 seconds'), ok()]);
    await h.result;
    expect(h.waits).toEqual([12_000]);
  });

  it('uses exponential fallback backoff (10s·2^i, capped 60s) when no retry-after', async () => {
    const h = harness([rl(), rl(), rl(), rl(), ok()]);
    await h.result;
    // i=0,1,2,3 → 10s, 20s, 40s, then 80s CAPPED to 60s; fifth call succeeded.
    expect(h.waits).toEqual([10_000, 20_000, 40_000, 60_000]);
  });

  it('gives up (returns the last failure) after exhausting maxAttempts on sustained 429s', async () => {
    const h = harness([rl()], { maxAttempts: 4 });
    const r = await h.result;
    expect(r.exitCode).toBe(1); // still failed → caller throws
    expect(h.calls()).toBe(4); // exactly maxAttempts invokes
    expect(h.waits.length).toBe(3); // one fewer wait than attempts (no wait after the last)
  });

  it('stops early when the next backoff would exceed the cumulative-wait cap', async () => {
    // Cap at 25s: waits 10s (i=0, total 10) then 20s would push total to 30 > 25 → give up.
    const h = harness([rl()], { maxTotalWaitMs: 25_000, maxAttempts: 99 });
    const r = await h.result;
    expect(r.exitCode).toBe(1);
    expect(h.waits).toEqual([10_000]);
    expect(h.calls()).toBe(2); // initial + one retry, then capped
  });

  it('does NOT retry a genuine crash failure (returns immediately for the caller to throw)', async () => {
    const crash: DecideInvokeResult = { output: 'TypeError: boom', exitCode: 1 };
    const h = harness([crash, ok()]);
    const r = await h.result;
    expect(r).toEqual(crash); // returned the crash, never reached the ok()
    expect(h.calls()).toBe(1);
    expect(h.waits).toEqual([]);
  });

  it('does NOT retry an empty clean output (empty_output, not a rate-limit)', async () => {
    const empty: DecideInvokeResult = { output: '   ', exitCode: 0 };
    const h = harness([empty, ok()]);
    const r = await h.result;
    expect(r).toEqual(empty);
    expect(h.calls()).toBe(1);
    expect(h.waits).toEqual([]);
  });

  it('does NOT retry a usage_limit cap (futile — must surface + park, not retry)', async () => {
    const cap: DecideInvokeResult = {
      output: 'Claude usage limit reached. Your limit will reset at 4pm.',
      exitCode: 1,
    };
    const h = harness([cap, ok()]);
    const r = await h.result;
    expect(r).toEqual(cap); // returned the cap immediately
    expect(h.calls()).toBe(1);
    expect(h.waits).toEqual([]);
  });
});
