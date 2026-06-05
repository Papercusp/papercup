// @vitest-environment node
/**
 * aria-live-bus.ts — the non-React pub/sub the voice `speak()` path uses to
 * mirror TTS text into the aria-live regions for screen-reader users.
 *
 * Covers: a subscriber receives published (priority, text); fan-out to
 * multiple subscribers; the returned unsubscribe stops delivery; no
 * cross-talk (unsubscribing one leaves the other receiving).
 */
import { describe, expect, it, vi } from 'vitest';
import { publishAriaLive, subscribeAriaLiveText } from './aria-live-bus';

describe('aria-live-bus', () => {
  it('delivers published priority + text to a subscriber', () => {
    const seen: Array<[string, string]> = [];
    const off = subscribeAriaLiveText((p, t) => seen.push([p, t]));
    publishAriaLive('polite', 'hello');
    publishAriaLive('assertive', 'urgent');
    off();
    expect(seen).toEqual([
      ['polite', 'hello'],
      ['assertive', 'urgent'],
    ]);
  });

  it('fans a single publish out to every subscriber', () => {
    const a = vi.fn();
    const b = vi.fn();
    const offA = subscribeAriaLiveText(a);
    const offB = subscribeAriaLiveText(b);
    publishAriaLive('polite', 'broadcast');
    offA();
    offB();
    expect(a).toHaveBeenCalledExactlyOnceWith('polite', 'broadcast');
    expect(b).toHaveBeenCalledExactlyOnceWith('polite', 'broadcast');
  });

  it('stops delivering after unsubscribe', () => {
    const fn = vi.fn();
    const off = subscribeAriaLiveText(fn);
    publishAriaLive('polite', 'first');
    off();
    publishAriaLive('polite', 'second');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith('polite', 'first');
  });

  it('unsubscribing one listener does not affect the other (no cross-talk)', () => {
    const kept = vi.fn();
    const dropped = vi.fn();
    const offKept = subscribeAriaLiveText(kept);
    const offDropped = subscribeAriaLiveText(dropped);
    offDropped();
    publishAriaLive('assertive', 'only-kept');
    offKept();
    expect(dropped).not.toHaveBeenCalled();
    expect(kept).toHaveBeenCalledExactlyOnceWith('assertive', 'only-kept');
  });

  it('a publish with no subscribers is a no-op (does not throw)', () => {
    // Any earlier subscribers were unsubscribed above; the Set is empty here.
    expect(() => publishAriaLive('polite', 'into the void')).not.toThrow();
  });
});
