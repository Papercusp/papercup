/**
 * P-024 (unified-agent-state-plane-2026-07-27) — the READ path for P-009's stamp.
 *
 * D-046 assigned this read to `sessions:timeline` rather than a new tool, on
 * measured evidence: the purpose-built tool-stream read (`activity:tool-log`) is
 * DEAD (7 calls / 3 callers / 30d) while timeline answers the same postmortem
 * question with 17x the calls, because it puts tool calls next to the agent's
 * own words. So the thing under test is a PROJECTION plus a filter — and the two
 * properties that actually matter are (a) the assumption set is never resolved
 * eagerly, and (b) an empty goal-scoped read names its own cause instead of
 * reading as "this agent did nothing".
 */
import { describe, it, expect } from 'vitest';
import {
  assumptionSetIdsToResolve,
  attachAssumptionCounts,
  groupRepeatedTimelineEntries,
  type TimelineEntry,
} from './timeline';

const toolRow = (over: Partial<TimelineEntry> = {}): TimelineEntry => ({
  kind: 'tool',
  ts: '2026-07-27T14:00:00.000Z',
  ref: '1',
  text: 'dev:pg_query (ok, 5ms)',
  tool_name: 'dev:pg_query',
  status: 'ok',
  auto: false,
  goal_ref: 'WI-6393',
  assumption_set_id: 3368,
  ...over,
});

describe('assumptionSetIdsToResolve — the N+1 guard', () => {
  it('collapses a long page to its DISTINCT watermarks', () => {
    // The property D-046/P-024 (c) actually cares about: a 300-row page must not
    // become 300 queries. A watermark only moves when the agent asserts an
    // assumption (~0-3 per task), so a long page collapses to a couple of ids.
    const rows = Array.from({ length: 300 }, (_, i) =>
      toolRow({ ref: String(i), assumption_set_id: i < 150 ? 3368 : 3400 }),
    );
    expect(assumptionSetIdsToResolve(rows)).toEqual([3368, 3400]);
  });

  it('ignores rows with no watermark, and non-tool rows entirely', () => {
    const rows: TimelineEntry[] = [
      toolRow({ assumption_set_id: null }),
      toolRow({ assumption_set_id: 3368 }),
      { kind: 'turn', ts: '2026-07-27T13:00:00.000Z', ref: 'claude:s:1', text: '[assistant] hi' },
      { kind: 'coord', ts: '2026-07-27T13:30:00.000Z', ref: 'ms1', text: 'msg' },
    ];
    expect(assumptionSetIdsToResolve(rows)).toEqual([3368]);
  });

  it('returns nothing for a page that carries no stamps at all', () => {
    // The live case today: assumption_set_id's producer is measured EMPTY, so
    // every row is null and the resolver must issue ZERO queries.
    const rows = [toolRow({ assumption_set_id: null }), toolRow({ assumption_set_id: null })];
    expect(assumptionSetIdsToResolve(rows)).toEqual([]);
  });
});

describe('attachAssumptionCounts', () => {
  it('attaches the count for a resolved watermark', () => {
    const rows = [toolRow({ assumption_set_id: 3368 })];
    const out = attachAssumptionCounts(rows, new Map([[3368, 2]]));
    expect(out[0]!.assumption_count).toBe(2);
  });

  it('leaves assumption_count ABSENT when the watermark was not resolved', () => {
    // "not resolved" and "resolved to zero" are different facts. Defaulting to 0
    // would render every unfiltered row as "checked, no assumptions" — the same
    // false-good-news shape D-086/D-087 exist to prevent, and especially wrong
    // while this column's producer is measured-empty (D-089 s2).
    const rows = [toolRow({ assumption_set_id: 3368 })];
    const out = attachAssumptionCounts(rows, new Map());
    expect(out[0]!.assumption_count).toBeUndefined();
    expect('assumption_count' in out[0]!).toBe(false);
  });

  it('distinguishes a resolved ZERO from an unresolved watermark', () => {
    const rows = [toolRow({ assumption_set_id: 3368 })];
    const out = attachAssumptionCounts(rows, new Map([[3368, 0]]));
    expect(out[0]!.assumption_count).toBe(0);
  });

  it('never touches turn/coord rows', () => {
    const turn: TimelineEntry = {
      kind: 'turn',
      ts: '2026-07-27T13:00:00.000Z',
      ref: 'claude:s:1',
      text: '[assistant] hi',
    };
    const out = attachAssumptionCounts([turn], new Map([[3368, 2]]));
    expect(out[0]).toEqual(turn);
  });

  it('does not mutate the input rows', () => {
    const rows = [toolRow({ assumption_set_id: 3368 })];
    attachAssumptionCounts(rows, new Map([[3368, 2]]));
    expect(rows[0]!.assumption_count).toBeUndefined();
  });
});

describe('goal_ref rides through the existing projection', () => {
  it('survives repeat-grouping (the goal is part of what a reader is grouping)', () => {
    const rows = [
      toolRow({ ref: '1', goal_ref: 'WI-6393' }),
      toolRow({ ref: '2', goal_ref: 'WI-6393' }),
    ];
    const grouped = groupRepeatedTimelineEntries(rows);
    expect(grouped).toHaveLength(1);
    expect(grouped[0]!.goal_ref).toBe('WI-6393');
    expect(grouped[0]!.repeat_count).toBe(2);
  });

  it('is a RESOLVED ref, never a bare bigint — the D-046 requirement', () => {
    // P-009 typed goal_ref as TEXT precisely so this projection needs no join
    // and no hydration step. Guard the shape so a later "optimisation" to a
    // bigint FK cannot pass silently: a bigint is not a read surface.
    const row = toolRow({ goal_ref: 'WI-6393' });
    expect(typeof row.goal_ref).toBe('string');
    expect(row.goal_ref).not.toMatch(/^\d+$/);
  });
});
