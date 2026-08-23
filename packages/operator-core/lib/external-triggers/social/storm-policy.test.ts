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
      if (basis.kind === 'rate-budget') {
        expect(basis.requestsPerMinute).toBeGreaterThan(0);
      } else {
        // The fallback must always explain itself; an empty reason would make a
        // guessed cap unauditable at the admin surface.
        expect(basis.why.trim().length).toBeGreaterThan(0);
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
