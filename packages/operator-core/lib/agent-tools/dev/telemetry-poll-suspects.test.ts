/**
 * flagPollSuspects (EI-7029) — the poll-detector guard folded into
 * dev:telemetry. The statusline double-call storm (~200k wasted MCP calls/day
 * of activity:recent) sat visible-but-unflagged in the telemetry rollup for
 * weeks; this guard makes the NEXT storm self-announce.
 *
 * The detector is PER-CALLER: aggregate rate alone flags busy-but-legit tools,
 * and per-spawn alone is confounded by synthetic shared spawn_ids (the
 * 'event-reaction' spawn collapses every in-process event reaction fleet-wide
 * into one spawn — live false positive, 2026-07-03).
 */
import { describe, expect, it } from 'vitest';
import {
  flagPollSuspects,
  POLL_SUSPECT_MIN_CALLS_PER_HOUR,
  POLL_SUSPECT_MIN_CALLS_PER_CALLER_PER_HOUR,
  type TelemetryRollupEntry,
} from '../../dev-data';

function entry(overrides: Partial<TelemetryRollupEntry>): TelemetryRollupEntry {
  return {
    tool_name: 'x:y',
    call_count: 0,
    error_count: 0,
    refused_count: 0,
    p50_ms: 1,
    p95_ms: 2,
    total_bytes: 0,
    avg_bytes: null,
    repeat_within_spawn: 0,
    distinct_callers: 1,
    workspaces: ['ws-1'],
    ...overrides,
  };
}

describe('flagPollSuspects', () => {
  it('flags a statusline-shaped storm: sustained high per-caller rate', () => {
    // ~144k calls in 24h across 50 sessions = 6,000/hr aggregate,
    // 120/hr/caller — every session hammering the same tool.
    const storm = entry({
      tool_name: 'activity:recent',
      call_count: 144_000,
      repeat_within_spawn: 143_950,
      distinct_callers: 50,
      total_bytes: 70_000_000,
    });
    const out = flagPollSuspects([storm], 24);
    expect(out).toHaveLength(1);
    expect(out[0].tool_name).toBe('activity:recent');
    expect(out[0].calls_per_hour).toBe(6000);
    expect(out[0].callers).toBe(50);
    expect(out[0].calls_per_caller_per_hour).toBe(120);
    expect(out[0].reason).toContain('polling-shaped');
  });

  it('does NOT flag a shared synthetic spawn spread over many callers (event-reaction regression)', () => {
    // Live false positive 2026-07-03: coord:emit, 993 calls/6h all under the
    // synthetic spawn_id 'event-reaction' (1 spawn!) but ~12 distinct owners
    // → ~14/hr per caller. Event-driven emission, not a poll.
    const emit = entry({
      tool_name: 'coord:emit',
      call_count: 993,
      repeat_within_spawn: 992, // one shared synthetic spawn
      distinct_callers: 12,
    });
    expect(flagPollSuspects([emit], 6)).toHaveLength(0);
  });

  it('does NOT flag a busy fleet fanning one call per spawn/caller', () => {
    const fanout = entry({
      tool_name: 'coord:orient',
      call_count: 6000,
      repeat_within_spawn: 0,
      distinct_callers: 6000,
    });
    expect(flagPollSuspects([fanout], 24)).toHaveLength(0);
  });

  it('does NOT flag a low aggregate rate even from one caller', () => {
    // 100 calls over 24h from one caller: ~4/hr — a long interactive session.
    const slow = entry({
      tool_name: 'plans:list',
      call_count: 100,
      repeat_within_spawn: 99,
      distinct_callers: 1,
    });
    expect(flagPollSuspects([slow], 24)).toHaveLength(0);
  });

  it('applies both thresholds exactly at the boundary', () => {
    const h = 2;
    const callers = 4;
    const callCount = POLL_SUSPECT_MIN_CALLS_PER_HOUR * h; // 240 → exactly 120/hr
    // 120/hr over 4 callers = exactly the 30/hr/caller floor.
    expect(callCount / h / callers).toBe(POLL_SUSPECT_MIN_CALLS_PER_CALLER_PER_HOUR);
    const boundary = entry({
      tool_name: 'edge:case',
      call_count: callCount,
      distinct_callers: callers,
    });
    expect(flagPollSuspects([boundary], h)).toHaveLength(1);
    // One more caller → per-caller rate dips under the floor → clean.
    const diluted = entry({
      tool_name: 'edge:diluted',
      call_count: callCount,
      distinct_callers: callers + 1,
    });
    expect(flagPollSuspects([diluted], h)).toHaveLength(0);
  });

  it('falls back to spawn-derived callers when distinct_callers is absent', () => {
    // Pre-migration fixtures / old rollup shape: no distinct_callers field.
    const legacy = entry({
      tool_name: 'legacy:poller',
      call_count: 6000,
      repeat_within_spawn: 5990, // → 10 spawns → 25/hr… wait: 6000/24/10 = 25
      distinct_callers: undefined as unknown as number,
    });
    // 25/hr/caller < 30 floor → clean; crank the concentration:
    expect(flagPollSuspects([legacy], 24)).toHaveLength(0);
    const legacyHot = entry({
      tool_name: 'legacy:poller',
      call_count: 6000,
      repeat_within_spawn: 5995, // → 5 spawns → 50/hr/caller
      distinct_callers: undefined as unknown as number,
    });
    expect(flagPollSuspects([legacyHot], 24)).toHaveLength(1);
  });

  it('sorts worst-first and survives zero/degenerate rows', () => {
    const worst = entry({ tool_name: 'w', call_count: 48_000, distinct_callers: 2 });
    const mild = entry({ tool_name: 'm', call_count: 3_000, distinct_callers: 2 });
    const empty = entry({ tool_name: 'e', call_count: 0, distinct_callers: 0 });
    const out = flagPollSuspects([mild, empty, worst], 24);
    expect(out.map((s) => s.tool_name)).toEqual(['w', 'm']);
  });

  it('clamps a sub-hour window to 1h rather than inflating rates', () => {
    const e = entry({ tool_name: 'z', call_count: 130, distinct_callers: 1 });
    const out = flagPollSuspects([e], 0);
    expect(out).toHaveLength(1);
    expect(out[0].calls_per_hour).toBe(130);
  });
});
