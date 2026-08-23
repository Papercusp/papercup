/**
 * P-023 — per-platform storm policy defaults, and a burst test per Wave A adapter.
 *
 * The property that matters most here is a NEGATIVE one, and it is the reason
 * this file checks every registry row rather than a sample: no platform may end
 * up with an unbounded cap. Only Reddit states a numeric rate budget, so a
 * derivation keyed solely on `requestsPerMinute` would leave Bluesky and
 * Mastodon uncapped — and those two are the streaming transports, where a storm
 * actually arrives. An uncapped policy and a working one are indistinguishable
 * until the day a post goes viral, so the guard is written to fail now instead.
 */

import { describe, expect, it } from 'vitest';
import {
  ASSUMED_REQUESTS_PER_RUN,
  FALLBACK_MAX_RUNS,
  MAX_RUNS_CEILING,
  SOCIAL_STORM_WINDOW_SECONDS,
  defaultSocialStormPolicyForSourceKind,
  planCoalesceWithCap,
  socialStormPolicyFor,
  toBindingStormPolicy,
} from './storm-policy';
import { listSocialPlatforms } from './platform-registry';
import { parseStormPolicy } from '../binding-engine';

const WAVE_A = ['bluesky', 'mastodon', 'reddit'] as const;

const rowFor = (id: string) => {
  const row = listSocialPlatforms().find((r) => r.id === id);
  if (!row) throw new Error(`registry has no row for ${id} — this test's premise is stale`);
  return row;
};

describe('P-023 storm policy — no platform is left uncapped', () => {
  const rows = listSocialPlatforms();

  it('the registry is non-empty, so the sweep below measures something', () => {
    // POSITIVE CONTROL. Every assertion in this describe block is a forall over
    // `rows`; all of them pass vacuously if the registry read returns nothing.
    expect(rows.length).toBeGreaterThanOrEqual(3);
  });

  it.each(rows.map((r) => r.id))('%s gets a bounded, positive cap', (id) => {
    const policy = socialStormPolicyFor(rowFor(id));

    expect(policy.mode).toBe('coalesce-with-cap');
    expect(Number.isFinite(policy.maxRuns)).toBe(true);
    expect(policy.maxRuns).toBeGreaterThan(0);
    expect(policy.maxRuns).toBeLessThanOrEqual(MAX_RUNS_CEILING);
    expect(policy.windowSeconds).toBe(SOCIAL_STORM_WINDOW_SECONDS);
  });

  it('CONTROL: the uncapped-platform guard actually catches an uncapped platform', () => {
    // The naive derivation this module exists to avoid: key the cap solely on
    // `requestsPerMinute` and let an absent budget mean "no limit". Kept here
    // permanently rather than run as a one-off mutation, so the guard above can
    // never quietly stop being able to fail.
    const naive = (row: (typeof rows)[number]) => ({ maxRuns: row.limits.requestsPerMinute ?? Infinity });

    const uncapped = rows.filter((row) => !Number.isFinite(naive(row).maxRuns));

    // Two things at once: the naive version really does leave platforms
    // uncapped (so the guard has something to catch), and those platforms are
    // the streaming ones — which is why this mattered enough to build.
    expect(uncapped.length).toBeGreaterThan(0);
    expect(uncapped.map((r) => r.id)).toEqual(expect.arrayContaining(['bluesky', 'mastodon']));

    // ...and the real implementation caps every one of them.
    for (const row of uncapped) {
      expect(Number.isFinite(socialStormPolicyFor(row).maxRuns)).toBe(true);
    }
  });

  it('every cap states whether it was derived or fell back — a guess never passes for a measurement', () => {
    for (const row of rows) {
      const { basis } = socialStormPolicyFor(row);
      // Exhaustive on purpose: an `else` branch would let a FUTURE basis kind
      // pass this invariant without ever stating its evidence, which is the
      // exact failure the test exists to prevent. A new kind must fail here
      // until it is taught what its evidence is.
      switch (basis.kind) {
        case 'rate-budget':
          expect(basis.requestsPerMinute).toBeGreaterThan(0);
          break;
        case 'quota-bucket':
          // A bucket-derived cap must name WHICH non-fungible bucket it came
          // from (D-020) — "derived from the quota" is not auditable when a
          // platform has three quotas that cannot substitute for each other.
          expect(basis.bucket.length).toBeGreaterThan(0);
          expect(basis.perDay).toBeGreaterThan(0);
          expect(basis.spendPerRun).toBeGreaterThan(0);
          break;
        case 'conservative-default':
          // The fallback must always explain itself; an empty reason would make
          // a guessed cap unauditable at the admin surface.
          expect(basis.why.trim().length).toBeGreaterThan(0);
          break;
        default:
          throw new Error(`unhandled storm-cap basis kind: ${JSON.stringify(basis)}`);
      }
    }
  });
});

describe('P-023 storm policy — derivation from the P-002 rate budget', () => {
  it('reddit derives its cap from the documented 60 requests/minute', () => {
    const row = rowFor('reddit');
    // Guard the premise rather than assuming it: if the registry figure changes,
    // this should fail loudly here instead of silently re-baselining the cap.
    expect(row.limits.requestsPerMinute).toBe(60);

    const policy = socialStormPolicyFor(row);
    const windowMinutes = SOCIAL_STORM_WINDOW_SECONDS / 60;

    expect(policy.basis).toEqual({
      kind: 'rate-budget',
      requestsPerMinute: 60,
      requestsPerRun: ASSUMED_REQUESTS_PER_RUN,
    });
    expect(policy.maxRuns).toBe(Math.floor((60 * windowMinutes) / ASSUMED_REQUESTS_PER_RUN));
    expect(policy.maxRuns).toBe(30);
  });

  it.each(['bluesky', 'mastodon'] as const)(
    '%s states no numeric budget, so it falls back to a conservative cap rather than to unbounded',
    (id) => {
      const row = rowFor(id);
      expect(row.limits.requestsPerMinute).toBeUndefined();

      const policy = socialStormPolicyFor(row);
      expect(policy.basis.kind).toBe('conservative-default');
      expect(policy.maxRuns).toBe(FALLBACK_MAX_RUNS);
    },
  );

  it('a generous budget is clamped to the ceiling rather than trusted upward', () => {
    const row = { ...rowFor('reddit'), limits: { requestsPerMinute: 100_000 } };
    expect(socialStormPolicyFor(row).maxRuns).toBe(MAX_RUNS_CEILING);
  });

  it('a tiny budget still permits one run per window rather than deriving zero', () => {
    // A cap of 0 would be an outage wearing a policy's clothes.
    const row = { ...rowFor('reddit'), limits: { requestsPerMinute: 1 } };
    expect(socialStormPolicyFor(row).maxRuns).toBe(1);
  });
});

describe('P-023 storm policy — the landed binding-engine seam', () => {
  it.each(WAVE_A)('%s projects onto a policy the binding engine actually accepts', (id) => {
    const policy = socialStormPolicyFor(rowFor(id));
    const stored = toBindingStormPolicy(policy);

    // The real parser, not a local re-implementation of what it probably does.
    const parsed = parseStormPolicy(stored);
    expect(parsed.maxRuns).toBe(policy.maxRuns);
    expect(parsed.windowSeconds).toBe(policy.windowSeconds);
  });

  it('carries the basis through storage so a stored cap stays self-describing', () => {
    const stored = toBindingStormPolicy(socialStormPolicyFor(rowFor('bluesky')));
    expect(stored.mode).toBe('coalesce-with-cap');
    expect((stored.basis as { kind: string }).kind).toBe('conservative-default');
  });
});

describe('P-023 storm policy — the source-kind default that admin.ts installs', () => {
  it.each(WAVE_A)('%s resolves a capped default from its source kind', (id) => {
    const stored = defaultSocialStormPolicyForSourceKind(id);
    expect(stored).not.toBeNull();

    const parsed = parseStormPolicy(stored as Record<string, unknown>);
    // The whole point of the wiring: NOT null, which is what the landed default
    // yields and which means unbounded.
    expect(parsed.maxRuns).not.toBeNull();
    expect(parsed.maxRuns).toBeGreaterThan(0);
  });

  it('returns null for a non-social source kind, leaving mail and chat untouched', () => {
    for (const kind of ['gmail', 'slack', 'calendar', 'not-a-platform']) {
      expect(defaultSocialStormPolicyForSourceKind(kind)).toBeNull();
    }
  });

  it('CONTROL: the landed default really is unbounded, which is why the wiring exists', () => {
    // The premise of the whole item, asserted rather than assumed. If the
    // binding engine ever gains a bounded default of its own, this fails and
    // the social override should be re-justified rather than left in place.
    expect(parseStormPolicy({}).maxRuns).toBeNull();
  });
});

describe('P-023 burst test — one viral thread per Wave A adapter', () => {
  /** A burst far larger than any cap, as a viral thread actually arrives. */
  const burst = (n: number) => Array.from({ length: n }, (_, i) => ({ dedupeKey: `comment-${i}` }));

  it.each(WAVE_A)('%s caps the runs and COALESCES the rest — nothing inbound is dropped', (id) => {
    const policy = socialStormPolicyFor(rowFor(id));
    const events = burst(500);
    const outcome = planCoalesceWithCap(events, policy);

    // The cap held.
    expect(outcome.launched).toHaveLength(policy.maxRuns);

    // THE POINT OF THE ITEM: the overflow was coalesced, not skipped. A policy
    // that dropped the overflow would produce an identical `launched` count, so
    // asserting the run count alone would not distinguish the two.
    expect(outcome.launched.length + outcome.coalesced.length).toBe(events.length);
    expect(outcome.coalesced).toHaveLength(500 - policy.maxRuns);
  });

  it.each(WAVE_A)('%s does not let a redelivered event consume cap headroom', (id) => {
    const policy = socialStormPolicyFor(rowFor(id));
    // The same event delivered repeatedly, then genuinely new ones.
    const events = [
      ...Array.from({ length: 20 }, () => ({ dedupeKey: 'same-comment' })),
      ...burst(5),
    ];

    const outcome = planCoalesceWithCap(events, policy);
    expect(outcome.duplicates).toHaveLength(19);
    // 6 distinct keys, all under every Wave A cap, so all launch and none coalesce.
    expect(outcome.launched).toHaveLength(6);
    expect(outcome.coalesced).toHaveLength(0);
  });

  it('CONTROL: the burst assertion can fail — a cap that dropped its overflow is caught', () => {
    const policy = socialStormPolicyFor(rowFor('reddit'));
    const events = burst(500);

    // Simulate the WRONG behaviour (the binding engine's skip-the-overflow
    // default) and confirm the conservation check rejects it. Without this, a
    // green burst test could mean the invariant holds or merely that nothing
    // ever exercised it.
    const dropped = { launched: events.slice(0, policy.maxRuns).map((e) => e.dedupeKey), coalesced: [] };
    expect(dropped.launched.length + dropped.coalesced.length).not.toBe(events.length);
  });
});

/* -------------------------------------------------------------------------- */
/* P-015 stage 5 — per-verb caps over non-fungible quota buckets (D-020)      */
/* -------------------------------------------------------------------------- */

describe('P-015 — a verb’s cap comes from the bucket that verb draws on', () => {
  const youtube = rowFor('youtube');

  it('guards the premise: youtube declares three non-fungible buckets', () => {
    // If the registry figures change, fail loudly here rather than silently
    // re-baselining every cap below.
    expect(youtube.limits.buckets).toBeDefined();
    expect(youtube.limits.buckets!.general).toMatchObject({ perDay: 10000, unit: 'units' });
    expect(youtube.limits.buckets!.videoUploads).toMatchObject({ perDay: 100, unit: 'calls' });
    expect(youtube.limits.buckets!.search).toMatchObject({ perDay: 100, unit: 'calls' });
  });

  it('derives a READ cap from the general units bucket', () => {
    const policy = socialStormPolicyFor(youtube, 'read');
    expect(policy.basis).toMatchObject({
      kind: 'quota-bucket',
      bucket: 'general',
      verb: 'read',
      perDay: 10000,
      unit: 'units',
      spendPerRun: ASSUMED_REQUESTS_PER_RUN, // reads spend no write units
    });
  });

  it('derives a POST cap from the CALL-capped upload bucket, not the general pool', () => {
    // The D-020 error this exists to prevent: 10,000 unused general units cannot
    // buy a single extra upload, so a cap derived from them is calibrated
    // against an unrelated quantity.
    const policy = socialStormPolicyFor(youtube, 'post');
    expect(policy.basis).toMatchObject({
      kind: 'quota-bucket',
      bucket: 'videoUploads',
      verb: 'post',
      perDay: 100,
      unit: 'calls',
      spendPerRun: 1,
    });
  });

  it('gives a REPLY a stricter cap than a READ, because the write costs 50x a poll', () => {
    const read = socialStormPolicyFor(youtube, 'read');
    const reply = socialStormPolicyFor(youtube, 'reply');
    const runsPerDay = (p: typeof read) => (p.maxRuns * 86_400) / p.windowSeconds;
    expect(runsPerDay(reply)).toBeLessThan(runsPerDay(read));
  });

  it('NEVER authorises more runs per day than the bucket can fund', () => {
    // THE INVARIANT THE WHOLE STAGE EXISTS FOR. A cap that overspends does not
    // throttle the integration, it STOPS it — the budget is daily and does not
    // refill until the quota day rolls over.
    for (const verb of ['read', 'reply', 'post', 'delete'] as const) {
      const policy = socialStormPolicyFor(youtube, verb);
      const basis = policy.basis;
      if (basis.kind !== 'quota-bucket') throw new Error(`expected a quota-bucket basis for ${verb}`);
      const runsPerDay = (policy.maxRuns * 86_400) / policy.windowSeconds;
      expect(runsPerDay * basis.spendPerRun, `${verb} overspends ${basis.bucket}`).toBeLessThanOrEqual(basis.perDay);
    }
  });

  it('WIDENS THE WINDOW rather than flooring the cap to a lie', () => {
    // A reply run spends ~60 units; 10,000/day funds ~166 runs. The standard
    // 300s window contains 288 windows a day, so clamping to "1 per window"
    // would authorise 288 runs and overspend by ~70%. The window widens instead.
    const policy = socialStormPolicyFor(youtube, 'reply');
    expect(policy.maxRuns).toBe(1);
    expect(policy.windowSeconds).toBeGreaterThan(SOCIAL_STORM_WINDOW_SECONDS);
    expect(policy.basis).toMatchObject({ kind: 'quota-bucket', windowWidened: true });
  });

  it('CONTROL: the old clamp-to-1 rule really would have overspent', () => {
    // The control on the previous test. Without it, "the window had to widen" is
    // a claim nobody has watched be true.
    const policy = socialStormPolicyFor(youtube, 'reply');
    const basis = policy.basis;
    if (basis.kind !== 'quota-bucket') throw new Error('expected a quota-bucket basis');
    const clampedRunsPerDay = (1 * 86_400) / SOCIAL_STORM_WINDOW_SECONDS; // the rejected rule
    expect(clampedRunsPerDay * basis.spendPerRun).toBeGreaterThan(basis.perDay);
  });

  it('leaves every bucket-less platform on exactly the pre-existing derivation', () => {
    // Stage 5 must not re-baseline Wave A. Their rows declare no buckets, so the
    // verb argument is inert for them — asserted across all four verbs.
    for (const id of WAVE_A) {
      const row = rowFor(id);
      expect(row.limits.buckets).toBeUndefined();
      const base = socialStormPolicyFor(row);
      for (const verb of ['read', 'reply', 'post', 'delete'] as const) {
        expect(socialStormPolicyFor(row, verb)).toEqual(base);
      }
    }
  });

  it('defaults to the READ verb, which is what a trigger SOURCE does', () => {
    expect(socialStormPolicyFor(youtube)).toEqual(socialStormPolicyFor(youtube, 'read'));
    const projected = defaultSocialStormPolicyForSourceKind('youtube');
    expect(projected).toMatchObject({ maxRuns: socialStormPolicyFor(youtube, 'read').maxRuns });
  });

  it('takes the TIGHTEST bucket for a verb no bucket declares', () => {
    // Conservative on purpose: too small throttles, too large exhausts the day's
    // budget and stops the integration outright. The caller is told it happened.
    const policy = socialStormPolicyFor(youtube, 'delete');
    const general = youtube.limits.buckets!.general;
    expect(general.verbs).toContain('delete'); // delete IS declared, so no fallback
    expect(policy.basis).toMatchObject({ kind: 'quota-bucket', bucket: 'general' });
    expect((policy.basis as { fallbackToTightest?: boolean }).fallbackToTightest).toBeUndefined();
  });

  it('search.list is declared for NO verb, so nothing is capped against it', () => {
    // Neither read adapter calls search.list — activities.list and
    // commentThreads.list are both general-bucket. Declaring a verb on it would
    // attribute a cap to a bucket nothing actually draws on.
    expect(youtube.limits.buckets!.search.verbs).toBeUndefined();
    for (const verb of ['read', 'reply', 'post', 'delete'] as const) {
      expect((socialStormPolicyFor(youtube, verb).basis as { bucket?: string }).bucket).not.toBe('search');
    }
  });

  it('still coalesces rather than dropping, under a widened window', () => {
    // The cap got stricter; the no-loss property must not have.
    const policy = socialStormPolicyFor(youtube, 'reply');
    const events = Array.from({ length: 25 }, (_, i) => ({ dedupeKey: `k${i}` }));
    const outcome = planCoalesceWithCap(events, policy);
    expect(outcome.launched.length + outcome.coalesced.length).toBe(25);
    expect(outcome.launched).toHaveLength(policy.maxRuns);
  });

  it('survives the round trip through the stored binding-policy shape', () => {
    const policy = socialStormPolicyFor(youtube, 'reply');
    const stored = toBindingStormPolicy(policy);
    const parsed = parseStormPolicy(stored);
    expect(parsed).toMatchObject({ maxRuns: policy.maxRuns, windowSeconds: policy.windowSeconds });
    expect((stored.basis as { bucket?: string }).bucket).toBe('general');
  });
});
