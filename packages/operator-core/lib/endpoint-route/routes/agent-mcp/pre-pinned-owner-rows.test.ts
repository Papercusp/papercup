import { describe, expect, it } from 'vitest';
import { DISPLAY_TERMINAL_LAUNCH } from '../../../adv-sessions';
import {
  classifyPrePinnedOwnerRows,
  describePrePinnedConflicts,
  type PrePinnedOwnerRow,
} from './pre-pinned-owner-rows';

const precursor = (id: string): PrePinnedOwnerRow => ({
  id,
  display: DISPLAY_TERMINAL_LAUNCH,
  has_session: false,
});
const registered = (id: string): PrePinnedOwnerRow => ({
  id,
  display: DISPLAY_TERMINAL_LAUNCH,
  has_session: true,
});
const console_ = (id: string): PrePinnedOwnerRow => ({ id, display: null, has_session: true });

/**
 * A query result that yields EQUAL-BUT-NOT-IDENTICAL row objects on every
 * traversal — the behaviour of any lazily-mapped, proxied or instrumented driver
 * result. A plain array can never exhibit it, which is precisely why the hazard
 * survived review: no ordinary fixture reproduces it.
 *
 * The mutant is expressed HERE rather than by editing the source, because this is a
 * shared auto-committing tree — a mutate-run-restore probe races git-sync and has
 * already committed a mutant in this repo.
 */
function freshEachTraversal(rows: readonly PrePinnedOwnerRow[]): Iterable<PrePinnedOwnerRow> {
  return {
    *[Symbol.iterator]() {
      for (const r of rows) yield { ...r };
    },
  };
}

describe('classifyPrePinnedOwnerRows', () => {
  it("adopts the launcher's own starting row rather than refusing it", () => {
    const { precursors, conflicts } = classifyPrePinnedOwnerRows([precursor('14746')]);
    expect(precursors.map((r) => r.id)).toEqual(['14746']);
    expect(conflicts).toEqual([]);
  });

  it('still refuses an owner id already bound to a REGISTERED session', () => {
    // The split-identity case the freshness guard exists for (WI-5002/EI-13277).
    const { precursors, conflicts } = classifyPrePinnedOwnerRows([registered('900'), console_('901')]);
    expect(precursors).toEqual([]);
    expect(conflicts.map((r) => r.id)).toEqual(['900', '901']);
  });

  it('puts a registered row with positive dead-process evidence in the reclaimable bucket', () => {
    const { reclaimableConflicts, conflicts } = classifyPrePinnedOwnerRows([
      { ...registered('900'), liveness: 'dead' },
    ]);
    expect(reclaimableConflicts.map((r) => r.id)).toEqual(['900']);
    expect(conflicts).toEqual([]);
  });

  it('keeps a live registered row blocking the pre-pinned owner', () => {
    const { reclaimableConflicts, conflicts } = classifyPrePinnedOwnerRows([
      { ...registered('900'), liveness: 'live' },
    ]);
    expect(reclaimableConflicts).toEqual([]);
    expect(conflicts.map((r) => r.id)).toEqual(['900']);
  });

  it('keeps unknown or missing liveness blocking — absence is not proof of death', () => {
    const { reclaimableConflicts, conflicts } = classifyPrePinnedOwnerRows([
      registered('900'),
      { ...registered('901'), liveness: 'unknown' },
    ]);
    expect(reclaimableConflicts).toEqual([]);
    expect(conflicts.map((r) => r.id)).toEqual(['900', '901']);
  });

  it('separates a precursor from a real conflict in the same result', () => {
    const { precursors, conflicts } = classifyPrePinnedOwnerRows([precursor('14746'), registered('900')]);
    expect(precursors.map((r) => r.id)).toEqual(['14746']);
    expect(conflicts.map((r) => r.id)).toEqual(['900']);
  });

  it('puts every row in exactly one bucket, so none is silently dropped', () => {
    const rows = [
      precursor('1'),
      registered('2'),
      console_('3'),
      { ...registered('4'), liveness: 'dead' as const },
    ];
    const { precursors, reclaimableConflicts, conflicts } = classifyPrePinnedOwnerRows(rows);
    expect([...precursors, ...reclaimableConflicts, ...conflicts]).toHaveLength(rows.length);
  });

  // THE REGRESSION GUARD. WI-37858: a 409 named a row that satisfied the precursor
  // predicate by the time it was read back, so the misclassification had to come
  // from the CLASSIFIER, not the data.
  it('classifies by value, not identity — a result yielding fresh objects per traversal still adopts', () => {
    const live = freshEachTraversal([precursor('14746')]);
    const { precursors, conflicts } = classifyPrePinnedOwnerRows(live);
    expect(conflicts).toEqual([]);
    expect(precursors.map((r) => r.id)).toEqual(['14746']);
  });

  it('the superseded two-filter shape DID misclassify that row — proving the guard above can fail', () => {
    // The exact pre-WI-37858 algorithm. Kept as an executable statement of the bug:
    // if someone reintroduces `filter` + `includes`, this is what they get.
    const legacy = (rows: PrePinnedOwnerRow[]) => {
      const precursors = rows.filter((r) => r.display === DISPLAY_TERMINAL_LAUNCH && !r.has_session);
      return rows.filter((r) => !precursors.includes(r));
    };
    // Two traversals of a result that re-materialises its rows: identity is lost
    // between them, so the launcher's own precursor is refused as a conflict.
    const traversed = [...freshEachTraversal([precursor('14746')])];
    const reTraversed = traversed.map((r) => ({ ...r }));
    const precursors = traversed.filter((r) => r.display === DISPLAY_TERMINAL_LAUNCH && !r.has_session);
    expect(reTraversed.filter((r) => !precursors.includes(r)).map((r) => r.id)).toEqual(['14746']);
    // …while a plain array — every fixture anyone would have written — looks fine.
    expect(legacy([precursor('14746')])).toEqual([]);
  });
});

describe('describePrePinnedConflicts', () => {
  it('reports why each row failed the precursor test', () => {
    expect(describePrePinnedConflicts([registered('900'), console_('901')])).toBe(
      '900(display=terminal,session=bound), 901(display=null,session=bound)',
    );
  });

  it('renders a null display without collapsing it into an empty string', () => {
    // `display=` would read as "the column is blank"; it is genuinely NULL.
    expect(describePrePinnedConflicts([{ id: '7', display: null, has_session: false }])).toContain(
      'display=null',
    );
  });
});
