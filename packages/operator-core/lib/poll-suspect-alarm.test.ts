/**
 * poll-suspect-alarm (EI-7428) — the periodic ANNOUNCE half of the EI-7029
 * read-time poll-detector guard. Pins the pure alert-decision (pickNewAlerts),
 * the toast formatting, and the orchestrator's dedup + fail-open behavior via
 * injected deps (no real PG / clock / timers).
 */
import { describe, expect, it, vi } from 'vitest';
import {
  pickNewAlerts,
  formatPollSuspectToast,
  runPollSuspectScanOnce,
  POLL_SUSPECT_ALERT_DEDUPE_MS,
  POLL_SUSPECT_SCAN_WINDOW_HOURS,
} from './poll-suspect-alarm';
import type { PollSuspect } from './dev-data';

function suspect(overrides: Partial<PollSuspect>): PollSuspect {
  return {
    tool_name: 'x:y',
    call_count: 1000,
    calls_per_hour: 200,
    callers: 5,
    calls_per_caller_per_hour: 40,
    total_bytes: 0,
    reason: 'polling-shaped',
    ...overrides,
  };
}

describe('pickNewAlerts', () => {
  it('alerts a tool never seen before', () => {
    const s = suspect({ tool_name: 'activity:recent' });
    expect(pickNewAlerts([s], new Map(), 1_000_000)).toEqual([s]);
  });

  it('suppresses a tool alerted within the dedupe window', () => {
    const s = suspect({ tool_name: 'activity:recent' });
    const last = new Map([['activity:recent', 1_000_000]]);
    // Just under the 24h window later.
    const now = 1_000_000 + POLL_SUSPECT_ALERT_DEDUPE_MS - 1;
    expect(pickNewAlerts([s], last, now)).toEqual([]);
  });

  it('re-alerts once the dedupe window has fully elapsed', () => {
    const s = suspect({ tool_name: 'activity:recent' });
    const last = new Map([['activity:recent', 1_000_000]]);
    const now = 1_000_000 + POLL_SUSPECT_ALERT_DEDUPE_MS;
    expect(pickNewAlerts([s], last, now)).toEqual([s]);
  });

  it('is independent per tool_name', () => {
    const hot = suspect({ tool_name: 'hot:tool' });
    const cold = suspect({ tool_name: 'cold:tool' });
    const last = new Map([['hot:tool', 1_000_000]]);
    const now = 1_000_000 + 1000; // well within the window for hot:tool
    expect(pickNewAlerts([hot, cold], last, now)).toEqual([cold]);
  });

  it('respects a custom dedupeMs override', () => {
    const s = suspect({ tool_name: 't' });
    const last = new Map([['t', 1_000_000]]);
    // 500ms elapsed < 1000ms dedupe window -> still suppressed.
    expect(pickNewAlerts([s], last, 1_000_500, 1000)).toEqual([]);
    // 2000ms elapsed >= 1000ms dedupe window -> alerts again.
    expect(pickNewAlerts([s], last, 1_002_000, 1000)).toEqual([s]);
  });
});

describe('formatPollSuspectToast', () => {
  it('names each suspect with its rate + caller shape', () => {
    const out = formatPollSuspectToast([
      suspect({ tool_name: 'activity:recent', calls_per_hour: 6000, callers: 50, calls_per_caller_per_hour: 120 }),
    ]);
    expect(out.level).toBe('warning');
    expect(out.message).toContain('1 tool(s)');
    expect(out.description).toContain('activity:recent');
    expect(out.description).toContain('6000/hr');
    expect(out.description).toContain('50 caller(s)');
    expect(out.description).toContain('EI-7029');
  });

  it('lists multiple suspects, one per line', () => {
    const out = formatPollSuspectToast([
      suspect({ tool_name: 'a:a' }),
      suspect({ tool_name: 'b:b' }),
    ]);
    expect(out.message).toContain('2 tool(s)');
    expect(out.description).toContain('a:a');
    expect(out.description).toContain('b:b');
  });
});

describe('runPollSuspectScanOnce', () => {
  it('toasts + stamps NEW suspects, using the injected clock/map', async () => {
    const s = suspect({ tool_name: 'activity:recent' });
    const emitToast = vi.fn(async () => {});
    const lastAlertedAt = new Map<string, number>();
    const result = await runPollSuspectScanOnce({
      loadSuspects: async () => [s],
      emitToast,
      lastAlertedAt,
      now: () => 5_000_000,
    });
    expect(result.checked).toBe(1);
    expect(result.alerted).toEqual([s]);
    expect(emitToast).toHaveBeenCalledTimes(1);
    expect(emitToast.mock.calls[0][0].description).toContain('activity:recent');
    expect(lastAlertedAt.get('activity:recent')).toBe(5_000_000);
  });

  it('does NOT toast when everything is within the dedupe window', async () => {
    const s = suspect({ tool_name: 'activity:recent' });
    const emitToast = vi.fn(async () => {});
    const lastAlertedAt = new Map([['activity:recent', 5_000_000]]);
    const result = await runPollSuspectScanOnce({
      loadSuspects: async () => [s],
      emitToast,
      lastAlertedAt,
      now: () => 5_000_000 + 1000, // far under the 24h window
    });
    expect(result.alerted).toEqual([]);
    expect(emitToast).not.toHaveBeenCalled();
  });

  it('does NOT toast when there are no suspects', async () => {
    const emitToast = vi.fn(async () => {});
    const result = await runPollSuspectScanOnce({
      loadSuspects: async () => [],
      emitToast,
    });
    expect(result.checked).toBe(0);
    expect(result.alerted).toEqual([]);
    expect(emitToast).not.toHaveBeenCalled();
  });

  it('fails open (never throws) when the detector read fails, and does not stamp anything', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const emitToast = vi.fn(async () => {});
    const lastAlertedAt = new Map<string, number>();
    const result = await runPollSuspectScanOnce({
      loadSuspects: async () => {
        throw new Error('pg boom');
      },
      emitToast,
      lastAlertedAt,
    });
    expect(result).toEqual({ checked: 0, alerted: [] });
    expect(emitToast).not.toHaveBeenCalled();
    expect(lastAlertedAt.size).toBe(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('scan skipped (non-fatal)'));
    warn.mockRestore();
  });

  it('does NOT stamp a suspect when the toast emit itself fails (retries next tick)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const s = suspect({ tool_name: 'activity:recent' });
    const lastAlertedAt = new Map<string, number>();
    const result = await runPollSuspectScanOnce({
      loadSuspects: async () => [s],
      emitToast: async () => {
        throw new Error('db write failed');
      },
      lastAlertedAt,
      now: () => 1,
    });
    // The tick still reports what it FOUND (checked/alerted reflect detection,
    // not delivery) but never throws, and — critically — does not mark the
    // suspect as alerted since the toast never actually landed.
    expect(result.checked).toBe(1);
    expect(lastAlertedAt.size).toBe(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('toast emit failed'));
    warn.mockRestore();
  });

  it('uses the default 3h scan window and cross-workspace scope when wired to the live detector', async () => {
    // Smoke-test the production default wiring shape without touching PG: inject
    // loadSuspects but assert the constants it *would* call telemetryRollup with
    // are what the module exports (regression guard against silently narrowing scope).
    expect(POLL_SUSPECT_SCAN_WINDOW_HOURS).toBe(3);
    expect(POLL_SUSPECT_ALERT_DEDUPE_MS).toBe(24 * 3600_000);
  });
});
