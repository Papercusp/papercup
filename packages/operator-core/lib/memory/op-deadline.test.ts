/**
 * op-deadline.test.ts — the memory degraded latch (self-healing) + deadline race.
 *
 * The latch was previously a permanent boolean cleared only on restart: one transient
 * memory timeout (a load spike / a client cold-init window) disabled memory
 * auto-injection for the whole process lifetime. These tests pin the self-healing
 * cooldown behavior so a transient timeout can never again permanently starve
 * injection.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  MemoryTimeoutError,
  isMemoryDegraded,
  noteMemoryFailure,
  resetMemoryDegradedForTest,
  memoryDegradedCooldownMs,
  withMemoryTimeout,
  withMemoryWriteRetry,
  memoryWriteMaxAttempts,
  memoryWriteRetryBackoffMs,
  embedFailureReason,
} from './op-deadline';

describe('memory degraded latch — self-healing', () => {
  beforeEach(() => {
    resetMemoryDegradedForTest();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    resetMemoryDegradedForTest();
  });

  it('starts not-degraded', () => {
    expect(isMemoryDegraded()).toBe(false);
  });

  it('a memory timeout arms the latch, then it AUTO-CLEARS after the cooldown (no restart)', () => {
    noteMemoryFailure(new MemoryTimeoutError('memory search exceeded 10000ms'));
    expect(isMemoryDegraded()).toBe(true);
    vi.advanceTimersByTime(memoryDegradedCooldownMs() - 1);
    expect(isMemoryDegraded()).toBe(true); // still inside the cooldown
    vi.advanceTimersByTime(2);
    expect(isMemoryDegraded()).toBe(false); // self-healed — the key fix
  });

  it('a NON-timeout error does not arm the latch', () => {
    noteMemoryFailure(new Error('connection reset'));
    expect(isMemoryDegraded()).toBe(false);
  });

  it('a fresh timeout during the cooldown re-arms (extends) the quiet window', () => {
    noteMemoryFailure(new MemoryTimeoutError('t1'));
    vi.advanceTimersByTime(memoryDegradedCooldownMs() - 100);
    noteMemoryFailure(new MemoryTimeoutError('t2')); // re-arm near the end of the window
    vi.advanceTimersByTime(200); // past the FIRST window…
    expect(isMemoryDegraded()).toBe(true); // …but still inside the re-armed one
    vi.advanceTimersByTime(memoryDegradedCooldownMs());
    expect(isMemoryDegraded()).toBe(false);
  });

  it('the cooldown is env-tunable', () => {
    const prev = process.env.PAPERCUSP_MEMORY_DEGRADED_COOLDOWN_MS;
    process.env.PAPERCUSP_MEMORY_DEGRADED_COOLDOWN_MS = '5000';
    try {
      expect(memoryDegradedCooldownMs()).toBe(5000);
    } finally {
      if (prev === undefined) delete process.env.PAPERCUSP_MEMORY_DEGRADED_COOLDOWN_MS;
      else process.env.PAPERCUSP_MEMORY_DEGRADED_COOLDOWN_MS = prev;
    }
  });

  it('an invalid/zero env cooldown falls back to the 60s default', () => {
    const prev = process.env.PAPERCUSP_MEMORY_DEGRADED_COOLDOWN_MS;
    process.env.PAPERCUSP_MEMORY_DEGRADED_COOLDOWN_MS = '0';
    try {
      expect(memoryDegradedCooldownMs()).toBe(60_000);
    } finally {
      if (prev === undefined) delete process.env.PAPERCUSP_MEMORY_DEGRADED_COOLDOWN_MS;
      else process.env.PAPERCUSP_MEMORY_DEGRADED_COOLDOWN_MS = prev;
    }
  });
});

describe('withMemoryTimeout — deadline race', () => {
  it('rejects with MemoryTimeoutError when the op exceeds the deadline', async () => {
    const slow = new Promise((resolve) => setTimeout(resolve, 1000));
    await expect(withMemoryTimeout(slow, 'slow-op', 10)).rejects.toBeInstanceOf(MemoryTimeoutError);
  });

  it('resolves with the value when the op beats the deadline', async () => {
    await expect(withMemoryTimeout(Promise.resolve('ok'), 'fast-op', 1000)).resolves.toBe('ok');
  });
});

describe('withMemoryWriteRetry — bounded retry so a transient timeout does not silently drop the fact (EI-6684)', () => {
  // A never-settling promise simulates a wedged write; the tool deadline is
  // shrunk so it fires in ~20ms (real timers) instead of 10s.
  const NEVER = <T>(): Promise<T> => new Promise<T>(() => {});
  const noSleep = async () => {};
  let prevTimeout: string | undefined;

  beforeEach(() => {
    resetMemoryDegradedForTest();
    prevTimeout = process.env.PAPERCUSP_MEMORY_TOOL_TIMEOUT_MS;
    process.env.PAPERCUSP_MEMORY_TOOL_TIMEOUT_MS = '20';
  });
  afterEach(() => {
    resetMemoryDegradedForTest();
    if (prevTimeout === undefined) delete process.env.PAPERCUSP_MEMORY_TOOL_TIMEOUT_MS;
    else process.env.PAPERCUSP_MEMORY_TOOL_TIMEOUT_MS = prevTimeout;
    delete process.env.PAPERCUSP_MEMORY_WRITE_MAX_ATTEMPTS;
  });

  it('RETRIES a transient timeout and succeeds on the second attempt — the fact is NOT dropped', async () => {
    let calls = 0;
    const attempt = () => {
      calls += 1;
      // First attempt hangs past the deadline (the "transient stall"); the retry succeeds.
      return calls === 1 ? NEVER<{ ids: string[] }>() : Promise.resolve({ ids: ['m1'] });
    };
    await expect(withMemoryWriteRetry(attempt, 'write', { sleep: noSleep })).resolves.toEqual({ ids: ['m1'] });
    expect(calls).toBe(2); // 1 timed-out + 1 success — the drop the incident reported is now recovered
  });

  it('gives up with MemoryTimeoutError after the bounded attempts on a SUSTAINED wedge — never hangs', async () => {
    let calls = 0;
    const attempt = () => { calls += 1; return NEVER<unknown>(); };
    await expect(withMemoryWriteRetry(attempt, 'write', { sleep: noSleep })).rejects.toBeInstanceOf(
      MemoryTimeoutError,
    );
    expect(calls).toBe(2); // default maxAttempts — bounded, not an unbounded storm
  });

  it('does NOT retry a NON-timeout failure (store down / bad key) — fails fast, one attempt', async () => {
    let calls = 0;
    const attempt = () => { calls += 1; return Promise.reject(new Error('mem0_unavailable')); };
    await expect(withMemoryWriteRetry(attempt, 'write', { sleep: noSleep })).rejects.toThrow('mem0_unavailable');
    expect(calls).toBe(1); // deterministic failure — retrying it just adds latency
  });

  it('does NOT retry when the process was ALREADY degraded before the write — a sustained wedge fails fast', async () => {
    noteMemoryFailure(new MemoryTimeoutError('an earlier memory op timed out')); // arm the latch first
    expect(isMemoryDegraded()).toBe(true);
    let calls = 0;
    const attempt = () => { calls += 1; return NEVER<unknown>(); };
    await expect(withMemoryWriteRetry(attempt, 'write', { sleep: noSleep })).rejects.toBeInstanceOf(
      MemoryTimeoutError,
    );
    expect(calls).toBe(1); // already-degraded skip — don't pile retries on a known-wedged backend
  });

  it('a first-attempt SUCCESS runs exactly once (no wasted retry)', async () => {
    let calls = 0;
    const attempt = () => { calls += 1; return Promise.resolve({ ids: ['ok'] }); };
    await expect(withMemoryWriteRetry(attempt, 'write', { sleep: noSleep })).resolves.toEqual({ ids: ['ok'] });
    expect(calls).toBe(1);
  });

  it('honors PAPERCUSP_MEMORY_WRITE_MAX_ATTEMPTS', async () => {
    process.env.PAPERCUSP_MEMORY_WRITE_MAX_ATTEMPTS = '3';
    let calls = 0;
    const attempt = () => { calls += 1; return NEVER<unknown>(); };
    await expect(withMemoryWriteRetry(attempt, 'write', { sleep: noSleep })).rejects.toBeInstanceOf(
      MemoryTimeoutError,
    );
    expect(calls).toBe(3);
  });

  it('max attempts = 1 opts OUT of retry (a timeout is surfaced on the first attempt)', async () => {
    process.env.PAPERCUSP_MEMORY_WRITE_MAX_ATTEMPTS = '1';
    let calls = 0;
    const attempt = () => { calls += 1; return NEVER<unknown>(); };
    await expect(withMemoryWriteRetry(attempt, 'write', { sleep: noSleep })).rejects.toBeInstanceOf(
      MemoryTimeoutError,
    );
    expect(calls).toBe(1);
  });
});

describe('memoryWriteMaxAttempts / memoryWriteRetryBackoffMs — tunables', () => {
  afterEach(() => {
    delete process.env.PAPERCUSP_MEMORY_WRITE_MAX_ATTEMPTS;
    delete process.env.PAPERCUSP_MEMORY_WRITE_RETRY_BACKOFF_MS;
  });

  it('defaults: 2 attempts, 250ms backoff', () => {
    expect(memoryWriteMaxAttempts()).toBe(2);
    expect(memoryWriteRetryBackoffMs()).toBe(250);
  });

  it('clamps max attempts to [1, 5] and floors fractionals; invalid → default', () => {
    process.env.PAPERCUSP_MEMORY_WRITE_MAX_ATTEMPTS = '99';
    expect(memoryWriteMaxAttempts()).toBe(5);
    process.env.PAPERCUSP_MEMORY_WRITE_MAX_ATTEMPTS = '3.9';
    expect(memoryWriteMaxAttempts()).toBe(3);
    process.env.PAPERCUSP_MEMORY_WRITE_MAX_ATTEMPTS = '0';
    expect(memoryWriteMaxAttempts()).toBe(2); // < 1 → default
    process.env.PAPERCUSP_MEMORY_WRITE_MAX_ATTEMPTS = 'junk';
    expect(memoryWriteMaxAttempts()).toBe(2); // NaN → default
  });

  it('backoff honors env, accepts 0 (no backoff), rejects negatives/junk', () => {
    process.env.PAPERCUSP_MEMORY_WRITE_RETRY_BACKOFF_MS = '1000';
    expect(memoryWriteRetryBackoffMs()).toBe(1000);
    process.env.PAPERCUSP_MEMORY_WRITE_RETRY_BACKOFF_MS = '0';
    expect(memoryWriteRetryBackoffMs()).toBe(0);
    process.env.PAPERCUSP_MEMORY_WRITE_RETRY_BACKOFF_MS = '-5';
    expect(memoryWriteRetryBackoffMs()).toBe(250); // negative → default
    process.env.PAPERCUSP_MEMORY_WRITE_RETRY_BACKOFF_MS = 'junk';
    expect(memoryWriteRetryBackoffMs()).toBe(250);
  });
});

describe('embedFailureReason — embed failure → clean degraded reason', () => {
  it('maps a hard insufficient_quota (billing) stop to embed_quota_exhausted, NOT rate-limited', () => {
    // mem0-embed-insufficient-quota-classification: the billing stop must NOT be shadowed by
    // the generic 429 branch — the agent narrates "check billing" (owner action), not "retrying".
    expect(embedFailureReason(new Error('openai_embed_quota_exhausted: {"error":{"type":"insufficient_quota"}}')))
      .toBe('embed_quota_exhausted');
  });

  it('maps a transient 429 rate-limit to embed_rate_limited', () => {
    expect(embedFailureReason(new Error('openai_embed_failed_429: rate limited'))).toBe('embed_rate_limited');
  });

  it('maps other embed failures (5xx / exhausted retries) to embed_unavailable', () => {
    expect(embedFailureReason(new Error('openai_embed_failed_503: boom'))).toBe('embed_unavailable');
    expect(embedFailureReason(new Error('openai_embed_failed: retries exhausted'))).toBe('embed_unavailable');
  });

  it('returns null for a non-embed error (let it propagate to handler_error)', () => {
    expect(embedFailureReason(new Error('some other failure'))).toBeNull();
    expect(embedFailureReason('a string error')).toBeNull();
  });

  it('WI-4183: maps a dead-sidecar throw (sidecar_required_unavailable) to sidecar_unavailable', () => {
    // The exact message shape buildSidecarFirstEmbedder / embed-sidecar-wiring.ts throws when a
    // configured sidecar is unreachable (WI-4021 D-003: required, no in-process fallback) — a
    // plain Error, NOT a MemoryUnavailableError instance, so it must be caught here rather than
    // falling through to a raw handler_error.
    expect(
      embedFailureReason(
        new Error('sidecar_required_unavailable: fetch failed (http://127.0.0.1:3384, harrier:document, budget 15000ms)'),
      ),
    ).toBe('sidecar_unavailable');
  });
});
