import { describe, expect, it } from 'vitest';
import {
  buildAutomaticCallAuditSummary,
  groupRepeatedTimelineEntries,
  type TimelineEntry,
} from './timeline';

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
        rule: 'automatic_calls match the known hook/status tool set; every other tool invocation is agent-authored',
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
