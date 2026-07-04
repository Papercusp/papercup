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
import { startOutboxDrain, DRAIN_PASS_TIMEOUT_MS, DRAIN_BACKLOG_STALL_MS } from './outbox-drain';
import type { BootedHarnessHandle } from './boot';

/** Minimal postgres.Sql fake: a template-tag returning rows for the drain SELECT,
 *  an answer for the WI-2009 leg-3 backlog-stall probe, and a countable result for
 *  everything else (GC / UPDATE), plus a listen() stub.
 *
 *  `opts.stuckProbe` answers the leg-3 probe (`SELECT 1 FROM …substrate_outbox …
 *  LIMIT 1`): true → a mapped undrained row is still waiting ([{…}]); false →
 *  nothing mappable is stuck ([]). Default true. */
function fakePg(
  nextRows: () => unknown[],
  opts: { stuckProbe?: () => boolean } = {},
) {
  const stuckProbe = opts.stuckProbe ?? (() => true);
  const tag = async (strings: TemplateStringsArray, ..._vals: unknown[]) => {
    const sql = strings.join(' ');
    if (/SELECT id, table_name/.test(sql)) {
      const rows = nextRows() as unknown[] & { count?: number };
      return rows;
    }
    if (/SELECT 1\s+FROM harness_shared\.substrate_outbox/.test(sql)) {
      return (stuckProbe() ? [{ '?column?': 1 }] : []) as unknown[] & { count?: number };
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
    // The drain catch path console.error's on the failed pass (by design — the loud
    // failure log); expected + ASSERTED below, so vitest-fail-on-console stays green.
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
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
      expect(errSpy).toHaveBeenCalledWith(
        expect.stringContaining('[outbox-drain] drain failed'),
        expect.anything(),
      );
      await vi.advanceTimersByTimeAsync(1100);
      expect(append.mock.calls.length).toBeGreaterThanOrEqual(2);

      // The zombie pass settling later must not explode (unhandled rejection).
      resolveHung?.();
      await vi.advanceTimersByTimeAsync(10);

      await drain.stop();
    } finally {
      errSpy.mockRestore();
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

/**
 * WI-2009 leg 3 — the backlog-stall detector the hung-pass watchdog does NOT
 * cover. The filed live signature is NOT a hung pass: each pass SETTLES (fails
 * fast on a persistent EpochKeyUnavailableError / append fault, or drains
 * nothing), so the `DRAIN_PASS_TIMEOUT_MS` watchdog never fires — yet mapped
 * undrained rows sit frozen and nobody pages. This detector escalates a durable
 * `drain_backlog_stalled` EI when the drain makes ZERO forward progress for the
 * whole window while a mapped undrained row still waits. Progress-based: any
 * drained row resets the clock (a legitimate large catch-up never false-fires),
 * and it reaches the check on BOTH the settle and the fast-fail throw path.
 */
describe('outbox-drain backlog-stall detector (WI-2009 leg 3)', () => {
  const emptyRows = () => {
    const r = [] as unknown[] & { count?: number };
    r.count = 0;
    return r;
  };
  const oneRow = () => {
    const r = [{ ...OUTBOX_ROW }] as unknown[] & { count?: number };
    r.count = 1;
    return r;
  };

  it('passes SETTLE draining zero rows + a mapped row still waiting → exactly ONE drain_backlog_stalled (latch holds)', async () => {
    vi.useFakeTimers();
    try {
      const append = vi.fn(async () => {}); // never called — the drain SELECT is empty
      const episodes: Array<{ detail: string; kind?: string }> = [];
      const pg = fakePg(() => emptyRows(), { stuckProbe: () => true });
      const drain = startOutboxDrain(fakeHandle(append), pg, {
        pollMs: 1000,
        _passTimeoutMs: 0, // isolate the backlog detector from the hung-pass watchdog
        _backlogStallMs: 5000,
        _onStallEpisode: (detail, kind) => episodes.push({ detail, kind }),
      });

      // Under the no-progress window: nothing escalates yet.
      await vi.advanceTimersByTimeAsync(4000);
      expect(episodes).toHaveLength(0);

      // Cross the 5s window → exactly one backlog-stall episode (NOT a hung-pass one).
      await vi.advanceTimersByTimeAsync(4000);
      const backlog = episodes.filter((e) => e.kind === 'drain_backlog_stalled');
      expect(backlog).toHaveLength(1);
      expect(backlog[0].detail).toContain('WI-2009');
      expect(backlog[0].detail).toContain('ZERO forward progress');
      expect(episodes.some((e) => e.kind === 'drain_stalled')).toBe(false);

      // Latch: further no-progress passes do NOT re-file.
      await vi.advanceTimersByTimeAsync(10_000);
      expect(episodes.filter((e) => e.kind === 'drain_backlog_stalled')).toHaveLength(1);
      expect(append).not.toHaveBeenCalled();

      await drain.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('the FAST-FAIL throw path (persistent append fault) also reaches the detector and escalates', async () => {
    vi.useFakeTimers();
    // Each failing pass logs the loud drain-failed line (by design); expected +
    // ASSERTED below so vitest-fail-on-console stays green.
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const append = vi.fn(async () => {
        throw new Error('persistent append fault');
      });
      const episodes: Array<{ detail: string; kind?: string }> = [];
      const pg = fakePg(() => oneRow(), { stuckProbe: () => true });
      const drain = startOutboxDrain(fakeHandle(append), pg, {
        pollMs: 1000,
        _passTimeoutMs: 0,
        _backlogStallMs: 5000,
        _onStallEpisode: (detail, kind) => episodes.push({ detail, kind }),
      });

      await vi.advanceTimersByTimeAsync(8000);
      const backlog = episodes.filter((e) => e.kind === 'drain_backlog_stalled');
      expect(backlog).toHaveLength(1);
      // A plain append fault is NOT a DrainPassTimeoutError, so the hung-pass
      // detector must stay silent — only the backlog detector fires.
      expect(episodes.some((e) => e.kind === 'drain_stalled')).toBe(false);
      expect(errSpy).toHaveBeenCalledWith(
        expect.stringContaining('[outbox-drain] drain failed'),
        expect.anything(),
      );

      await drain.stop();
    } finally {
      errSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('a pass that DRAINS a row resets the no-progress clock → never escalates', async () => {
    vi.useFakeTimers();
    try {
      const append = vi.fn(async () => {}); // succeeds → the served row drains every pass
      const episodes: Array<{ detail: string; kind?: string }> = [];
      const pg = fakePg(() => oneRow(), { stuckProbe: () => true });
      const drain = startOutboxDrain(fakeHandle(append), pg, {
        pollMs: 1000,
        _passTimeoutMs: 0,
        _backlogStallMs: 5000,
        _onStallEpisode: (detail, kind) => episodes.push({ detail, kind }),
      });

      // Well past the window: every pass makes forward progress, so lastProgressAt
      // keeps resetting and the detector never even runs.
      await vi.advanceTimersByTimeAsync(15_000);
      expect(episodes).toHaveLength(0);
      expect(append.mock.calls.length).toBeGreaterThan(1);

      await drain.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('zero forward progress but NO mapped row waiting (probe empty) → no escalation', async () => {
    vi.useFakeTimers();
    try {
      const append = vi.fn(async () => {});
      const episodes: Array<{ detail: string; kind?: string }> = [];
      // The drain drains nothing AND the probe finds no mapped row — e.g. the only
      // undrained rows are forward-compat unmapped tables (excluded on purpose).
      const pg = fakePg(() => emptyRows(), { stuckProbe: () => false });
      const drain = startOutboxDrain(fakeHandle(append), pg, {
        pollMs: 1000,
        _passTimeoutMs: 0,
        _backlogStallMs: 5000,
        _onStallEpisode: (detail, kind) => episodes.push({ detail, kind }),
      });

      await vi.advanceTimersByTimeAsync(15_000);
      expect(episodes).toHaveLength(0);

      await drain.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('production default backlog-stall window is 10min (bounded, above transient key-arrival delay)', () => {
    expect(DRAIN_BACKLOG_STALL_MS).toBe(10 * 60 * 1000);
  });
});
