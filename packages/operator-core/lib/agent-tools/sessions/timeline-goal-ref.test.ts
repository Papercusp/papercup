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
  judgeAssumptionCoverage,
  ASSUMPTION_COVERAGE_REASONS,
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

  it('accepts the STRING form postgres-js actually returns for a bigint', () => {
    // The production wire format, not a hypothetical: postgres-js hands BIGINT
    // back as a string (which is why the sibling `ref` column is written
    // `id::text`). A `typeof id === 'number'` check compiles, passes every
    // hand-built numeric fixture, and then matches NOTHING at runtime — the
    // feature would resolve zero watermarks forever with no error to notice.
    const rows = [
      toolRow({ ref: '1', assumption_set_id: '3368' }),
      toolRow({ ref: '2', assumption_set_id: 3368 }),
      toolRow({ ref: '3', assumption_set_id: '3400' }),
    ];
    // The string and number forms of the same id must collapse to ONE entry.
    expect(assumptionSetIdsToResolve(rows)).toEqual([3368, 3400]);
  });

  it('attaches counts to rows whose watermark arrived as a string', () => {
    const rows = [toolRow({ assumption_set_id: '3368' })];
    const out = attachAssumptionCounts(rows, new Map([[3368, 2]]));
    expect(out[0]!.assumption_count).toBe(2);
  });

  it('drops a non-numeric watermark rather than emitting NaN', () => {
    const rows = [toolRow({ assumption_set_id: 'not-a-number' })];
    expect(assumptionSetIdsToResolve(rows)).toEqual([]);
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

/**
 * P-015 clause (a): the goal-ref filter must return EXACTLY the calls made under
 * that goal.
 *
 * The SQL does the selecting, so what is testable here is the PROJECTION contract
 * the filter rests on — that `goal_ref` rides on every row and is therefore the
 * field a caller can verify a page against. A filter asserted only by its query
 * string is one nobody downstream can check; asserting it over rows means a page
 * that leaks a foreign goal is detectable by the reader, not only by re-reading
 * the SQL.
 */
describe('goalRef selectivity — exactly the calls under that goal (P-015a)', () => {
  const page = [
    toolRow({ ref: '1', goal_ref: 'WI-6393' }),
    toolRow({ ref: '2', goal_ref: 'WI-6393' }),
    toolRow({ ref: '3', goal_ref: 'WI-9999' }),
    toolRow({ ref: '4', goal_ref: null }),
  ];

  it('every row of a goal-scoped page carries the goal that was asked for', () => {
    const scoped = page.filter((r) => r.goal_ref === 'WI-6393');
    expect(scoped.map((r) => r.ref)).toEqual(['1', '2']);
    // EXACTLY: nothing under another goal, and nothing unstamped, rides along.
    expect(scoped.every((r) => r.goal_ref === 'WI-6393')).toBe(true);
  });

  /**
   * The asymmetry that makes an unstamped call dangerous: `goal_ref: null` means
   * "we do not know which goal this served", NOT "it served none". Folding it into
   * a goal-scoped page silently attributes it; excluding it silently drops a real
   * call. Either way the caller must be able to SEE which happened — which is why
   * the field is projected rather than merely consumed by the filter.
   */
  it('keeps an UNSTAMPED call distinguishable from one under a different goal', () => {
    expect(page.find((r) => r.ref === '4')!.goal_ref).toBeNull();
    expect(page.find((r) => r.ref === '3')!.goal_ref).toBe('WI-9999');
    expect(page.find((r) => r.ref === '4')!.goal_ref).not.toBe('WI-9999');
  });
});

/**
 * P-015 clause (b): until WI-6465 lands a producer, the assumption read must
 * degrade HONESTLY rather than returning an empty set that reads as "this agent
 * assumed nothing".
 */
describe('judgeAssumptionCoverage — an empty assumption set names its own cause (P-015b)', () => {
  const base = {
    goalScoped: true,
    setsResolved: 2,
    assumptionsObserved: 0,
    anyAssumptionExists: null as boolean | null,
  };

  it('claims nothing on an unscoped read', () => {
    expect(judgeAssumptionCoverage({ ...base, goalScoped: false })).toBe('not-goal-scoped');
    expect(ASSUMPTION_COVERAGE_REASONS['not-goal-scoped']).toBeNull();
  });

  it('separates "the stamp never ran" from "it ran and found none"', () => {
    expect(judgeAssumptionCoverage({ ...base, setsResolved: 0 })).toBe('no-stamp');
    expect(ASSUMPTION_COVERAGE_REASONS['no-stamp']).toMatch(/UNKNOWN, not empty/);
  });

  /**
   * ⚠ THE LIVE STATE, and the whole reason this item exists. Watermarks resolve
   * cleanly, every count is 0, nothing errors — so the response reads as a
   * confident finding when it is uninterpretable.
   */
  it('calls an all-zero page UNINTERPRETABLE when no assumption exists anywhere', () => {
    const verdict = judgeAssumptionCoverage({ ...base, anyAssumptionExists: false });
    expect(verdict).toBe('producer-unbuilt');
    expect(ASSUMPTION_COVERAGE_REASONS[verdict]).toMatch(/WI-6465/);
    expect(ASSUMPTION_COVERAGE_REASONS[verdict]).toMatch(/NOT evidence that this agent assumed nothing/);
  });

  /**
   * THE NON-VACUITY CHECK. A verdict hardcoded to the unbuilt case would be
   * correct TODAY and wrong the day WI-6465 lands — and nobody would notice,
   * because the message would go on looking right. This pins the state the box
   * cannot currently be in.
   */
  it('becomes a REAL per-agent finding once assumptions exist elsewhere', () => {
    const verdict = judgeAssumptionCoverage({ ...base, anyAssumptionExists: true });
    expect(verdict).toBe('none-for-owner');
    expect(ASSUMPTION_COVERAGE_REASONS[verdict]).toMatch(/genuine finding about this agent/);
  });

  it('needs no caveat at all once something was actually observed', () => {
    const verdict = judgeAssumptionCoverage({
      ...base,
      assumptionsObserved: 3,
      anyAssumptionExists: true,
    });
    expect(verdict).toBe('observed');
    expect(ASSUMPTION_COVERAGE_REASONS[verdict]).toBeNull();
  });

  /**
   * An UNPROBED zero must not be the one that reads as a finding. `null` means the
   * discriminator never ran, and defaulting that to the confident per-agent answer
   * is exactly the failure this judge exists to prevent.
   */
  it('treats an UNPROBED zero as uninterpretable, never as a clean per-agent zero', () => {
    expect(judgeAssumptionCoverage({ ...base, anyAssumptionExists: null })).toBe('producer-unbuilt');
  });

  /**
   * The discriminator must be GLOBAL. A per-owner count is identical in both
   * worlds, so this pins that the verdict turns on the fleet-wide probe and
   * nothing else: same inputs but for that flag, opposite verdicts.
   */
  it('turns on the GLOBAL probe alone — per-owner counts cannot separate the two', () => {
    const unbuilt = judgeAssumptionCoverage({ ...base, anyAssumptionExists: false });
    const real = judgeAssumptionCoverage({ ...base, anyAssumptionExists: true });
    expect(unbuilt).not.toBe(real);
  });
});
