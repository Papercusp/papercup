import { describe, expect, it } from 'vitest';

import {
  decideOrphanAuthorClose,
  lookupRemoteAuthorEndedAt,
  type EndedSessionLookupFn,
} from './work-items-orphan-author';

/**
 * EI-21919769900781478 — a remote-authored item whose authoring session has ENDED
 * could never reach a terminal state and kept being served as claimable work.
 *
 * These are the item's own stated positive controls. The middle one is the
 * safety-critical regression: opening the hatch too wide would let any node
 * terminal-write a row a LIVE peer still owns, which is the invariant the original
 * refusal exists to protect. It is asserted explicitly rather than assumed.
 */
describe('decideOrphanAuthorClose', () => {
  const ENDED_AT = '2026-08-11T19:05:23-04:00';

  it('permits a terminal close when the recorded author is provably ended', () => {
    expect(
      decideOrphanAuthorClose({
        origin: 'remote',
        isCompletingTransition: true,
        author: 'su-4a6e2255-f324-4774-a05e-c3bc87e643ac',
        authorSessionEndedAt: ENDED_AT,
      }),
    ).toEqual({ permit: true, reason: 'orphaned-author' });
  });

  it('SAFETY: still refuses when the remote author is LIVE (no ended_at observed)', () => {
    expect(
      decideOrphanAuthorClose({
        origin: 'remote',
        isCompletingTransition: true,
        author: 'su-live-peer',
        authorSessionEndedAt: null,
      }),
    ).toEqual({ permit: false, reason: 'author-not-ended' });
  });

  it('leaves a local-origin row untouched by this policy', () => {
    expect(
      decideOrphanAuthorClose({
        origin: 'local',
        isCompletingTransition: true,
        author: 'su-whoever',
        authorSessionEndedAt: ENDED_AT,
      }),
    ).toEqual({ permit: false, reason: 'not-remote' });
  });

  it('SCOPING: a dead author does NOT unlock non-terminal remote mutation', () => {
    // The escape hatch is for terminal closes only — it must never widen into a
    // general remote-mutation bypass just because the author happens to be gone.
    expect(
      decideOrphanAuthorClose({
        origin: 'remote',
        isCompletingTransition: false,
        author: 'su-dead-peer',
        authorSessionEndedAt: ENDED_AT,
      }),
    ).toEqual({ permit: false, reason: 'not-terminal' });
  });

  it('a row with no recorded author is not "provably orphaned"', () => {
    for (const author of [null, undefined, '']) {
      expect(
        decideOrphanAuthorClose({
          origin: 'remote',
          isCompletingTransition: true,
          author,
          authorSessionEndedAt: ENDED_AT,
        }),
      ).toEqual({ permit: false, reason: 'no-recorded-author' });
    }
  });
});

describe('lookupRemoteAuthorEndedAt', () => {
  it('returns the ended_at stamp when the lookup reports the session ended', async () => {
    const lookup: EndedSessionLookupFn = async () => new Map([['su-dead', '2026-08-11T19:05:23-04:00']]);
    expect(await lookupRemoteAuthorEndedAt('su-dead', null, lookup)).toBe('2026-08-11T19:05:23-04:00');
  });

  it('returns null for an author the lookup does not report as ended', async () => {
    const lookup: EndedSessionLookupFn = async () => new Map();
    expect(await lookupRemoteAuthorEndedAt('su-live', null, lookup)).toBeNull();
  });

  it('FAIL-CLOSED: a throwing lookup reads as "not provably ended", never as ended', async () => {
    // The refusal must survive a liveness-lookup outage. If this ever returned a
    // truthy value on error, an outage would silently unlock terminal writes on
    // every remote-authored row in the tree.
    const lookup: EndedSessionLookupFn = async () => {
      throw new Error('adv_sessions unavailable');
    };
    expect(await lookupRemoteAuthorEndedAt('su-unknown', null, lookup)).toBeNull();
  });

  it('FAIL-CLOSED: an absent author short-circuits without consulting the lookup', async () => {
    let called = false;
    const lookup: EndedSessionLookupFn = async () => {
      called = true;
      return new Map([['', 'x']]);
    };
    expect(await lookupRemoteAuthorEndedAt(null, null, lookup)).toBeNull();
    expect(called).toBe(false);
  });
});
