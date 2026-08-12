/**
 * EI-18685043834332306 — the pure recurrence-aging policy.
 *
 * The whole point of extracting this module is that the POLICY can be tested without a
 * database: the SQL half only persists what these functions decide. The one design call under
 * test is that the episode is keyed on the SET OF OFFENDER IDENTITIES rather than on a count
 * or a boolean, which is what makes it answer both re-notification questions at once — did the
 * composition change, and did the magnitude escalate. A count comparison answers the second
 * with infinite sensitivity and the first not at all; a boolean answers the first once and the
 * second never. Several tests below exist specifically to fail if someone "simplifies" this
 * back to either.
 */
import { describe, expect, it } from 'vitest';
import {
  episodeSeverity,
  nextEpisodeMark,
  parseEpisodeMark,
  renderRecurrence,
  summarizeEpisode,
  type EpisodeMark,
  type OffenderObservation,
} from './routine-validation-episode';

const NOW = 1_800_000_000_000;
const mark = (over: Partial<EpisodeMark> = {}): EpisodeMark => ({
  firstSeenMs: NOW - 3_600_000,
  lastSeenMs: NOW - 60_000,
  occurrences: 5,
  ...over,
});
const seen = (key: string, prior: EpisodeMark | null): OffenderObservation => ({ key, prior });

describe('parseEpisodeMark', () => {
  it('reads a mark whose numbers came back as jsonb numbers', () => {
    expect(parseEpisodeMark({ firstSeenMs: 1, lastSeenMs: 2, occurrences: 3 })).toEqual({
      firstSeenMs: 1,
      lastSeenMs: 2,
      occurrences: 3,
    });
  });

  it('reads a mark whose numbers came back as TEXT — `->>` yields strings', () => {
    // Not hypothetical: whether a field arrives as a number or a string depends on how the
    // row is projected, and a parser that only accepted numbers would read every `->>`
    // projection as "never seen" and re-FATAL forever.
    expect(parseEpisodeMark({ firstSeenMs: '1', lastSeenMs: '2', occurrences: '3' })).toEqual({
      firstSeenMs: 1,
      lastSeenMs: 2,
      occurrences: 3,
    });
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'chronic'],
    ['an array', [1, 2, 3]],
    ['a partial mark', { firstSeenMs: 1 }],
    ['a non-numeric field', { firstSeenMs: 1, lastSeenMs: 'yesterday', occurrences: 3 }],
    ['an empty-string field', { firstSeenMs: '', lastSeenMs: '2', occurrences: '3' }],
    ['a NaN field', { firstSeenMs: Number.NaN, lastSeenMs: 2, occurrences: 3 }],
  ])('reads %s as NEVER SEEN, which escalates rather than silencing', (_label, raw) => {
    // THE DIRECTION MATTERS AND IS THE SAFE ONE. An unreadable mark makes the offender look
    // fresh, so the alarm fires. The opposite default would let one corrupt or schema-drifted
    // mark silence a real alarm permanently — this module's own bug, one level up.
    expect(parseEpisodeMark(raw)).toBeNull();
  });
});

describe('nextEpisodeMark', () => {
  it('starts a new episode at the current instant', () => {
    expect(nextEpisodeMark(null, NOW)).toEqual({
      firstSeenMs: NOW,
      lastSeenMs: NOW,
      occurrences: 1,
    });
  });

  it('never rewrites firstSeenMs — it is the age of the condition, not of the observation', () => {
    const next = nextEpisodeMark(mark({ firstSeenMs: 123, occurrences: 41 }), NOW);
    expect(next.firstSeenMs).toBe(123);
    expect(next.lastSeenMs).toBe(NOW);
    expect(next.occurrences).toBe(42);
  });
});

describe('summarizeEpisode / episodeSeverity — the transition test', () => {
  it('an offender set that GREW is a transition: FATAL', () => {
    const summary = summarizeEpisode([seen('a/x', mark()), seen('b/y', null)], 0);
    expect(summary).toMatchObject({ offenders: 2, fresh: 1, chronic: 1, cleared: 0, setChanged: true });
    expect(episodeSeverity(summary)).toBe('fatal');
  });

  it('an offender set that SHRANK is also a transition: FATAL', () => {
    // Half the design. Keying on a count would call this a decrease and (depending on the
    // hand-tuned direction) usually stay quiet; keying on the SET makes losing a member a
    // change for free, with no second axis for anyone to tune.
    const summary = summarizeEpisode([seen('a/x', mark())], 1);
    expect(summary).toMatchObject({ fresh: 0, chronic: 1, cleared: 1, setChanged: true });
    expect(episodeSeverity(summary)).toBe('fatal');
  });

  it('an UNCHANGED set is chronic however many times it recurs', () => {
    const summary = summarizeEpisode([seen('a/x', mark()), seen('b/y', mark())], 0);
    expect(summary.setChanged).toBe(false);
    expect(episodeSeverity(summary)).toBe('chronic');
  });

  it('a fully resolved condition still reports the shrink', () => {
    const summary = summarizeEpisode([], 3);
    expect(summary).toMatchObject({ offenders: 0, fresh: 0, chronic: 0, cleared: 3, setChanged: true });
  });

  it('reports the OLDEST and NEWEST first-seen across the set, not just one of them', () => {
    // oldest = how long this has been broken; newest = when the set last grew. Collapsing
    // them to a single timestamp is what makes a chronic line unreadable.
    const summary = summarizeEpisode(
      [
        seen('a/x', mark({ firstSeenMs: NOW - 86_400_000, occurrences: 900 })),
        seen('b/y', mark({ firstSeenMs: NOW - 600_000, occurrences: 3 })),
      ],
      0,
    );
    expect(summary.oldestFirstSeenMs).toBe(NOW - 86_400_000);
    expect(summary.newestFirstSeenMs).toBe(NOW - 600_000);
    expect(summary.maxOccurrences).toBe(901);
  });

  it('a negative cleared count cannot fabricate a transition', () => {
    expect(summarizeEpisode([seen('a/x', mark())], -2)).toMatchObject({ cleared: 0, setChanged: false });
  });
});

describe('renderRecurrence — a new alarm must READ differently from a chronic one', () => {
  it('names what changed when the set changed', () => {
    const line = renderRecurrence(
      summarizeEpisode([seen('a/x', mark({ firstSeenMs: NOW - 7_200_000 })), seen('b/y', null)], 2),
      NOW,
    );
    expect(line).toContain('CHANGED');
    expect(line).toContain('1 NEW');
    expect(line).toContain('2 resolved since last check');
    expect(line).toContain('1 pre-existing (oldest 2h ago)');
  });

  it('carries occurrence count, first-seen and last-changed when nothing changed', () => {
    // The item's literal ask: the emitted line carries occurrence count + first-seen +
    // last-changed, and a repeat collapses instead of re-firing.
    const line = renderRecurrence(
      summarizeEpisode(
        [seen('a/x', mark({ firstSeenMs: NOW - 86_400_000, occurrences: 40 }))],
        0,
      ),
      NOW,
    );
    expect(line).toContain('CHRONIC');
    expect(line).toContain('unchanged set of 1');
    expect(line).toContain('41st consecutive check');
    expect(line).toContain('first seen 24h ago');
  });

  it.each([
    [1, '1st'],
    [2, '2nd'],
    [3, '3rd'],
    [4, '4th'],
    [11, '11th'],
    [12, '12th'],
    [13, '13th'],
    [21, '21st'],
    [102, '102nd'],
    [111, '111th'],
    [10_000, '10000th'], // the item's own example — the ten-thousandth occurrence
  ])('ordinalizes occurrence %i as %s', (occurrences, expected) => {
    const line = renderRecurrence(
      summarizeEpisode([seen('a/x', mark({ occurrences: occurrences - 1 }))], 0),
      NOW,
    );
    expect(line).toContain(`${expected} consecutive check`);
  });

  it.each([
    [30_000, 'just now'],
    [5 * 60_000, '5m ago'],
    [3 * 3_600_000, '3h ago'],
    [10 * 86_400_000, '10d ago'],
  ])('formats an age of %ims as %s', (ageMs, expected) => {
    const line = renderRecurrence(
      summarizeEpisode([seen('a/x', mark({ firstSeenMs: NOW - ageMs }))], 0),
      NOW,
    );
    expect(line).toContain(`first seen ${expected}`);
  });

  it('says "unknown" rather than inventing an age it does not have', () => {
    const line = renderRecurrence(summarizeEpisode([seen('a/x', null)], 0), NOW);
    expect(line).toContain('CHANGED');
    expect(line).toContain('1 NEW');
  });

  it('a clock that ran backwards reports "just now", never a negative age', () => {
    const line = renderRecurrence(
      summarizeEpisode([seen('a/x', mark({ firstSeenMs: NOW + 60_000 }))], 0),
      NOW,
    );
    expect(line).toContain('first seen just now');
    expect(line).not.toContain('-');
  });
});
