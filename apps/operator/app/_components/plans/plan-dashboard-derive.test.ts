// plan-dashboard-derive (plan-dashboard-mission-control-2026-08-31 P-001):
// the pure derivations behind the direction-A dashboard — status counts,
// item grouping, newest-decisions, and the activity noise collapse.
import { describe, expect, it } from 'vitest';
import type { PlanItem } from '@/app/admin/plans/plans-api';
import {
  collapsePlanActivity,
  groupPlanItems,
  newestDecisions,
  statusCountsOf,
  type PlanActivityFeedRow,
} from './plan-dashboard-derive';

function item(id: string, effectiveStatus: PlanItem['effectiveStatus']): PlanItem {
  return { id, storedStatus: effectiveStatus, effectiveStatus, text: `text ${id}` };
}

describe('statusCountsOf', () => {
  it('buckets by effectiveStatus; blocked + needs-human are attention; total counts every item', () => {
    const c = statusCountsOf([
      item('P-001', 'done'), item('P-002', 'done'),
      item('P-003', 'wip'),
      item('P-004', 'todo'), item('P-005', 'todo'),
      item('P-006', 'blocked'), item('P-007', 'needs-human'),
      item('P-008', 'dropped'),
    ])!;
    expect(c).toEqual({ done: 2, wip: 1, todo: 2, attention: 2, dropped: 1, total: 8 });
  });

  it('returns null for empty/undefined (no band renders)', () => {
    expect(statusCountsOf(undefined)).toBeNull();
    expect(statusCountsOf([])).toBeNull();
  });
});

describe('groupPlanItems', () => {
  it('orders attention → wip → todo → doneish, omits empty groups, keeps document order inside a group', () => {
    const groups = groupPlanItems([
      item('P-001', 'done'),
      item('P-002', 'todo'),
      item('P-003', 'wip'),
      item('P-004', 'needs-human'),
      item('P-005', 'todo'),
      item('P-006', 'dropped'),
    ]);
    expect(groups.map((g) => g.key)).toEqual(['attention', 'wip', 'todo', 'doneish']);
    expect(groups[2]!.items.map((i) => i.id)).toEqual(['P-002', 'P-005']);
    // done + dropped share the terminal group.
    expect(groups[3]!.items.map((i) => i.id)).toEqual(['P-001', 'P-006']);
    expect(groupPlanItems([item('P-001', 'wip')]).map((g) => g.key)).toEqual(['wip']);
  });
});

describe('newestDecisions', () => {
  it('sorts by numeric D-id descending and caps at n', () => {
    const out = newestDecisions(
      [{ id: 'D-002' }, { id: 'D-015' }, { id: 'D-009' }],
      2,
    );
    expect(out.map((d) => d.id)).toEqual(['D-015', 'D-009']);
  });
});

/* ── collapsePlanActivity ────────────────────────────────────────────────
   Feed rows arrive NEWEST-FIRST (plan-activity-feed.ts mergeActivityRows). */

function editRow(over: Partial<PlanActivityFeedRow> & { text: string }): PlanActivityFeedRow {
  return { kind: 'edit', tsMs: 1000, who: 'su-aaaaa', ...over };
}
function workRow(over?: Partial<PlanActivityFeedRow>): PlanActivityFeedRow {
  return { kind: 'work', tsMs: 5000, text: 'WI-1 wip — thing', ref: 'WI-1', who: 'su-aaaaa', ...over };
}

describe('collapsePlanActivity', () => {
  it('folds ≥2 consecutive generic edits by the same author into one run with rev + time range', () => {
    const out = collapsePlanActivity([
      workRow({ tsMs: 9000 }),
      editRow({ text: 'Plan edited (rev 34)', ref: 'rev:34', tsMs: 8000 }),
      editRow({ text: 'Plan edited (rev 33)', ref: 'rev:33', tsMs: 7000 }),
      editRow({ text: 'Plan edited (rev 32)', ref: 'rev:32', tsMs: 6000 }),
    ]);
    expect(out.map((e) => e.type)).toEqual(['row', 'run']);
    const run = out[1]! as Extract<(typeof out)[number], { type: 'run' }>;
    expect(run.count).toBe(3);
    expect(run.revLo).toBe(32);
    expect(run.revHi).toBe(34);
    expect(run.tsNewestMs).toBe(8000);
    expect(run.tsOldestMs).toBe(6000);
    expect(run.who).toBe('su-aaaaa');
  });

  it('a SINGLETON generic edit stays a plain row (never a ×1 run)', () => {
    const out = collapsePlanActivity([
      editRow({ text: 'Plan edited (rev 12)', ref: 'rev:12' }),
      workRow(),
    ]);
    expect(out.map((e) => e.type)).toEqual(['row', 'row']);
    expect((out[0] as { row: PlanActivityFeedRow }).row.text).toBe('Plan edited (rev 12)');
  });

  it('an author change breaks the run', () => {
    const out = collapsePlanActivity([
      editRow({ text: 'Plan edited (rev 4)', ref: 'rev:4', who: 'su-aaaaa' }),
      editRow({ text: 'Plan edited (rev 3)', ref: 'rev:3', who: 'su-aaaaa' }),
      editRow({ text: 'Plan edited (rev 2)', ref: 'rev:2', who: 'su-bbbbb' }),
      editRow({ text: 'Plan edited (rev 1)', ref: 'rev:1', who: 'su-bbbbb' }),
    ]);
    expect(out.map((e) => e.type)).toEqual(['run', 'run']);
    expect((out[0] as { who?: string }).who).toBe('su-aaaaa');
    expect((out[1] as { who?: string }).who).toBe('su-bbbbb');
  });

  it('a substantive rationale is promoted to a note and interrupts a run', () => {
    const out = collapsePlanActivity([
      editRow({ text: 'Plan edited (rev 6)', ref: 'rev:6', tsMs: 6000 }),
      editRow({ text: 'Plan edited (rev 5)', ref: 'rev:5', tsMs: 5000 }),
      editRow({ text: 'Records the first powered acceptance measurement.', ref: 'rev:4', tsMs: 4000 }),
      editRow({ text: 'Plan edited (rev 3)', ref: 'rev:3', tsMs: 3000 }),
    ]);
    expect(out.map((e) => e.type)).toEqual(['run', 'note', 'row']);
  });

  it('work rows pass through untouched, and a bare "Plan edited" (no rev) is still generic', () => {
    const out = collapsePlanActivity([
      workRow({ tsMs: 9000, ref: 'WI-9' }),
      editRow({ text: 'Plan edited', ref: undefined, tsMs: 8000 }),
      editRow({ text: 'Plan edited', ref: undefined, tsMs: 7000 }),
    ]);
    expect(out.map((e) => e.type)).toEqual(['row', 'run']);
    const run = out[1]! as Extract<(typeof out)[number], { type: 'run' }>;
    expect(run.revLo).toBeNull();
    expect(run.revHi).toBeNull();
  });

  it('handles empty input', () => {
    expect(collapsePlanActivity(undefined)).toEqual([]);
    expect(collapsePlanActivity([])).toEqual([]);
  });
});
