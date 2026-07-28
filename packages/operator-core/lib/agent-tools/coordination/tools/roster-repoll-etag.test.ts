/**
 * WI-6665 — coord:roster's `since:` re-poll guard, and why it CANNOT reuse
 * coord:presence's etag.
 *
 * coord:presence has had a cheap-unchanged re-poll guard since P-006: pass the
 * prior read's `etag` as `since:` and an unchanged roster returns a ~100B stub.
 * coord:roster had no `since:` — yet it emitted `snapshot.etag` through its
 * `...snapshot` spread, handing every caller a token with nothing to spend it on.
 *
 * Porting that etag verbatim would have been wrong twice, and both defects are
 * pinned below because they are invisible until someone re-polls:
 *
 *   1. LENS BLINDNESS — roster applies filterRosterRowsByState + projectRosterRows
 *      AFTER the snapshot, so one roster etag maps to many payloads. A caller that
 *      read `full` then re-read `liveness, since:<that etag>` would be told
 *      "unchanged" about a payload it has never seen.
 *
 *   2. LIVENESS BLINDNESS — the presence etag deliberately EXCLUDES live↔parked
 *      churn (D-006). That is right for presence, and exactly wrong here: this
 *      tool's cheapest lens IS the liveness question, so the guard would have
 *      reported "unchanged" while the live set moved underneath the caller.
 *
 * The fix hashes the EMITTED REPRESENTATION, so `unchanged:true` means "these
 * bytes are the bytes you hold" on every lens, with no per-lens special-casing.
 */

import { describe, it, expect } from 'vitest';
import {
  computeRosterViewEtag,
  computeRosterEtag,
  projectRosterRows,
  filterRosterRowsByState,
} from '../presence-snapshot';

const BASE_LENS = {
  view: 'live',
  scope: 'workspace',
  potId: null,
  project: 'full' as const,
};

/** Rows shaped as assemblePresenceSnapshot emits them (post toStableRosterRow). */
function rows(states: string[], lastActiveSecAgo = 5) {
  return states.map((sessionState, i) => ({
    ownerId: `su-${i}`,
    ownerLabel: `su · ${i}`,
    sessionState,
    wakeable: sessionState === 'parked',
    intent: 'doing a thing',
    lastActiveSecAgo,
  }));
}

/** The real emit path: filter, then project — exactly what the handler does. */
function emit(
  input: ReturnType<typeof rows>,
  project: 'ids' | 'liveness' | 'full',
  states?: string[],
) {
  const { rows: filtered } = filterRosterRowsByState(input, states);
  return projectRosterRows(filtered, project);
}

describe('coord:roster re-poll etag (WI-6665)', () => {
  it('is stable across two reads of an unchanged roster — the guard has to fire at all', () => {
    const a = computeRosterViewEtag(emit(rows(['live', 'parked']), 'liveness'), {
      ...BASE_LENS,
      project: 'liveness',
    });
    const b = computeRosterViewEtag(emit(rows(['live', 'parked']), 'liveness'), {
      ...BASE_LENS,
      project: 'liveness',
    });
    expect(a).toBe(b);
  });

  describe('defect 1: the etag must identify the PAYLOAD, not the roster', () => {
    it('differs across project lenses over identical underlying rows', () => {
      const underlying = rows(['live', 'parked']);
      const full = computeRosterViewEtag(emit(underlying, 'full'), { ...BASE_LENS, project: 'full' });
      const liveness = computeRosterViewEtag(emit(underlying, 'liveness'), {
        ...BASE_LENS,
        project: 'liveness',
      });
      const ids = computeRosterViewEtag(emit(underlying, 'ids'), { ...BASE_LENS, project: 'ids' });

      // If these collided, a caller could re-poll with a DIFFERENT lens and be
      // told it already holds a representation it has never seen.
      expect(new Set([full, liveness, ids]).size).toBe(3);
    });

    it('differs when states[] narrows the read', () => {
      const underlying = rows(['live', 'parked']);
      const unfiltered = computeRosterViewEtag(emit(underlying, 'liveness'), {
        ...BASE_LENS,
        project: 'liveness',
      });
      const liveOnly = computeRosterViewEtag(emit(underlying, 'liveness', ['live']), {
        ...BASE_LENS,
        project: 'liveness',
        states: ['live'],
      });
      expect(unfiltered).not.toBe(liveOnly);
    });

    it('treats states[] as a SET — ordering is not a different lens', () => {
      const underlying = rows(['live', 'parked']);
      const ab = computeRosterViewEtag(emit(underlying, 'liveness', ['live', 'parked']), {
        ...BASE_LENS,
        project: 'liveness',
        states: ['live', 'parked'],
      });
      const ba = computeRosterViewEtag(emit(underlying, 'liveness', ['parked', 'live']), {
        ...BASE_LENS,
        project: 'liveness',
        states: ['parked', 'live'],
      });
      // Same selected rows ⇒ same representation ⇒ the guard must still fire.
      expect(ab).toBe(ba);
    });

    // The cases below are the ones that make the LENS FIELDS in the hash
    // load-bearing rather than decorative. Everywhere else the emitted rows
    // already differ, so the hash would differ even if the lens were omitted —
    // these are where two different questions produce byte-identical rows and
    // only the recorded lens can tell them apart.

    it('does not collide across lenses on an EMPTY roster (rows alone cannot disambiguate)', () => {
      const empty = rows([]);
      const ids = computeRosterViewEtag(emit(empty, 'ids'), { ...BASE_LENS, project: 'ids' });
      const liveness = computeRosterViewEtag(emit(empty, 'liveness'), {
        ...BASE_LENS,
        project: 'liveness',
      });
      const full = computeRosterViewEtag(emit(empty, 'full'), BASE_LENS);
      // Every lens emits `[]` here. Without `project` in the hash these are one
      // token, and an empty-roster caller could re-poll a different lens and be
      // told "unchanged".
      expect(new Set([ids, liveness, full]).size).toBe(3);
    });

    it('does not collide when states[] happens to select EVERY row', () => {
      // All rows are live, so states:['live'] filters nothing — identical rows,
      // genuinely different question.
      const allLive = rows(['live', 'live']);
      const unfiltered = computeRosterViewEtag(emit(allLive, 'liveness'), {
        ...BASE_LENS,
        project: 'liveness',
      });
      const filtered = computeRosterViewEtag(emit(allLive, 'liveness', ['live']), {
        ...BASE_LENS,
        project: 'liveness',
        states: ['live'],
      });
      expect(emit(allLive, 'liveness')).toEqual(emit(allLive, 'liveness', ['live']));
      expect(unfiltered).not.toBe(filtered);
    });

    it('does not collide on include_detail when no agent holds a file', () => {
      // heldFiles is merged in only when present, so an unlensed read and an
      // include_detail read of an idle roster emit the same rows.
      const idle = emit(rows(['live']), 'full');
      const plain = computeRosterViewEtag(idle, BASE_LENS);
      const detailed = computeRosterViewEtag(idle, { ...BASE_LENS, includeDetail: true });
      expect(plain).not.toBe(detailed);
    });

    it('does not collide on a targeted owner lookup that returns the same single row', () => {
      const one = emit(rows(['live']), 'full');
      const untargeted = computeRosterViewEtag(one, BASE_LENS);
      const targeted = computeRosterViewEtag(one, { ...BASE_LENS, owner: 'su-0' });
      expect(untargeted).not.toBe(targeted);
    });

    it('differs across scope / hive, so a token cannot cross a scope boundary', () => {
      const underlying = emit(rows(['live']), 'liveness');
      const ws = computeRosterViewEtag(underlying, { ...BASE_LENS, project: 'liveness' });
      const hive = computeRosterViewEtag(underlying, {
        ...BASE_LENS,
        project: 'liveness',
        scope: 'hive',
        potId: 'papercusp',
      });
      expect(ws).not.toBe(hive);
    });
  });

  describe('defect 2: liveness MUST move the etag on a liveness-bearing lens', () => {
    it('changes when an agent flips live→parked under project:liveness', () => {
      const before = computeRosterViewEtag(emit(rows(['live', 'parked']), 'liveness'), {
        ...BASE_LENS,
        project: 'liveness',
      });
      const after = computeRosterViewEtag(emit(rows(['parked', 'parked']), 'liveness'), {
        ...BASE_LENS,
        project: 'liveness',
      });
      // THE headline defect. coord:presence's etag excludes exactly this
      // transition; here it is the answer the caller asked for.
      expect(before).not.toBe(after);
    });

    it('changes when states:["live"] membership churns — the hot dispatch poll', () => {
      const lens = { ...BASE_LENS, project: 'liveness' as const, states: ['live'] };
      const before = computeRosterViewEtag(emit(rows(['live', 'parked']), 'liveness', ['live']), lens);
      const after = computeRosterViewEtag(emit(rows(['live', 'live']), 'liveness', ['live']), lens);
      expect(before).not.toBe(after);
    });

    it('does NOT move on a live→parked flip under project:ids, because the payload is genuinely identical', () => {
      // Not an oversight — the ids lens emits no sessionState, so the bytes are
      // unchanged and `unchanged:true` is the honest answer. The etag tracks the
      // representation, which is the whole design.
      const before = computeRosterViewEtag(emit(rows(['live', 'parked']), 'ids'), {
        ...BASE_LENS,
        project: 'ids',
      });
      const after = computeRosterViewEtag(emit(rows(['parked', 'parked']), 'ids'), {
        ...BASE_LENS,
        project: 'ids',
      });
      expect(before).toBe(after);
    });

    it('DOES move under project:ids when membership itself changes', () => {
      const before = computeRosterViewEtag(emit(rows(['live', 'parked']), 'ids'), {
        ...BASE_LENS,
        project: 'ids',
      });
      const after = computeRosterViewEtag(emit(rows(['live', 'parked', 'live']), 'ids'), {
        ...BASE_LENS,
        project: 'ids',
      });
      expect(before).not.toBe(after);
    });
  });

  describe('the documented trade-off is real, not aspirational', () => {
    it('churns on the default full read because lastActiveSecAgo moves', () => {
      // The guard degrades to a no-op on the expensive read. We assert it so the
      // tool description stays honest: a guard that is USELESS on the full read,
      // never one that LIES on a cheap one.
      const t0 = computeRosterViewEtag(emit(rows(['live', 'parked'], 5), 'full'), BASE_LENS);
      const t1 = computeRosterViewEtag(emit(rows(['live', 'parked'], 6), 'full'), BASE_LENS);
      expect(t0).not.toBe(t1);
    });

    it('is stable on a cheap lens across that same churn — where the guard earns its keep', () => {
      const lens = { ...BASE_LENS, project: 'liveness' as const };
      const t0 = computeRosterViewEtag(emit(rows(['live', 'parked'], 5), 'liveness'), lens);
      const t1 = computeRosterViewEtag(emit(rows(['live', 'parked'], 6), 'liveness'), lens);
      expect(t0).toBe(t1);
    });
  });

  it('does not collide with a coord:presence token for the same roster', () => {
    // A mismatch is always safe (it yields a full read); a false MATCH is not.
    //
    // ⚠ This passes because of the LENS FIELDS, not the `coord:roster/v1` salt.
    // Mutation-testing (2026-07-28) confirmed removing the salt leaves this and
    // every other test here green — so do not read this as salt coverage. The
    // salt is a version namespace for a future hash change; see the note on
    // computeRosterViewEtag. Kept as a regression guard on the real property:
    // the two tools' tokens must never be interchangeable.
    const underlying = rows(['live', 'parked']);
    const rosterEtag = computeRosterViewEtag(emit(underlying, 'full'), BASE_LENS);
    expect(rosterEtag).toMatch(/^[0-9a-f]{16}$/);

    const presenceEtag = computeRosterEtag(underlying as never, BASE_LENS.scope, BASE_LENS.potId);
    expect(rosterEtag).not.toBe(presenceEtag);
  });
});
