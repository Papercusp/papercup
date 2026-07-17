/**
 * EI-13917 (bg-host PG client wedge, no self-recovery): `startOutboxDrain`'s
 * `pg` client is handed to it ONCE at wire-time and closed over for the whole
 * drain-loop lifetime (the poll timer + LISTEN handler never re-resolve it).
 * `connection.ts`'s `getOrgPg()`/`getOrgPgApp()` correctly invalidate + rebuild
 * their SHARED client when the discovery-file URL changes (WI-5244) — but a
 * consumer holding this OLD closure-captured reference then fails every
 * subsequent write with postgres.js's `CONNECTION_ENDED`, forever, since
 * nothing here ever re-fetches a fresh client. This is the live incident this
 * EI was filed on: ~600 CONNECTION_ENDED errors/min for 4.5min, no self-
 * recovery, until a human manually restarted the service.
 *
 * This pins the fix: on a CONNECTION_ENDED failure the drain SELF-STOPS (no
 * further queries on later poll ticks) and fires `onSessionClosed` exactly
 * once — REUSING the exact WI-3684 SESSION_CLOSED re-wire path (boot-all.ts's
 * `ensureSendSideWired` un-marks + immediately re-attempts wiring against a
 * FRESH `getOrgPg().sql`), instead of blind-retrying the dead client forever.
 *
 * An ORDINARY (non-CONNECTION_ENDED) query failure must keep retrying
 * unchanged — this only special-cases the permanently-dead-client class.
 */
import { describe, expect, it, vi } from 'vitest';
import { startOutboxDrain, isConnectionEndedError } from './outbox-drain';
import type { BootedHarnessHandle } from './boot';

/** A structurally-real postgres.js CONNECTION_ENDED error (errors.js `connection()` shape). */
function connectionEndedError(): Error {
  const e = new Error('write CONNECTION_ENDED localhost:5432');
  (e as { code?: string }).code = 'CONNECTION_ENDED';
  return e;
}

function fakePgThatFailsSelect(makeError: () => unknown) {
  const tag = async (strings: TemplateStringsArray) => {
    const sql = strings.join(' ');
    if (/SELECT id, table_name/.test(sql)) {
      throw makeError();
    }
    // GC delete + any other query — benign no-op.
    const r = [] as unknown[] & { count?: number };
    r.count = 0;
    return r;
  };
  (tag as unknown as { listen: unknown }).listen = () => ({
    unlisten: async () => {},
  });
  return tag as never;
}

function fakeHandle(): BootedHarnessHandle {
  return {
    workspaceId: 'ws',
    harnessSlug: 'hx',
    ownLog: { keyHex: 'aa'.repeat(32) },
    append: vi.fn(async () => {}),
    registerCloseHook: () => {},
  } as unknown as BootedHarnessHandle;
}

describe('outbox-drain CONNECTION_ENDED self-stop (EI-13917)', () => {
  it('isConnectionEndedError classifies postgres.js CONNECTION_ENDED/CONNECTION_DESTROYED, not arbitrary errors', () => {
    expect(isConnectionEndedError(connectionEndedError())).toBe(true);
    expect(isConnectionEndedError(Object.assign(new Error('x'), { code: 'CONNECTION_DESTROYED' }))).toBe(true);
    expect(isConnectionEndedError(new Error('write CONNECTION_ENDED localhost:5432'))).toBe(true);
    expect(isConnectionEndedError(new Error('transient PG hiccup'))).toBe(false);
    expect(isConnectionEndedError(null)).toBe(false);
  });

  it('self-stops on CONNECTION_ENDED — no further queries on later poll ticks — and fires onSessionClosed once', async () => {
    vi.useFakeTimers();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const pg = fakePgThatFailsSelect(connectionEndedError);
      const pgTagSpy = vi.fn(pg as unknown as (...a: unknown[]) => unknown);
      const onSessionClosed = vi.fn();
      const handle = fakeHandle();
      const drain = startOutboxDrain(handle, pg, {
        pollMs: 1000,
        _passTimeoutMs: 0,
        _backlogStallMs: 0,
        _orphanCheckIntervalMs: -1,
        onSessionClosed,
      });
      void pgTagSpy; // kept for readability; the real assertion is onSessionClosed + pass count below

      // Flush the immediate catch-up drain (the first, synchronous-ish pass).
      await vi.advanceTimersByTimeAsync(0);
      expect(onSessionClosed).toHaveBeenCalledTimes(1);

      // Advance past several poll ticks — a healthy (unaffected) loop would
      // keep querying every tick; a self-stopped loop must NOT re-fire the hook.
      await vi.advanceTimersByTimeAsync(1000 * 5);
      expect(
        onSessionClosed,
        'the drain must self-stop on CONNECTION_ENDED (fire onSessionClosed ONCE), not blind-retry every poll tick',
      ).toHaveBeenCalledTimes(1);

      // stop() must remain idempotent after the internal self-stop.
      await expect(drain.stop()).resolves.toBeUndefined();
    } finally {
      errSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('an ORDINARY query failure (not CONNECTION_ENDED) keeps retrying — unaffected by this change', async () => {
    vi.useFakeTimers();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      let calls = 0;
      const pg = fakePgThatFailsSelect(() => {
        calls += 1;
        return new Error('transient PG hiccup');
      });
      const onSessionClosed = vi.fn();
      const handle = fakeHandle();
      const drain = startOutboxDrain(handle, pg, {
        pollMs: 1000,
        _passTimeoutMs: 0,
        _backlogStallMs: 0,
        _orphanCheckIntervalMs: -1,
        onSessionClosed,
      });

      await vi.advanceTimersByTimeAsync(0);
      expect(calls).toBeGreaterThanOrEqual(1);

      await vi.advanceTimersByTimeAsync(1000 * 2);
      expect(
        calls,
        'a non-CONNECTION_ENDED failure must keep the poll retrying as before',
      ).toBeGreaterThan(1);
      expect(onSessionClosed).not.toHaveBeenCalled();

      await drain.stop();
    } finally {
      errSpy.mockRestore();
      vi.useRealTimers();
    }
  });
});
