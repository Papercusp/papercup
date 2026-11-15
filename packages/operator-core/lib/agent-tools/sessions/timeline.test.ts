import { describe, expect, it } from 'vitest';
import {
  buildAutomaticCallAuditSummary,
  buildBoundedTimelineResponse,
  groupRepeatedTimelineEntries,
  SESSION_TIMELINE_RESPONSE_BUDGET_CHARS,
  timelineDateBoundsSchema,
  timelineResultSchema,
  type TimelineEntry,
} from './timeline';

describe('sessions:timeline timestamp bounds', () => {
  it('rejects relative date strings before timestamp casts while accepting ISO offsets', () => {
    for (const bound of ['since', 'until'] as const) {
      expect(timelineDateBoundsSchema.safeParse({ [bound]: '-3 minutes' }).success).toBe(false);
      expect(timelineDateBoundsSchema.safeParse({ [bound]: '30m' }).success).toBe(false);
      expect(timelineDateBoundsSchema.safeParse({ [bound]: '2026-11-15T00:00:00-05:00' }).success).toBe(true);
    }
  });
});

describe('sessions:timeline audit grouping', () => {
  it('collapses identical machinery while preserving newest-first order and oldest timestamp', () => {
    const rows: TimelineEntry[] = [
      { kind: 'tool', ts: '2026-07-13T07:00:03Z', ref: '3', text: 'coord:inbox (ok, 2ms)', tool_name: 'coord:inbox', status: 'ok', auto: true },
      { kind: 'tool', ts: '2026-07-13T07:00:02Z', ref: '2', text: 'coord:inbox (ok, 2ms)', tool_name: 'coord:inbox', status: 'ok', auto: true },
      { kind: 'tool', ts: '2026-07-13T07:00:01Z', ref: '1', text: 'plans:new (invalid-input, 2ms)', tool_name: 'plans:new', status: 'invalid-input', auto: false },
    ];

    expect(groupRepeatedTimelineEntries(rows)).toEqual([
      { ...rows[0], repeat_count: 2, oldest_ts: rows[1].ts },
      { ...rows[2], repeat_count: 1, oldest_ts: rows[2].ts },
    ]);
  });
});

describe('sessions:timeline effective nested status', () => {
  it('keeps effective wrapper statuses distinct while grouping', () => {
    const rows: TimelineEntry[] = [
      { kind: 'tool', ts: '2026-07-13T07:00:02Z', ref: '2', text: 'code:run (partial)', tool_name: 'code:run', status: 'partial' },
      { kind: 'tool', ts: '2026-07-13T07:00:01Z', ref: '1', text: 'code:run (ok)', tool_name: 'code:run', status: 'ok' },
    ];
    expect(groupRepeatedTimelineEntries(rows)).toHaveLength(2);
  });
});

describe('sessions:timeline automatic-versus-agent audit summary', () => {
  it('returns explicit counts, share, and the classification rule', () => {
    expect(buildAutomaticCallAuditSummary({
      total_tool_calls: 8,
      automatic_calls: 2,
      agent_calls: 6,
    })).toEqual({
      total_tool_calls: 8,
      automatic_calls: 2,
      agent_calls: 6,
      automatic_share: 0.25,
      classification: {
        automatic_tools: ['activity:report', 'coord:glance', 'coord:inbox'],
        automatic_origins: ['hook', 'ui', 'system'],
        agent_origins: ['agent', 'unknown'],
        rule: 'explicit call_origin wins: hook/ui/system are automatic and agent/unknown are agent-authored; NULL rows use the legacy automatic tool-name set; include_auto=true shows all traffic',
      },
    });
  });

  it('handles an empty audit window without NaN', () => {
    expect(buildAutomaticCallAuditSummary({
      total_tool_calls: 0,
      automatic_calls: 0,
      agent_calls: 0,
    }).automatic_share).toBe(0);
  });
});

describe('sessions:timeline response-door shaping', () => {
  it('advertises both successful pages and structured error pages', () => {
    expect(timelineResultSchema.safeParse({
      ok: false,
      error: 'invalid_cursor',
      message: 'Cursor belongs to another query.',
    }).success).toBe(true);
    expect(timelineResultSchema.safeParse({
      ok: false,
      error: 'owner_ambiguous',
      owner: 'su-peer',
      matches: ['su-a', 'su-b'],
      message: 'Pass the full ownerId.',
    }).success).toBe(true);
  });

  it('returns valid bounded JSON and a cursor for an oversized page', () => {
    const rows: TimelineEntry[] = Array.from({ length: 100 }, (_, index) => ({
      kind: 'tool',
      ts: `2026-07-13T07:00:${String(index % 60).padStart(2, '0')}Z`,
      ref: String(index),
      text: `tool-${index} ${'same-content '.repeat(24)}`,
      tool_name: 'dev:pg_query',
      status: 'ok',
      auto: false,
    }));
    const shaped = buildBoundedTimelineResponse(
      {
        ok: true,
        owner: 'su-self',
        since: '2026-07-13T06:00:00Z',
        until: '2026-07-13T08:00:00Z',
        filters: { include_auto: false, group_repeated: false },
        stamp_coverage: {
          goal_scoped: false,
          assumption_sets_resolved: 0,
          assumptions_observed: 0,
          assumption_coverage: 'not-goal-scoped',
        },
        audit_summary: {
          total_tool_calls: 100,
          automatic_calls: 0,
          agent_calls: 100,
          automatic_share: 0,
          classification: {
            automatic_tools: [],
            rule: 'test',
          },
        },
      },
      rows,
      false,
      true,
      0,
      (offset) => `cursor-${offset}`,
    );
    const parsed = JSON.parse(shaped.text) as {
      entries: TimelineEntry[];
      count: number;
      raw_count: number;
      hasMore: boolean;
      nextCursor?: string;
      entriesTruncated?: { reason: string };
    };

    expect(shaped.text.length).toBeLessThanOrEqual(SESSION_TIMELINE_RESPONSE_BUDGET_CHARS);
    expect(parsed.entries).toHaveLength(shaped.count);
    expect(parsed.count).toBeGreaterThan(0);
    expect(parsed.count).toBeLessThan(rows.length);
    expect(parsed.raw_count).toBe(parsed.count);
    expect(parsed.hasMore).toBe(true);
    expect(parsed.nextCursor).toBe(`cursor-${parsed.raw_count}`);
    expect(parsed.entriesTruncated).toMatchObject({ reason: 'response_budget' });
  });

  it('advances by raw rows after a grouped prefix is trimmed', () => {
    const rows: TimelineEntry[] = [
      ...Array.from({ length: 20 }, (_, index) => ({
        kind: 'tool' as const,
        ts: `2026-07-13T07:00:${String(index).padStart(2, '0')}Z`,
        ref: String(index),
        text: `repeat-${index % 2} ${'same-content '.repeat(18)}`,
        tool_name: 'coord:inbox',
        status: 'ok',
        auto: true,
      })),
    ];
    const shaped = buildBoundedTimelineResponse(
      { ok: true, owner: 'su-self' },
      rows,
      true,
      true,
      10,
      (offset) => `cursor-${offset}`,
      900,
    );
    const parsed = JSON.parse(shaped.text) as { raw_count: number; nextCursor?: string; entries: TimelineEntry[] };

    expect(parsed.raw_count).toBe(shaped.rawCount);
    expect(parsed.nextCursor).toBe(`cursor-${10 + parsed.raw_count}`);
    expect(parsed.entries.length).toBe(shaped.entries.length);
    expect(parsed.entries.every((entry) => entry.repeat_count !== undefined)).toBe(true);
  });
});
