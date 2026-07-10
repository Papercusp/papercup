/**
 * outbox-drain-row-quarantine.test.ts — WI-3896 (tower outbox-drain wedge — the
 * "papercusp substrate_merge_cursor never establishes" incident).
 *
 * THE GAP `DRAIN_PASS_TIMEOUT_MS` (WI-2009) DOESN'T COVER: the pass-level
 * watchdog un-wedges the LOOP (a fresh pass re-attempts), but `drainOutboxOnce`
 * always re-selects the SAME earliest-undrained rows first (`ORDER BY id`) — so
 * when ONE row's stage (epoch-encrypt / append) genuinely never settles, it is
 * the leading row of EVERY pass, every pass times out on that SAME row, and
 * NOTHING behind it ever gets a chance to drain. That is the live incident
 * shape: outbox-drain kept retrying forever with zero net progress.
 *
 * THE FIX: a per-row stage timeout (`ROW_STAGE_TIMEOUT_MS`, bound well under the
 * pass-level timeout) names the exact hanging row; `startOutboxDrain` counts
 * CONSECUTIVE timeouts for that SAME row id and, after `ROW_QUARANTINE_THRESHOLD`,
 * adds it to a standing quarantine set that `drainOutboxOnce` checks BEFORE any
 * hanging stage on every future pass — so a poison row is permanently skipped
 * (left undrained ON PURPOSE, never falsely marked drained_at) and rows behind
 * it resume draining normally.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  startOutboxDrain,
  RowStageTimeoutError,
  ROW_STAGE_TIMEOUT_MS,
  ROW_QUARANTINE_THRESHOLD,
} from './outbox-drain';
import type { BootedHarnessHandle } from './boot';

/** Minimal postgres.Sql fake — same shape as outbox-drain-stall.test.ts's. */
function fakePg(nextRows: () => unknown[], opts: { onUpdate?: (vals: unknown[]) => void } = {}) {
  const tag = async (strings: TemplateStringsArray, ...vals: unknown[]) => {
    const sql = strings.join(' ');
    if (/SELECT id, table_name/.test(sql)) {
      return nextRows() as unknown[] & { count?: number };
    }
    if (/UPDATE harness_shared\.substrate_outbox\s+SET drained_at/.test(sql)) {
      opts.onUpdate?.(vals);
    }
    const r = [] as unknown[] & { count?: number };
    r.count = 0;
    return r;
  };
  (tag as unknown as { listen: unknown }).listen = () => ({ unlisten: async () => {} });
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

function row(id: number, key: string) {
  return { id, table_name: 'harness_features_consolidated', op: 'put', key, row: { id: key }, ts: id, op_hlc: null };
}

describe('outbox-drain per-row poison quarantine (WI-3896)', () => {
  it('a row that NEVER settles is quarantined after N consecutive timeouts — later rows then drain', async () => {
    vi.useFakeTimers();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // row=1 ("poison") never settles; row=2 ("good") succeeds instantly whenever reached.
      const append = vi.fn(async (op: unknown) => {
        if ((op as { hbKey?: string }).hbKey === 'poison') return new Promise<void>(() => {}); // hangs forever
        // good row: resolves immediately
      });
      const episodes: Array<{ detail: string; kind?: string }> = [];
      const updated: unknown[][] = [];
      // Every pass's SELECT returns the same two undrained rows (the fake never
      // marks poison drained; good's UPDATE is observed but the fake keeps
      // returning it too, since we don't bother filtering it out post-drain —
      // we only assert on append call counts + the quarantine episode).
      const pg = fakePg(() => [row(1, 'poison'), row(2, 'good')], {
        onUpdate: (vals) => updated.push(vals),
      });

      const drain = startOutboxDrain(fakeHandle(append), pg, {
        pollMs: 1000,
        _passTimeoutMs: 0, // isolate the per-row detector from the pass-level watchdog
        _backlogStallMs: 0,
        _rowTimeoutMs: 100,
        _rowQuarantineThreshold: 3,
        _onStallEpisode: (detail, kind) => episodes.push({ detail, kind }),
      });

      // Initial pass: row 1 hangs, row-stage timeout fires at 100ms → 1st episode counted
      // (not yet quarantined — threshold is 3). No row-2 progress yet (pass aborted at row 1).
      await vi.advanceTimersByTimeAsync(150);
      expect(append).toHaveBeenCalledTimes(1);
      expect(updated).toHaveLength(0);

      // Poll #2 (1000ms cadence) re-attempts the SAME batch → row 1 hangs again (2nd timeout).
      await vi.advanceTimersByTimeAsync(1000);
      expect(append).toHaveBeenCalledTimes(2);

      // Poll #3 → 3rd consecutive timeout on row 1 → QUARANTINED. The quarantine
      // is applied in this poll's CATCH (after the pass already rejected on row
      // 1), so row 2 is reached on the NEXT pass, not this one.
      await vi.advanceTimersByTimeAsync(1000);
      const quarantined = episodes.filter((e) => e.kind === 'drain_row_quarantined');
      expect(quarantined).toHaveLength(1);
      expect(quarantined[0]!.detail).toContain('id=1');
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('WI-3896 quarantine'));

      // Poll #4: row 1 is now quarantined → skipped instantly, row 2 is reached
      // + applied in THIS pass.
      await vi.advanceTimersByTimeAsync(1000);
      expect(updated.length).toBeGreaterThanOrEqual(1);
      // append was called for 'good' at least once (row.hbKey 'good' calls resolve
      // instantly and don't hang, unlike 'poison').
      expect(append.mock.calls.some((c) => (c[0] as { hbKey?: string }).hbKey === 'good')).toBe(true);

      // Further polls: row 1 stays quarantined — no more hang-append attempts on it,
      // and the skip warning is logged (deduped, not spammed).
      const appendCallsBeforeMorePolls = append.mock.calls.filter(
        (c) => (c[0] as { hbKey?: string }).hbKey === 'poison',
      ).length;
      await vi.advanceTimersByTimeAsync(3000);
      const poisonCallsAfter = append.mock.calls.filter(
        (c) => (c[0] as { hbKey?: string }).hbKey === 'poison',
      ).length;
      expect(poisonCallsAfter).toBe(appendCallsBeforeMorePolls); // never called again
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('QUARANTINED poison row id=1'));

      await drain.stop();
    } finally {
      errSpy.mockRestore();
      warnSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('a row that times out just ONCE (transient/load-induced) is NOT quarantined — plain retry, no episode', async () => {
    vi.useFakeTimers();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      let calls = 0;
      const append = vi.fn(async () => {
        calls += 1;
        if (calls === 1) return new Promise<void>(() => {}); // hangs once
        // subsequent calls succeed instantly
      });
      const episodes: Array<{ detail: string; kind?: string }> = [];
      const pg = fakePg(() => [row(1, 'k1')]);

      const drain = startOutboxDrain(fakeHandle(append), pg, {
        pollMs: 1000,
        _passTimeoutMs: 0,
        _backlogStallMs: 0,
        _rowTimeoutMs: 100,
        _rowQuarantineThreshold: 3,
        _onStallEpisode: (detail, kind) => episodes.push({ detail, kind }),
      });

      await vi.advanceTimersByTimeAsync(150); // 1st timeout — below threshold
      expect(episodes.filter((e) => e.kind === 'drain_row_quarantined')).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(1000); // retry — this time it succeeds
      expect(episodes.filter((e) => e.kind === 'drain_row_quarantined')).toHaveLength(0);
      expect(calls).toBeGreaterThanOrEqual(2);

      await drain.stop();
    } finally {
      errSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('RowStageTimeoutError names the row id + stage + timeout in its message', () => {
    const e = new RowStageTimeoutError(42, 'epoch-encrypt (row id=42 table=t)', 45_000);
    expect(e.rowId).toBe(42);
    expect(e.message).toContain('row id=42');
    expect(e.message).toContain('45000ms');
    expect(e.name).toBe('RowStageTimeoutError');
  });

  it('production defaults: row-stage timeout well under the pass-level watchdog; quarantine threshold matches WI-255', () => {
    expect(ROW_STAGE_TIMEOUT_MS).toBe(45_000);
    expect(ROW_QUARANTINE_THRESHOLD).toBe(3);
  });
});
