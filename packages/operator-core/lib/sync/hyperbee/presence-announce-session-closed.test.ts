/**
 * WI-3684 send-side twin (P-001, p2p-parity-closeout-lanes-2026-07-10):
 * `startPresenceAnnounceLoop`'s tick used to blind-retry a permanently CLOSED
 * own-log session (SESSION_CLOSED — own-log-fork-guard.ts / health.ts) every
 * `intervalMs` forever, since `append` on that handle will never succeed
 * again this process lifetime. This pins the fix: on a SESSION_CLOSED
 * `append` failure the loop SELF-STOPS (clears its interval — no further
 * `append` calls on later ticks) and fires `onSessionClosed` exactly once,
 * mirroring outbox-drain.ts's twin behavior, so the caller (wire-presence.ts
 * -> boot-all.ts's `ensureSendSideWired`) can re-wire a fresh loop on the
 * next boot pass instead of leaving a zombie loop.
 *
 * An ORDINARY (non-SESSION_CLOSED) append failure must keep retrying
 * unchanged (via onError) — this only special-cases the permanently-dead-
 * session class.
 */
import { describe, expect, it, vi } from 'vitest';
import { startPresenceAnnounceLoop, type PresenceIdentity } from './presence-announce';

const IDENTITY: PresenceIdentity = {
  githubUserId: 1,
  machineLabel: 'm1',
  devicePubkey: 'aa'.repeat(32),
};

/** A structurally-real Hypercore SESSION_CLOSED error (hypercore-errors shape: `.code`). */
function sessionClosedError(): Error {
  const e = new Error('SESSION_CLOSED: cannot append to a closed session');
  (e as { code?: string }).code = 'SESSION_CLOSED';
  return e;
}

describe('presence-announce SESSION_CLOSED self-stop (WI-3684 send-side twin)', () => {
  it('self-stops on SESSION_CLOSED — no further append calls on later ticks — and fires onSessionClosed once', async () => {
    vi.useFakeTimers();
    try {
      const append = vi.fn(async () => {
        throw sessionClosedError();
      });
      const onSessionClosed = vi.fn();
      const onError = vi.fn();
      const loop = startPresenceAnnounceLoop({
        resolveIdentity: async () => IDENTITY,
        getState: () => ({ intent: 'x', currentView: null, harnessSlug: 'hx' }),
        append,
        intervalMs: 1000,
        onError,
        onSessionClosed,
      });

      // Drive one tick manually (first tick always announces: prev === null).
      await loop.tickOnce();
      expect(append).toHaveBeenCalledTimes(1);
      expect(onSessionClosed).toHaveBeenCalledTimes(1);
      expect(onError).not.toHaveBeenCalled();

      // Advance past several interval ticks — a healthy (unaffected) loop
      // would call append again each tick; a self-stopped loop must NOT.
      await vi.advanceTimersByTimeAsync(1000 * 5);
      expect(
        append,
        'the loop must self-stop on SESSION_CLOSED, not blind-retry every interval tick',
      ).toHaveBeenCalledTimes(1);
      expect(onSessionClosed).toHaveBeenCalledTimes(1);

      // stop() must remain idempotent after the internal self-stop.
      expect(() => loop.stop()).not.toThrow();
    } finally {
      vi.useRealTimers();
    }
  });

  it('an ORDINARY append failure (not SESSION_CLOSED) keeps retrying via onError — unaffected by this change', async () => {
    vi.useFakeTimers();
    try {
      const append = vi.fn(async () => {
        throw new Error('transient PG hiccup');
      });
      const onSessionClosed = vi.fn();
      const onError = vi.fn();
      const loop = startPresenceAnnounceLoop({
        resolveIdentity: async () => IDENTITY,
        getState: () => ({ intent: 'x', currentView: null, harnessSlug: 'hx' }),
        append,
        intervalMs: 1000,
        onError,
        onSessionClosed,
      });

      await loop.tickOnce();
      expect(append).toHaveBeenCalledTimes(1);
      expect(onError).toHaveBeenCalledTimes(1);
      expect(onSessionClosed).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1000 * 2);
      expect(
        append.mock.calls.length,
        'a non-SESSION_CLOSED failure must keep the interval retrying as before',
      ).toBeGreaterThan(1);
      expect(onSessionClosed).not.toHaveBeenCalled();

      loop.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
