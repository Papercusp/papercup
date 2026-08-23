import { describe, expect, it } from 'vitest';
import {
  assertSocialPlatformUsable,
  getSocialPlatform,
  isSocialPlatformVerified,
  listSocialPlatforms,
  listSocialPlatformsByWave,
  SOCIAL_REPLAY_STRENGTH,
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

  /**
   * Rows that declare a readable stream.
   *
   * `read` became nullable in P-021 for LinkedIn, whose content is unreachable
   * at every grant tier we hold. The read invariants below genuinely do not
   * apply to such a row — but narrowing them by filtering is only safe while
   * something ELSE pins the excluded population, or a future row could opt out
   * of every read invariant just by setting `read: null`. The test immediately
   * following does that pinning, and is the reason this filter is not a hole.
   */
  const readableRows = rows.filter(
    (row): row is SocialPlatformRow & { read: NonNullable<SocialPlatformRow['read']> } => row.read !== null,
  );

  /**
   * Read a row's stream spec in a test that already knows the row is readable.
   *
   * Preferred over a `!` assertion: if one of these platforms ever became
   * write-only, `!` would fail with a bare "cannot read property of null" from
   * whichever line got there first, whereas this names the row and the
   * expectation that broke.
   */
  function readOf(row: SocialPlatformRow): NonNullable<SocialPlatformRow['read']> {
    expect(row.read, `${row.id} is expected to declare a readable stream`).not.toBeNull();
    return row.read as NonNullable<SocialPlatformRow['read']>;
  }

  it('admits a write-only row ONLY when it also declares no read scopes and says why', () => {
    // The guard that makes `readableRows` safe to filter on. A `read: null` is
    // a strong claim — "this platform cannot be read by us at all" — and it
    // must not be reachable by accident, because every read invariant below
    // stops applying to a row that makes it.
    const writeOnly = rows.filter((row) => row.read === null);

    // Pin the population rather than the mere shape. If a second platform ever
    // becomes write-only that is a real finding worth a deliberate edit here,
    // not something to absorb silently.
    expect(writeOnly.map((row) => row.id)).toEqual(['linkedin']);

    for (const row of writeOnly) {
      // A row that cannot be read must not claim a read-shaped scope. This is
      // the assertion that would have caught the tempting wrong version of the
      // LinkedIn row: requesting r_member_social "just in case" while declaring
      // no read path is either a phantom scope (D-034) or an unimplemented read.
      for (const scope of row.auth.scopes) {
        expect(scope.startsWith('r_'), `${row.id} declares read scope '${scope}' but no readable stream`).toBe(false);
      }
      // …and it must explain itself somewhere a reader will look.
      //
      // NOT via `blockedOn`, which was the obvious choice and is a trap:
      // `assertSocialPlatformUsable` THROWS on any row carrying one, so using
      // it to describe a PARTIAL wall would make the platform's working verbs
      // unreachable at runtime while every unit test still passed. A write-only
      // row explains itself in `policyNotes` instead.
      expect(row.policyNotes ?? '', `${row.id} is write-only but explains nothing`).not.toBe('');
    }
  });

  it('keeps a usable write-only row OUT of the blockedOn gate', () => {
    // The regression guard for the trap named above. LinkedIn's post path is
    // self-serve and verified, so the platform must actually resolve — if a
    // future edit describes its read wall in `blockedOn`, this fails instead of
    // silently disabling a working adapter.
    const linkedin = assertSocialPlatformUsable('linkedin');
    expect(linkedin.id).toBe('linkedin');
    expect(linkedin.blockedOn).toBeUndefined();
  });

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
    for (const row of readableRows) {
      expect(outboundOnly.has(row.read.transport), `${row.id} declares a non-outbound transport`).toBe(true);
    }
  });

  it('keeps transport and replay class coherent', () => {
    for (const row of readableRows) {
      if (row.read.transport === 'poll-cursor') {
        // Polling admits exactly two gap behaviours, and the difference is the
        // whole of D-021. Either the provider accepts a time filter, so reading
        // IS the cursored poll — or it accepts none, and the only recovery is to
        // re-read and stop client-side at a watermark. A third value here would
        // mean a stream class nobody measured.
        expect(['poll-cursor', 'watermark-rescan'], `${row.id}`).toContain(row.read.replay);
      } else {
        // A streaming platform's gap behaviour must be one of the two measured
        // stream classes — never silently reclassified as a poll.
        expect(['bounded-cursor-window', 'no-replay-rest-backfill'], `${row.id}`).toContain(row.read.replay);
      }
    }
  });

  it('never lets a scalar read overstate the streams it summarizes', () => {
    // THE invariant that makes per-stream detail safe to ignore (D-022). A row
    // with differing streams reports the WEAKEST of them in its scalar — the
    // same convention D-016 fixed for write idempotency — so a consumer that
    // never looks at `streams` is left CONSERVATIVE rather than wrong. Overstating
    // is the failure that matters: it would promise a replay guarantee the
    // weakest stream cannot deliver, and the loss would be silent.
    const withStreams = readableRows.filter((row) => row.read.streams);
    expect(withStreams.length, 'expected at least one row declaring per-stream reads').toBeGreaterThan(0);

    for (const row of withStreams) {
      const specs = Object.entries(row.read.streams ?? {});
      expect(specs.length, `${row.id} declares an empty streams map`).toBeGreaterThan(0);

      const weakest = Math.min(...specs.map(([, spec]) => SOCIAL_REPLAY_STRENGTH[spec.replay]));
      expect(
        SOCIAL_REPLAY_STRENGTH[row.read.replay],
        `${row.id} scalar replay '${row.read.replay}' overstates its weakest stream`,
      ).toBe(weakest);

      // A stream may not claim a transport the row itself does not.
      for (const [name, spec] of specs) {
        expect(spec.transport, `${row.id}.${name} transport`).toBe(row.read.transport);
      }
    }
  });

  it('ranks every replay class exactly once, so the weakest-stream rule is total', () => {
    // The strength map is the derived basis for the check above. If a future
    // class is added to the union and NOT ranked here, the lookup returns
    // undefined and every comparison silently becomes NaN — a guard that
    // passes because it stopped measuring. Pin the population instead.
    for (const row of readableRows) {
      expect(SOCIAL_REPLAY_STRENGTH[row.read.replay], `${row.id} scalar replay is unranked`).toBeTypeOf('number');
      for (const spec of Object.values(row.read.streams ?? {})) {
        expect(SOCIAL_REPLAY_STRENGTH[spec.replay], `${row.id} stream replay is unranked`).toBeTypeOf('number');
      }
    }
    const ranks = Object.values(SOCIAL_REPLAY_STRENGTH);
    expect(new Set(ranks).size, 'two replay classes share a rank, so "weakest" is ambiguous').toBe(ranks.length);
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
      // This check was a conditional no-op until P-015: no row was both verified
      // and owner-blocked, so the body never ran and the guard proved nothing.
      // YouTube is now exactly that combination — vendor-verified (D-020/D-021)
      // but waiting on the owner's incremental consent — so the population is
      // asserted non-empty rather than silently skipped. That is the D-012
      // lesson applied in reverse: verifying a platform can retire a guard's only
      // subject, so a guard whose subject set can empty must say so out loud.
      const verifiedButBlocked = rows.filter((r) => isSocialPlatformVerified(r) && r.blockedOn);
      expect(
        verifiedButBlocked.length,
        'expected at least one verified-but-owner-blocked row to exercise this refusal',
      ).toBeGreaterThan(0);

      for (const row of verifiedButBlocked) {
        try {
          assertSocialPlatformUsable(row.id);
          throw new Error(`expected assertSocialPlatformUsable to throw for ${row.id}`);
        } catch (error) {
          expect((error as SocialPlatformUnusableError).reason, `${row.id}`).toBe('owner-blocked');
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
    expect(readOf(bluesky).transport).toBe('outbound-websocket');
    expect(readOf(bluesky).replay).toBe('bounded-cursor-window');

    const mastodon = assertSocialPlatformUsable('mastodon');
    expect(readOf(mastodon).replay).toBe('no-replay-rest-backfill');
    // The Idempotency-Key header is the only thing standing between a retry and
    // a duplicate public post on Mastodon.
    expect(mastodon.write.idempotency).toBe('header');

    const reddit = assertSocialPlatformUsable('reddit');
    expect(reddit.limits.requestsPerMinute).toBe(60);
    expect(readOf(reddit).transport).toBe('poll-cursor');
  });

  it('records the YouTube facts P-015 actually verified against the vendor docs', () => {
    // Pinned for the same reason as the Wave A facts above: each of these was
    // read off a live vendor page in D-020/D-021, and each CONTRADICTS a
    // plausible assumption someone would otherwise restore while tidying.
    // Fetched by id rather than assertSocialPlatformUsable, which correctly
    // refuses this row while the owner consent upgrade is outstanding.
    const youtube = getSocialPlatform('youtube') as SocialPlatformRow;
    expect(youtube.verifiedAt).toBe('2026-08-23');

    // D-021: the two streams do NOT share a replay guarantee, and the scalar
    // reports the weaker one so it cannot overstate.
    expect(readOf(youtube).streams?.activities.replay).toBe('poll-cursor');
    expect(readOf(youtube).streams?.comments.replay).toBe('watermark-rescan');
    expect(readOf(youtube).replay).toBe('watermark-rescan');

    // D-020: three non-fungible budgets. The upload ceiling counts CALLS, not
    // units — the correction that matters, since the endpoint costs 1 unit and
    // the widely-repeated 1600-unit figure is stale.
    expect(youtube.limits.buckets?.videoUploads.perDay).toBe(100);
    expect(youtube.limits.buckets?.videoUploads.unit).toBe('calls');
    expect(youtube.limits.buckets?.search.perDay).toBe(100);
    expect(youtube.limits.buckets?.general.unit).toBe('units');

    // comments.insert offers no idempotency mechanism, so the duplicate guard is
    // entirely ours; and `post` stays undeclared because videos.insert had its
    // quota verified but not its write shape.
    expect(youtube.write.idempotency).toBe('none');
    expect(youtube.write.verbs).toEqual(['reply']);

    // D-019: force-ssl is requested per-capability. A regression that moves it
    // into the default Workspace list would make every legacy connection report
    // YouTube as granted without the user ever consenting.
    expect(youtube.auth.scopes).toContain('https://www.googleapis.com/auth/youtube.force-ssl');
  });
});
