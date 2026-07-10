/**
 * WI-3684 send-side twin (P-001, p2p-parity-closeout-lanes-2026-07-10):
 * `ensureSendSideWired`'s outbox-drain loop used to blind-retry a
 * permanently CLOSED own-log session (SESSION_CLOSED — own-log-fork-guard.ts
 * / health.ts) every `pollMs` forever, since `handle.append` on that handle
 * will never succeed again this process lifetime. This pins the fix: on a
 * SESSION_CLOSED append failure the drain SELF-STOPS (no further `append`
 * calls on later poll ticks) and fires `onSessionClosed` exactly once, so the
 * caller (wire-outbox.ts → boot-all.ts's `ensureSendSideWired`) can re-wire a
 * fresh drain on the next boot pass instead of leaving a zombie loop.
 *
 * An ORDINARY (non-SESSION_CLOSED) append failure must keep retrying
 * unchanged — this only special-cases the permanently-dead-session class.
 */
import { describe, expect, it, vi } from 'vitest';
import { startOutboxDrain } from './outbox-drain';
import type { BootedHarnessHandle } from './boot';

function fakePg(nextRows: () => unknown[]) {
  const tag = async (strings: TemplateStringsArray) => {
    const sql = strings.join(' ');
    if (/SELECT id, table_name/.test(sql)) {
      return nextRows() as unknown[] & { count?: number };
    }
    const r = [] as unknown[] & { count?: number };
    r.count = 0;
    return r;
  };
  (tag as unknown as { listen: unknown }).listen = () => ({
    unlisten: async () => {},
  });
  return tag as never;
}

function fakeHandle(append: (op: unknown) => Promise<void>): BootedHarnessHandle {
  return {
    workspaceId: 'ws',
    harnessSlug: 'hx',
    ownLog: { keyHex: 'aa'.repeat(32) },
    append,
    registerCloseHook: () => {},
  } as unknown as BootedHarnessHandle;
}

const OUTBOX_ROW = {
  id: 1,
  table_name: 'harness_features_consolidated',
  op: 'put',
  key: 'F-1',
  row: { id: 'F-1' },
  ts: 1,
  op_hlc: null,
};

/** A structurally-real Hypercore SESSION_CLOSED error (hypercore-errors shape: `.code`). */
function sessionClosedError(): Error {
  const e = new Error('SESSION_CLOSED: cannot append to a closed session');
  (e as { code?: string }).code = 'SESSION_CLOSED';
  return e;
}

describe('outbox-drain SESSION_CLOSED self-stop (WI-3684 send-side twin)', () => {
  it('self-stops on SESSION_CLOSED — no further append calls on later poll ticks — and fires onSessionClosed once', async () => {
    vi.useFakeTimers();
    // The drain's catch path console.error's on every failed pass (by design,
    // asserted implicitly via mockImplementation) — swallow so the test log
    // stays clean; restored in finally.
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const append = vi.fn(async () => {
        throw sessionClosedError();
      });
      const onSessionClosed = vi.fn();
      const handle = fakeHandle(append);
      const drain = startOutboxDrain(handle, fakePg(() => [OUTBOX_ROW]), {
        pollMs: 1000,
        _passTimeoutMs: 0,
        _backlogStallMs: 0,
        _orphanCheckIntervalMs: -1,
        onSessionClosed,
      });

      // Flush the immediate catch-up drain (the first, synchronous-ish pass).
      await vi.advanceTimersByTimeAsync(0);
      expect(append).toHaveBeenCalledTimes(1);
      expect(onSessionClosed).toHaveBeenCalledTimes(1);

      // Advance past several poll ticks — a healthy (unaffected) loop would
      // call append again each tick; a self-stopped loop must NOT.
      await vi.advanceTimersByTimeAsync(1000 * 5);
      expect(
        append,
        'the drain must self-stop on SESSION_CLOSED, not blind-retry every poll tick',
      ).toHaveBeenCalledTimes(1);
      expect(onSessionClosed).toHaveBeenCalledTimes(1);

      // stop() must remain idempotent after the internal self-stop.
      await expect(drain.stop()).resolves.toBeUndefined();
    } finally {
      errSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('an ORDINARY append failure (not SESSION_CLOSED) keeps retrying — unaffected by this change', async () => {
    vi.useFakeTimers();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const append = vi.fn(async () => {
        throw new Error('transient PG hiccup');
      });
      const onSessionClosed = vi.fn();
      const handle = fakeHandle(append);
      const drain = startOutboxDrain(handle, fakePg(() => [OUTBOX_ROW]), {
        pollMs: 1000,
        _passTimeoutMs: 0,
        _backlogStallMs: 0,
        _orphanCheckIntervalMs: -1,
        onSessionClosed,
      });

      await vi.advanceTimersByTimeAsync(0);
      expect(append).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1000 * 2);
      expect(
        append.mock.calls.length,
        'a non-SESSION_CLOSED failure must keep the poll retrying as before',
      ).toBeGreaterThan(1);
      expect(onSessionClosed).not.toHaveBeenCalled();

      await drain.stop();
    } finally {
      errSpy.mockRestore();
      vi.useRealTimers();
    }
  });
});
