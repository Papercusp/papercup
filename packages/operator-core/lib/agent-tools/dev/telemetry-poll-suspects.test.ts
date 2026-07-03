/**
 * flagPollSuspects (EI-7029) — the poll-detector guard folded into
 * dev:telemetry. The statusline double-call storm (~200k wasted MCP calls/day
 * of activity:recent) sat visible-but-unflagged in the telemetry rollup for
 * weeks; this guard makes the NEXT storm self-announce.
 */
import { describe, expect, it } from 'vitest';
import {
  flagPollSuspects,
  POLL_SUSPECT_MIN_CALLS_PER_HOUR,
  POLL_SUSPECT_MIN_CALLS_PER_SPAWN,
  type TelemetryRollupEntry,
} from '../../dev-data';

function entry(overrides: Partial<TelemetryRollupEntry>): TelemetryRollupEntry {
  return {
    tool_name: 'x:y',
    call_count: 0,
    error_count: 0,
    p50_ms: 1,
    p95_ms: 2,
    total_bytes: 0,
    avg_bytes: null,
    repeat_within_spawn: 0,
    workspaces: ['ws-1'],
    ...overrides,
  };
}

describe('flagPollSuspects', () => {
  it('flags a statusline-shaped storm: huge call count from few spawns', () => {
    // ~6,000 calls in 24h (250/hr) from 10 spawns = 600 calls/spawn.
    const storm = entry({
      tool_name: 'activity:recent',
      call_count: 6000,
      repeat_within_spawn: 5990,
      total_bytes: 3_000_000,
    });
    const out = flagPollSuspects([storm], 24);
    expect(out).toHaveLength(1);
    expect(out[0].tool_name).toBe('activity:recent');
    expect(out[0].calls_per_hour).toBe(250);
    expect(out[0].calls_per_spawn).toBe(600);
    expect(out[0].reason).toContain('polling-shaped');
  });

  it('does NOT flag a busy fleet fanning one call per spawn', () => {
    // 6,000 calls from 6,000 distinct spawns — high rate, zero repeats:
    // legitimate fan-out, not a poll loop.
    const fanout = entry({ tool_name: 'coord:orient', call_count: 6000, repeat_within_spawn: 0 });
    expect(flagPollSuspects([fanout], 24)).toHaveLength(0);
  });

  it('does NOT flag a low-rate repeat pattern (a long interactive session)', () => {
    // 100 calls over 24h all from one spawn: repeat-heavy but ~4/hr — a human
    // session re-reading a board, not a poller.
    const slow = entry({ tool_name: 'plans:list', call_count: 100, repeat_within_spawn: 99 });
    expect(flagPollSuspects([slow], 24)).toHaveLength(0);
  });

  it('applies both thresholds exactly at the boundary', () => {
    const h = 2;
    const spawns = 8;
    const callCount = POLL_SUSPECT_MIN_CALLS_PER_HOUR * h; // 240 → exactly 120/hr
    // 240 calls / 8 spawns = 30/spawn — exactly the per-spawn floor.
    expect(callCount / spawns).toBe(POLL_SUSPECT_MIN_CALLS_PER_SPAWN);
    const boundary = entry({
      tool_name: 'edge:case',
      call_count: callCount,
      repeat_within_spawn: callCount - spawns,
    });
    expect(flagPollSuspects([boundary], h)).toHaveLength(1);
    // One call fewer → under the rate floor → clean.
    const under = entry({
      tool_name: 'edge:under',
      call_count: callCount - 1,
      repeat_within_spawn: callCount - 1 - spawns,
    });
    expect(flagPollSuspects([under], h)).toHaveLength(0);
  });

  it('sorts worst-first and survives zero/degenerate rows', () => {
    const worst = entry({ tool_name: 'w', call_count: 48_000, repeat_within_spawn: 47_990 });
    const mild = entry({ tool_name: 'm', call_count: 3_000, repeat_within_spawn: 2_950 });
    const empty = entry({ tool_name: 'e', call_count: 0 });
    const out = flagPollSuspects([mild, empty, worst], 24);
    expect(out.map((s) => s.tool_name)).toEqual(['w', 'm']);
  });

  it('clamps a sub-hour window to 1h rather than inflating rates', () => {
    const e = entry({ tool_name: 'z', call_count: 130, repeat_within_spawn: 129 });
    // hours=0 would divide by zero / inflate; clamp treats it as 1h → 130/hr.
    const out = flagPollSuspects([e], 0);
    expect(out).toHaveLength(1);
    expect(out[0].calls_per_hour).toBe(130);
  });
});
