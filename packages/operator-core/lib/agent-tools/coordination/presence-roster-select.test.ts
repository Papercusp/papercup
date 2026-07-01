/**
 * presence-roster-select.test.ts — the DEFECT-1 (include_stale footgun) contract,
 * unit-tested pure (no PG).
 *
 * `selectRosterRows` is what decides the coord:presence `active` payload:
 *   - a default read returns the ACTIONABLE roster (live | parked | recorded)
 *     and NEVER an `ended` row — the dead-row pile that ballooned the payload
 *     42KB→151KB when `include_stale` expanded the full stale roster.
 *   - a targeted `owner:<id>` read returns the matched row(s) EVEN IF `ended`
 *     (the "inspect / wake one specific dead agent" path that replaced the dump).
 */
import { describe, it, expect } from 'vitest';
import { selectRosterRows, matchesOwner } from './presence-snapshot';
import type { RosterRow } from './presence-payload';
import type { SessionState } from './presence-wakeability';

function row(ownerId: string, sessionState: SessionState | null, ownerLabel = ownerId): RosterRow {
  return { ownerId, ownerLabel, sessionState } as unknown as RosterRow;
}

const roster = (): RosterRow[] => [
  row('su-live', 'live'),
  row('su-parked', 'parked'),
  row('su-recorded', 'recorded'),
  row('su-dead-1', 'ended'),
  row('su-dead-2', 'ended'),
  row('fed:peer', null), // federated / unknown → not ended
];

describe('selectRosterRows — default read (no owner)', () => {
  it('excludes EVERY ended row (the payload footgun) but keeps live/parked/recorded/unknown', () => {
    const out = selectRosterRows(roster());
    const ids = out.map((r) => r.ownerId);
    expect(ids).not.toContain('su-dead-1');
    expect(ids).not.toContain('su-dead-2');
    expect(ids).toEqual(['fed:peer', 'su-live', 'su-parked', 'su-recorded']); // sorted, ended dropped
  });

  it('a roster of only ended rows returns an empty actionable list', () => {
    expect(selectRosterRows([row('d1', 'ended'), row('d2', 'ended')])).toEqual([]);
  });

  it('is byte-stable: sorted by ownerId regardless of input order', () => {
    const a = selectRosterRows([row('c', 'live'), row('a', 'parked'), row('b', 'recorded')]);
    const b = selectRosterRows([row('a', 'parked'), row('b', 'recorded'), row('c', 'live')]);
    expect(a.map((r) => r.ownerId)).toEqual(['a', 'b', 'c']);
    expect(a).toEqual(b);
  });
});

describe('selectRosterRows — targeted owner read (the include_stale replacement)', () => {
  it('returns a specific ENDED agent by exact id (inspect/wake one dead agent)', () => {
    const out = selectRosterRows(roster(), 'su-dead-1');
    expect(out.map((r) => r.ownerId)).toEqual(['su-dead-1']);
    expect(out[0].sessionState).toBe('ended');
  });

  it('returns a live/parked agent too when targeted', () => {
    expect(selectRosterRows(roster(), 'su-parked').map((r) => r.ownerId)).toEqual(['su-parked']);
  });

  it('does NOT expand the whole stale roster — only the match(es)', () => {
    // The footgun was a *global* dump; a targeted read never returns the other dead rows.
    const out = selectRosterRows(roster(), 'su-dead-2');
    expect(out.map((r) => r.ownerId)).toEqual(['su-dead-2']);
  });

  it('an owner that matches nothing returns an empty list', () => {
    expect(selectRosterRows(roster(), 'nobody-here')).toEqual([]);
  });
});

describe('matchesOwner — id/label fuzz (mirrors coord:dispatch findPresenceRow)', () => {
  const r = row('su-1234-abcd', null, 'my-bee');
  it('matches an exact ownerId', () => expect(matchesOwner(r, 'su-1234-abcd')).toBe(true));
  it('matches an exact ownerLabel', () => expect(matchesOwner(r, 'my-bee')).toBe(true));
  it('matches a substring of the id (handle/prefix)', () => expect(matchesOwner(r, '1234')).toBe(true));
  it('matches when the needle is a superstring of the id', () =>
    expect(matchesOwner(r, 'su-1234-abcd-extra')).toBe(true));
  it('does not match an unrelated needle', () => expect(matchesOwner(r, 'zzz')).toBe(false));
  it('an empty needle never matches', () => expect(matchesOwner(r, '')).toBe(false));
});
