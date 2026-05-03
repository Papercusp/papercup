import { describe, expect, it, vi } from 'vitest';
import { flushBrowserSpeechSynthesis, awaitAbort } from './cancel-race';

describe('flushBrowserSpeechSynthesis', () => {
  it('is a no-op when speechSynthesis is unavailable', async () => {
    // jsdom doesn't expose speechSynthesis by default; the helper should
    // exit cleanly without throwing.
    await expect(flushBrowserSpeechSynthesis()).resolves.toBeUndefined();
  });

  it('calls cancel + spins until pending+speaking are false', async () => {
    let pending = true;
    let speaking = true;
    const cancel = vi.fn(() => {
      // Simulate browser clearing pending + speaking after a few ticks.
      setTimeout(() => { pending = false; speaking = false; }, 20);
    });
    (globalThis as any).window = {
      speechSynthesis: {
        cancel,
        get pending() { return pending; },
        get speaking() { return speaking; },
      },
    };
    try {
      await flushBrowserSpeechSynthesis();
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(pending).toBe(false);
      expect(speaking).toBe(false);
    } finally {
      delete (globalThis as any).window;
    }
  });

  it('respects the 200ms timeout cap if the engine never clears', async () => {
    (globalThis as any).window = {
      speechSynthesis: {
        cancel: () => {},
        pending: true,
        speaking: true,
      },
    };
    try {
      const start = Date.now();
      await flushBrowserSpeechSynthesis();
      const elapsed = Date.now() - start;
      // Should complete within ~250ms (20 spins × 10ms + scheduling slack).
      expect(elapsed).toBeLessThan(400);
    } finally {
      delete (globalThis as any).window;
    }
  });
});

describe('awaitAbort', () => {
  it('is a no-op for null', async () => {
    await expect(awaitAbort(null)).resolves.toBeUndefined();
  });

  it('does not double-abort if already aborted', async () => {
    const c = new AbortController();
    c.abort();
    await expect(awaitAbort(c)).resolves.toBeUndefined();
  });

  it('aborts an active controller', async () => {
    const c = new AbortController();
    expect(c.signal.aborted).toBe(false);
    await awaitAbort(c);
    expect(c.signal.aborted).toBe(true);
  });
});
