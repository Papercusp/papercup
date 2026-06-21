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
