/**
 * WI-5147 (EI-13571): the backlog-AGE/SIZE alert. `maybeEscalateBacklogStall`
 * (outbox-drain-stall.test.ts) only escalates when the drain makes ZERO forward
 * progress for its whole window — a backlog that is ALWAYS making *some*
 * progress, however pathologically slow relative to its size, never trips it.
 * That is the exact live incident this detector was filed on: a papercusp
 * harness `substrate_outbox` backlog of 7351 rows, oldest THREE WEEKS old,
 * drained the entire time at ~2 rows/min (steady, nonzero, nowhere near
 * enough) and went completely undetected until an agent doing a live
 * federation witness happened to notice their own queued write wasn't landing.
 *
 * These tests pin: (1) an old-but-progressing backlog escalates via the age
 * leg; (2) a large-but-progressing backlog escalates via the size leg (either
 * alone is sufficient); (3) a healthy drain (fresh rows, small backlog) never
 * fires; (4) the latch holds while the condition persists and clears once BOTH
 * legs recover, so a later re-breach re-escalates; (5) production defaults.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  startOutboxDrain,
  DRAIN_BACKLOG_AGE_STALL_MS,
  DRAIN_BACKLOG_SIZE_STALL_THRESHOLD,
  DRAIN_BACKLOG_AGE_CHECK_INTERVAL_MS,
} from './outbox-drain';
import type { BootedHarnessHandle } from './boot';

/** Minimal postgres.Sql fake: the drain SELECT returns empty (isolates this
 *  detector from the row-processing path); the WI-5147 age/size probe
 *  (`SELECT count(*)::bigint AS undrained_count, min(ts) AS oldest_ts`) answers
 *  from `opts.probe()`; everything else (stuck-probe, orphan GROUP BY, GC,
 *  UPDATE) is a harmless empty/no-op so those detectors stay silent. */
function fakePg(probe: () => { undrained_count: number; oldest_ts: number | null }) {
  const tag = async (strings: TemplateStringsArray) => {
    const sql = strings.join(' ');
    if (/undrained_count/.test(sql)) {
      return [probe()] as unknown[] & { count?: number };
    }
    if (/SELECT id, table_name/.test(sql)) {
      const r = [] as unknown[] & { count?: number };
      r.count = 0;
      return r;
    }
    if (/SELECT 1\s+FROM harness_shared\.substrate_outbox/.test(sql)) {
      return [] as unknown[] & { count?: number }; // no mapped row stuck — isolates the zero-progress detector
    }
    if (/GROUP BY drained_log_key/.test(sql)) {
      return [] as unknown[] & { count?: number };
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

function fakeHandle(): BootedHarnessHandle {
  return {
    workspaceId: 'ws',
    harnessSlug: 'hx',
    ownLog: { keyHex: 'aa'.repeat(32) },
    append: async () => {},
    registerCloseHook: () => {},
  } as unknown as BootedHarnessHandle;
}

describe('outbox-drain backlog-age/size detector (WI-5147 / EI-13571)', () => {
  it('an OLD-but-progressing backlog escalates via the age leg (size leg disabled)', async () => {
    vi.useFakeTimers();
    try {
      const episodes: Array<{ detail: string; kind?: string }> = [];
      const startedAt = Date.now(); // the row's age grows from here as fake time advances
      const pg = fakePg(() => ({ undrained_count: 5, oldest_ts: startedAt }));
      const drain = startOutboxDrain(fakeHandle(), pg, {
        pollMs: 1000,
        _passTimeoutMs: 0,
        _backlogStallMs: 0,
        _backlogAgeStallMs: 60_000, // 1min for the test
        _backlogSizeStallThreshold: 0, // isolate the age leg
        _backlogAgeCheckIntervalMs: 1000,
        _onStallEpisode: (detail, kind) => episodes.push({ detail, kind }),
      });

      // Under the age window: nothing escalates yet.
      await vi.advanceTimersByTimeAsync(50_000);
      expect(episodes.filter((e) => e.kind === 'drain_backlog_aged')).toHaveLength(0);

      // Cross the 1min age threshold → exactly one drain_backlog_aged episode.
      await vi.advanceTimersByTimeAsync(20_000);
      const aged = episodes.filter((e) => e.kind === 'drain_backlog_aged');
      expect(aged).toHaveLength(1);
      expect(aged[0]!.detail).toContain('WI-5147');
      expect(aged[0]!.detail).toContain('oldest undrained row is');
      expect(aged[0]!.detail).not.toContain('undrained rows ('); // size leg text absent

      // Latch: further checks while still breached do NOT re-file.
      await vi.advanceTimersByTimeAsync(10_000);
      expect(episodes.filter((e) => e.kind === 'drain_backlog_aged')).toHaveLength(1);

      await drain.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a LARGE-but-progressing backlog escalates via the size leg (age leg disabled)', async () => {
    vi.useFakeTimers();
    try {
      const episodes: Array<{ detail: string; kind?: string }> = [];
      const pg = fakePg(() => ({ undrained_count: 5000, oldest_ts: Date.now() })); // fresh rows, huge count
      const drain = startOutboxDrain(fakeHandle(), pg, {
        pollMs: 1000,
        _passTimeoutMs: 0,
        _backlogStallMs: 0,
        _backlogAgeStallMs: 0, // isolate the size leg
        _backlogSizeStallThreshold: 2000,
        _backlogAgeCheckIntervalMs: 1000,
        _onStallEpisode: (detail, kind) => episodes.push({ detail, kind }),
      });

      await vi.advanceTimersByTimeAsync(50);
      const aged = episodes.filter((e) => e.kind === 'drain_backlog_aged');
      expect(aged).toHaveLength(1);
      expect(aged[0]!.detail).toContain('5000 undrained rows');
      expect(aged[0]!.detail).not.toContain('oldest undrained row is'); // age leg text absent

      await drain.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a HEALTHY drain (small, fresh backlog) never escalates', async () => {
    vi.useFakeTimers();
    try {
      const episodes: Array<{ detail: string; kind?: string }> = [];
      const pg = fakePg(() => ({ undrained_count: 3, oldest_ts: Date.now() }));
      const drain = startOutboxDrain(fakeHandle(), pg, {
        pollMs: 1000,
        _passTimeoutMs: 0,
        _backlogStallMs: 0,
        _backlogAgeStallMs: 60_000,
        _backlogSizeStallThreshold: 2000,
        _backlogAgeCheckIntervalMs: 1000,
        _onStallEpisode: (detail, kind) => episodes.push({ detail, kind }),
      });

      await vi.advanceTimersByTimeAsync(200_000);
      expect(episodes.filter((e) => e.kind === 'drain_backlog_aged')).toHaveLength(0);

      await drain.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('an empty outbox (no undrained rows) never escalates even with tiny thresholds', async () => {
    vi.useFakeTimers();
    try {
      const episodes: Array<{ detail: string; kind?: string }> = [];
      const pg = fakePg(() => ({ undrained_count: 0, oldest_ts: null }));
      const drain = startOutboxDrain(fakeHandle(), pg, {
        pollMs: 1000,
        _passTimeoutMs: 0,
        _backlogStallMs: 0,
        _backlogAgeStallMs: 1,
        _backlogSizeStallThreshold: 1,
        _backlogAgeCheckIntervalMs: 1000,
        _onStallEpisode: (detail, kind) => episodes.push({ detail, kind }),
      });

      await vi.advanceTimersByTimeAsync(20_000);
      expect(episodes.filter((e) => e.kind === 'drain_backlog_aged')).toHaveLength(0);

      await drain.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('recovers (clears the latch) once BOTH legs drop below threshold, then RE-escalates on a later re-breach', async () => {
    vi.useFakeTimers();
    try {
      const episodes: Array<{ detail: string; kind?: string }> = [];
      let breached = true;
      const pg = fakePg(() =>
        breached ? { undrained_count: 5000, oldest_ts: Date.now() } : { undrained_count: 1, oldest_ts: Date.now() },
      );
      const drain = startOutboxDrain(fakeHandle(), pg, {
        pollMs: 1000,
        _passTimeoutMs: 0,
        _backlogStallMs: 0,
        _backlogAgeStallMs: 0,
        _backlogSizeStallThreshold: 2000,
        _backlogAgeCheckIntervalMs: 1000,
        _onStallEpisode: (detail, kind) => episodes.push({ detail, kind }),
      });

      await vi.advanceTimersByTimeAsync(50);
      expect(episodes.filter((e) => e.kind === 'drain_backlog_aged')).toHaveLength(1);

      // Recovers: next probe reads a healthy backlog → latch clears (no new episode).
      breached = false;
      await vi.advanceTimersByTimeAsync(1000);
      expect(episodes.filter((e) => e.kind === 'drain_backlog_aged')).toHaveLength(1);

      // Re-breaches → a SECOND, distinct episode fires (the latch re-arms).
      breached = true;
      await vi.advanceTimersByTimeAsync(1000);
      expect(episodes.filter((e) => e.kind === 'drain_backlog_aged')).toHaveLength(2);

      await drain.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a zero/negative threshold on BOTH legs disables the detector entirely', async () => {
    vi.useFakeTimers();
    try {
      const episodes: Array<{ detail: string; kind?: string }> = [];
      const pg = fakePg(() => ({ undrained_count: 999_999, oldest_ts: 0 })); // would breach both, if enabled
      const drain = startOutboxDrain(fakeHandle(), pg, {
        pollMs: 1000,
        _passTimeoutMs: 0,
        _backlogStallMs: 0,
        _backlogAgeStallMs: 0,
        _backlogSizeStallThreshold: 0,
        _backlogAgeCheckIntervalMs: 1000,
        _onStallEpisode: (detail, kind) => episodes.push({ detail, kind }),
      });

      await vi.advanceTimersByTimeAsync(20_000);
      expect(episodes.filter((e) => e.kind === 'drain_backlog_aged')).toHaveLength(0);

      await drain.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('production defaults: age threshold = 1h, size threshold = 2000 rows, check throttle = 10min', () => {
    expect(DRAIN_BACKLOG_AGE_STALL_MS).toBe(60 * 60 * 1000);
    expect(DRAIN_BACKLOG_SIZE_STALL_THRESHOLD).toBe(2000);
    expect(DRAIN_BACKLOG_AGE_CHECK_INTERVAL_MS).toBe(10 * 60 * 1000);
  });
});

/**
 * WI-6997 — the durable-EI RECOVERY leg this module never had.
 *
 * Note what the pre-existing "recovers (clears the latch)" test above does and does
 * NOT prove: it asserts that NO NEW escalation fires after recovery. That passed
 * for the whole life of the bug, because clearing the in-process latch was all the
 * code ever did. The durable EI stayed open forever and no test could see it —
 * there was no recovery seam to observe. Measured 2026-08-02: `terminal_owner =
 * 'system:replication-liveness'` on 33 EIs across the three kinds replication-
 * liveness.ts owns, and on ZERO drain_* EIs, while ~102 drain_* EIs were closed by
 * hand. These tests assert the resolve leg itself, not the absence of a re-page.
 */
describe('outbox-drain durable-EI auto-resolve on recovery (WI-6997)', () => {
  it('fires a drain_backlog_aged RECOVERY on the escalated->recovered edge', async () => {
    vi.useFakeTimers();
    try {
      const episodes: Array<{ detail: string; kind?: string }> = [];
      const recoveries: Array<{ detail: string; kind?: string }> = [];
      let breached = true;
      const pg = fakePg(() =>
        breached ? { undrained_count: 5000, oldest_ts: Date.now() } : { undrained_count: 1, oldest_ts: Date.now() },
      );
      const drain = startOutboxDrain(fakeHandle(), pg, {
        pollMs: 1000,
        _passTimeoutMs: 0,
        _backlogStallMs: 0,
        _backlogAgeStallMs: 0,
        _backlogSizeStallThreshold: 2000,
        _backlogAgeCheckIntervalMs: 1000,
        _onStallEpisode: (detail, kind) => episodes.push({ detail, kind }),
        _onStallRecovery: (detail, kind) => recoveries.push({ detail, kind }),
      });

      await vi.advanceTimersByTimeAsync(50);
      expect(episodes.filter((e) => e.kind === 'drain_backlog_aged')).toHaveLength(1);
      expect(recoveries).toHaveLength(0); // still breached — nothing to resolve

      // The edge: backlog drops below BOTH thresholds.
      breached = false;
      await vi.advanceTimersByTimeAsync(1000);
      expect(recoveries.filter((r) => r.kind === 'drain_backlog_aged')).toHaveLength(1);
      expect(recoveries[0]?.detail).toMatch(/recovered/i);

      await drain.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('reconciles a pre-restart EI once on the fresh drain\'s first healthy probe', async () => {
    vi.useFakeTimers();
    try {
      const episodes: Array<{ detail: string; kind?: string }> = [];
      const recoveries: Array<{ detail: string; kind?: string }> = [];
      let breached = true;
      const pg = fakePg(() =>
        breached ? { undrained_count: 5000, oldest_ts: Date.now() } : { undrained_count: 1, oldest_ts: Date.now() },
      );
      const beforeRestart = startOutboxDrain(fakeHandle(), pg, {
        pollMs: 1000,
        _passTimeoutMs: 0,
        _backlogStallMs: 0,
        _backlogAgeStallMs: 0,
        _backlogSizeStallThreshold: 2000,
        _backlogAgeCheckIntervalMs: 1000,
        _onStallEpisode: (detail, kind) => episodes.push({ detail, kind }),
        _onStallRecovery: (detail, kind) => recoveries.push({ detail, kind }),
      });

      // The first process opens the durable EI, then disappears before observing
      // recovery. Its process-local escalation latch disappears with it.
      await vi.advanceTimersByTimeAsync(50);
      expect(episodes.filter((e) => e.kind === 'drain_backlog_aged')).toHaveLength(1);
      expect(recoveries).toHaveLength(0);
      await beforeRestart.stop();

      // A fresh drain starts after the backlog recovered. Its first healthy probe
      // must reconcile the already-open exact-kind EI despite a fresh false latch.
      breached = false;
      const afterRestart = startOutboxDrain(fakeHandle(), pg, {
        pollMs: 1000,
        _passTimeoutMs: 0,
        _backlogStallMs: 0,
        _backlogAgeStallMs: 0,
        _backlogSizeStallThreshold: 2000,
        _backlogAgeCheckIntervalMs: 1000,
        _onStallEpisode: (detail, kind) => episodes.push({ detail, kind }),
        _onStallRecovery: (detail, kind) => recoveries.push({ detail, kind }),
      });

      await vi.advanceTimersByTimeAsync(50);
      expect(recoveries.filter((r) => r.kind === 'drain_backlog_aged')).toHaveLength(1);
      expect(recoveries[0]?.detail).toMatch(/recovered/i);

      // Repeated healthy probes do not generate repeated resolve queries.
      await vi.advanceTimersByTimeAsync(10_000);
      expect(recoveries.filter((r) => r.kind === 'drain_backlog_aged')).toHaveLength(1);

      await afterRestart.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('re-arms: a breach -> recover -> re-breach -> recover cycle resolves BOTH times', async () => {
    vi.useFakeTimers();
    try {
      const episodes: Array<{ detail: string; kind?: string }> = [];
      const recoveries: Array<{ detail: string; kind?: string }> = [];
      let breached = true;
      const pg = fakePg(() =>
        breached ? { undrained_count: 5000, oldest_ts: Date.now() } : { undrained_count: 1, oldest_ts: Date.now() },
      );
      const drain = startOutboxDrain(fakeHandle(), pg, {
        pollMs: 1000,
        _passTimeoutMs: 0,
        _backlogStallMs: 0,
        _backlogAgeStallMs: 0,
        _backlogSizeStallThreshold: 2000,
        _backlogAgeCheckIntervalMs: 1000,
        _onStallEpisode: (detail, kind) => episodes.push({ detail, kind }),
        _onStallRecovery: (detail, kind) => recoveries.push({ detail, kind }),
      });

      await vi.advanceTimersByTimeAsync(50);
      breached = false;
      await vi.advanceTimersByTimeAsync(1000);
      breached = true;
      await vi.advanceTimersByTimeAsync(1000);
      breached = false;
      await vi.advanceTimersByTimeAsync(1000);

      // A second episode AND a second resolve — escalate/resolve stay paired, so a
      // later genuine stall is never silently swallowed by a stuck latch.
      expect(episodes.filter((e) => e.kind === 'drain_backlog_aged')).toHaveLength(2);
      expect(recoveries.filter((r) => r.kind === 'drain_backlog_aged')).toHaveLength(2);

      await drain.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
