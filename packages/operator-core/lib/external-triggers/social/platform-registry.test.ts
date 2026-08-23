import { describe, expect, it } from 'vitest';
import {
  assertSocialPlatformUsable,
  getSocialPlatform,
  isSocialPlatformVerified,
  listSocialPlatforms,
  listSocialPlatformsByWave,
  SocialPlatformUnusableError,
  type SocialPlatformRow,
} from './platform-registry';

/**
 * These are the invariants that keep the registry honest. Several of them are
 * ALSO enforced by the type system today — and that is exactly why they are
 * asserted behaviourally here. A type-level guarantee disappears the moment
 * someone widens a union to accommodate an awkward platform, and the widening
 * looks locally reasonable at the time. The test is what makes that widening
 * fail loudly instead of silently dissolving a governing decision.
 */
describe('social platform registry', () => {
  const rows = listSocialPlatforms();

  it('exposes a non-empty registry whose keys match their row ids', () => {
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(getSocialPlatform(row.id)).toBe(row);
    }
  });

  it('declares no inbound-webhook read transport — D-003 offline doctrine', () => {
    // Papercusp is a desktop app behind NAT with no public ingress, so a
    // platform that can only be read by webhook cannot be expressed here at
    // all. If a future row needs one, the fix is to reopen D-003 (and the Svix
    // ingest question it defers to), not to widen the transport union.
    const outboundOnly = new Set(['outbound-websocket', 'poll-cursor']);
    for (const row of rows) {
      expect(outboundOnly.has(row.read.transport), `${row.id} declares a non-outbound transport`).toBe(true);
    }
  });

  it('keeps transport and replay class coherent', () => {
    for (const row of rows) {
      if (row.read.transport === 'poll-cursor') {
        // There is no stream to miss events on: reading IS the cursored poll.
        expect(row.read.replay, `${row.id}`).toBe('poll-cursor');
      } else {
        // A streaming platform's gap behaviour must be one of the two measured
        // stream classes — never silently reclassified as a poll.
        expect(['bounded-cursor-window', 'no-replay-rest-backfill'], `${row.id}`).toContain(row.read.replay);
      }
    }
  });

  it('requires a verified row to cite dated https sources', () => {
    for (const row of rows.filter(isSocialPlatformVerified)) {
      expect(row.verifiedAt, `${row.id} verifiedAt`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(row.sources.length, `${row.id} sources`).toBeGreaterThan(0);
      for (const source of row.sources) {
        expect(source.startsWith('https://'), `${row.id} source ${source}`).toBe(true);
      }
    }
  });

  it('never leaves a row unverified without saying what it is waiting on', () => {
    // An unverified row is allowed (verification is just-in-time per wave,
    // D-005) but an unverified row with no stated blocker is indistinguishable
    // from one somebody forgot.
    for (const row of rows.filter((r) => !isSocialPlatformVerified(r))) {
      expect(row.blockedOn, `${row.id} is unverified but names no blocker`).toBeTruthy();
    }
  });

  it('documents the double-post hazard wherever a write path lacks native idempotency', () => {
    // A retried write without a native idempotency mechanism posts twice, and a
    // duplicate public post is not correctable the way a duplicate email is. A
    // row in that position has to say so, so the adapter author cannot miss it.
    //
    // Scoped to VERIFIED rows on purpose. An unverified row's write facts are
    // placeholders that no wave has checked yet, and assertSocialPlatformUsable
    // refuses it outright — so it cannot reach a write path to double-post
    // from. The obligation attaches exactly when verification fills the facts
    // in and the row becomes usable, which is when an adapter author reads it.
    const publishing = rows.filter((r) => isSocialPlatformVerified(r) && r.write.verbs.includes('post'));
    expect(publishing.length).toBeGreaterThan(0);
    for (const row of publishing) {
      if (row.write.idempotency !== 'header') {
        expect(row.write.notes, `${row.id} has no native idempotency and no note explaining it`).toBeTruthy();
      }
    }
  });

  it('has every Wave A platform verified — Wave A is what gets built first', () => {
    const waveA = listSocialPlatformsByWave('A');
    expect(waveA.length).toBeGreaterThan(0);
    for (const row of waveA) {
      expect(isSocialPlatformVerified(row), `${row.id} is Wave A but unverified`).toBe(true);
    }
  });

  describe('assertSocialPlatformUsable', () => {
    it('refuses an unknown platform', () => {
      expect(() => assertSocialPlatformUsable('friendster')).toThrow(SocialPlatformUnusableError);
      try {
        assertSocialPlatformUsable('friendster');
      } catch (error) {
        expect((error as SocialPlatformUnusableError).reason).toBe('unknown-platform');
      }
    });

    it('refuses an unverified platform rather than treating it as permissive (D-005)', () => {
      const unverified = rows.find((r) => !isSocialPlatformVerified(r));
      expect(unverified, 'expected at least one unverified row to exercise this path').toBeTruthy();
      try {
        assertSocialPlatformUsable((unverified as SocialPlatformRow).id);
        throw new Error('expected assertSocialPlatformUsable to throw');
      } catch (error) {
        expect(error).toBeInstanceOf(SocialPlatformUnusableError);
        // 'unverified' is checked BEFORE 'owner-blocked' deliberately: an
        // unchecked row's blocker text is itself unverified.
        expect((error as SocialPlatformUnusableError).reason).toBe('unverified');
      }
    });

    it('refuses a verified platform that is still owner-blocked', () => {
      // Constructed rather than drawn from the registry: today no row is both
      // verified and owner-blocked, but that combination is reachable the
      // moment Wave B verification runs while Meta review is outstanding, and
      // it must refuse rather than proceed.
      const verifiedButBlocked = rows.find((r) => isSocialPlatformVerified(r) && r.blockedOn);
      if (verifiedButBlocked) {
        try {
          assertSocialPlatformUsable(verifiedButBlocked.id);
          throw new Error('expected assertSocialPlatformUsable to throw');
        } catch (error) {
          expect((error as SocialPlatformUnusableError).reason).toBe('owner-blocked');
        }
      }
    });

    it('returns the row for a usable platform', () => {
      const usable = rows.find((r) => isSocialPlatformVerified(r) && !r.blockedOn);
      expect(usable, 'expected at least one usable platform').toBeTruthy();
      const resolved = assertSocialPlatformUsable((usable as SocialPlatformRow).id);
      expect(resolved.id).toBe((usable as SocialPlatformRow).id);
    });
  });

  it('records the Wave A facts P-001 actually verified', () => {
    // Pins the specific measured facts so a later edit that "tidies" them has
    // to consciously contradict the cited sources in D-005.
    const bluesky = assertSocialPlatformUsable('bluesky');
    expect(bluesky.read.transport).toBe('outbound-websocket');
    expect(bluesky.read.replay).toBe('bounded-cursor-window');

    const mastodon = assertSocialPlatformUsable('mastodon');
    expect(mastodon.read.replay).toBe('no-replay-rest-backfill');
    // The Idempotency-Key header is the only thing standing between a retry and
    // a duplicate public post on Mastodon.
    expect(mastodon.write.idempotency).toBe('header');

    const reddit = assertSocialPlatformUsable('reddit');
    expect(reddit.limits.requestsPerMinute).toBe(60);
    expect(reddit.read.transport).toBe('poll-cursor');
  });
});
