/**
 * WI-2009 (gate 1b, shared-hive-p2p-release-readiness-2026-07-03): the outbox-
 * drain pass watchdog. The drain loop serializes passes behind a `draining`
 * flag — before this fix, ONE pass hanging on an await (keychain unwrap inside
 * epochEncrypt on a wedged mac keychain [WI-2018], epoch-key resolution, a
 * wedged append) froze the loop FOREVER: every later poll/NOTIFY coalesced
 * into the stuck pass, local writes silently stopped federating, and the only
 * "recovery" was ONE fresh attempt per process restart (the live-VM signature:
 * fail-count frozen 18min+ across restarts).
 *
 * These tests pin: (1) a hung pass times out, the loop un-wedges, and the NEXT
 * pass runs and drains; (2) the stall escalates via the episode hook; (3) the
 * watchdog is inert on healthy passes.
 */
import { describe, expect, it, vi } from 'vitest';
import { startOutboxDrain, DRAIN_PASS_TIMEOUT_MS } from './outbox-drain';
import type { BootedHarnessHandle } from './boot';

/** Minimal postgres.Sql fake: a template-tag returning rows for the SELECT and
 *  a countable result for everything else, plus a listen() stub. */
function fakePg(nextRows: () => unknown[]) {
  const tag = async (strings: TemplateStringsArray, ..._vals: unknown[]) => {
    const sql = strings.join(' ');
    if (/SELECT id, table_name/.test(sql)) {
      const rows = nextRows() as unknown[] & { count?: number };
      return rows;
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

describe('outbox-drain pass watchdog (WI-2009)', () => {
  it('a hung append times out, escalates, and the loop UN-WEDGES (next pass drains)', async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      let resolveHung: (() => void) | undefined;
      const append = vi.fn(async () => {
        calls += 1;
        if (calls === 1) {
          // First pass: hang forever (the WI-2018 keychain-unwrap shape).
          await new Promise<void>((res) => {
            resolveHung = res;
          });
        }
        // Later passes: succeed instantly.
      });
      const episodes: string[] = [];
      // One undrained row on every SELECT (the UPDATE fake never clears it —
      // fine: we only assert attempt/latch behavior, not drained bookkeeping).
      const pg = fakePg(() => {
        const rows = [{ ...OUTBOX_ROW }] as unknown[] & { count?: number };
        rows.count = 1;
        return rows;
      });
      const drain = startOutboxDrain(fakeHandle(append), pg, {
        pollMs: 1000,
        _passTimeoutMs: 5000,
        _onStallEpisode: (d) => episodes.push(d),
      });

      // Initial pass starts immediately and hangs.
      await vi.advanceTimersByTimeAsync(10);
      expect(append).toHaveBeenCalledTimes(1);

      // Polls at 1s/2s/3s/4s coalesce into the stuck pass — no new attempts.
      await vi.advanceTimersByTimeAsync(4000);
      expect(append).toHaveBeenCalledTimes(1);
      expect(episodes).toHaveLength(0);

      // Watchdog expires at 5s → escalation + loop un-wedged; the next poll
      // tick runs a FRESH pass that attempts the row again.
      await vi.advanceTimersByTimeAsync(1100);
      expect(episodes).toHaveLength(1);
      expect(episodes[0]).toContain('WI-2009');
      await vi.advanceTimersByTimeAsync(1100);
      expect(append.mock.calls.length).toBeGreaterThanOrEqual(2);

      // The zombie pass settling later must not explode (unhandled rejection).
      resolveHung?.();
      await vi.advanceTimersByTimeAsync(10);

      await drain.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('healthy passes never trip the watchdog', async () => {
    vi.useFakeTimers();
    try {
      const append = vi.fn(async () => {});
      const episodes: string[] = [];
      let served = false;
      const pg = fakePg(() => {
        // One row on the first pass, then empty (drained).
        if (served) {
          const r = [] as unknown[] & { count?: number };
          r.count = 0;
          return r;
        }
        served = true;
        const rows = [{ ...OUTBOX_ROW }] as unknown[] & { count?: number };
        rows.count = 1;
        return rows;
      });
      const drain = startOutboxDrain(fakeHandle(append), pg, {
        pollMs: 1000,
        _passTimeoutMs: 5000,
        _onStallEpisode: (d) => episodes.push(d),
      });
      await vi.advanceTimersByTimeAsync(12_000);
      expect(append).toHaveBeenCalledTimes(1);
      expect(episodes).toHaveLength(0);
      await drain.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('production default timeout is bounded (2min — well under the ~12min host recycle)', () => {
    expect(DRAIN_PASS_TIMEOUT_MS).toBe(120_000);
  });
});
