import { describe, expect, it } from 'vitest';
import { DISPLAY_TERMINAL_LAUNCH } from '../../../adv-sessions';
import {
  classifyPrePinnedOwnerRows,
  describePrePinnedConflicts,
  refinePrePinnedRowLiveness,
  resolvePrePinnedOwnerLiveness,
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

describe('resolvePrePinnedOwnerLiveness', () => {
  const witnessWith = (over: {
    findHost?: (id: string) => unknown;
    beat?: { pid?: number | null; host?: string | null } | null;
    probe?: (r: { host?: string | null; pid?: number | null }) => boolean | null;
  }) => ({
    findHost: over.findHost ?? (() => null),
    beat: over.beat === undefined ? null : over.beat,
    probeBeat: over.probe ?? (() => null),
  });

  it('a live pty host is positive live evidence and settles the verdict before probing', () => {
    let probed = false;
    const verdict = resolvePrePinnedOwnerLiveness(
      'su-x01',
      witnessWith({ findHost: () => ({ ownerId: 'su-x01' }), probe: () => (probed = true) && false }),
    );
    expect(verdict).toBe('live');
    expect(probed).toBe(false);
  });

  it('an authoritative ESRCH on the supervisor-beat pid is the ONLY dead verdict', () => {
    expect(
      resolvePrePinnedOwnerLiveness('su-x02', witnessWith({ beat: { pid: 17840, host: 'this-box' }, probe: () => false })),
    ).toBe('dead');
  });

  it('a living beat pid reads live even without a pty host — headless between wakes is alive', () => {
    expect(
      resolvePrePinnedOwnerLiveness('su-x03', witnessWith({ beat: { pid: 1, host: 'this-box' }, probe: () => true })),
    ).toBe('live');
  });

  it('every inconclusive shape stays unknown: no beat, foreign host, EPERM', () => {
    expect(resolvePrePinnedOwnerLiveness('su-x04', witnessWith({}))).toBe('unknown');
    expect(
      resolvePrePinnedOwnerLiveness('su-x05', witnessWith({ beat: { pid: 2, host: 'elsewhere' }, probe: () => null })),
    ).toBe('unknown');
    expect(resolvePrePinnedOwnerLiveness('su-x06', witnessWith({ beat: { pid: 3, host: 'this-box' }, probe: () => null }))).toBe('unknown');
  });
});

describe('refinePrePinnedRowLiveness (EI-21417550055038906 — the half-terminal ghost)', () => {
  it("a row's own terminal evidence upgrades an inconclusive owner verdict to dead", () => {
    // The measured stranding: psu members carry pid NULL / host '' beats, so the
    // owner-level probe is permanently 'unknown' — only the row's persisted
    // ended_by can testify that its teardown observed the death.
    expect(refinePrePinnedRowLiveness('unknown', true)).toBe('dead');
  });

  it('positive live evidence for the owner still wins over row residue', () => {
    // Until every reactivation path reliably clears the complete terminal tuple,
    // a LIVE resumed session can carry stale ended_by residue; reclaiming its
    // binding would mint the split identity the guard exists to prevent.
    expect(refinePrePinnedRowLiveness('live', true)).toBe('live');
  });

  it('no terminal evidence passes the owner verdict through unchanged', () => {
    expect(refinePrePinnedRowLiveness('unknown', false)).toBe('unknown');
    expect(refinePrePinnedRowLiveness('dead', false)).toBe('dead');
    expect(refinePrePinnedRowLiveness('live', false)).toBe('live');
  });

  it('feeds the classifier: a half-terminal registered row lands reclaimable, not blocking', () => {
    // End-to-end through classifyPrePinnedOwnerRows, the exact bootstrap-su
    // mapping: owner verdict 'unknown' + row terminal evidence ⇒ 'dead' ⇒
    // reclaimableConflicts ⇒ markAdvSessionEnded stamps it instead of 409-ing
    // the owner's own cold-carry successor.
    const { precursors, reclaimableConflicts, conflicts } = classifyPrePinnedOwnerRows([
      { ...registered('18422'), liveness: refinePrePinnedRowLiveness('unknown', true) },
    ]);
    expect(precursors).toEqual([]);
    expect(reclaimableConflicts.map((r) => r.id)).toEqual(['18422']);
    expect(conflicts).toEqual([]);
  });
});
