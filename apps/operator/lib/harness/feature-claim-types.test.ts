import { describe, expect, it } from 'vitest';
import {
  CLAIM_OUTCOMES,
  FEATURE_CLAIM_SCHEMA_VERSION,
  activeClaimerGithubUserId,
  arbitrateClaims,
  composeClaimKey,
  findWinningClaim,
  isFeatureClaimRecord,
  isSameClaim,
  isStampedClaim,
  parseClaimKey,
  type FeatureClaimRecord,
} from './feature-claim-types';

function makeClaim(over: Partial<FeatureClaimRecord> = {}): FeatureClaimRecord {
  return {
    harness_slug: 'papercup',
    feature_id: 'F-001',
    seq: 1,
    claimer_pubkey: 'ed25519:abc',
    claimer_github_user_id: 12345,
    claimed_at: 1716_000_000_000,
    outcome: null,
    schema_version: 1,
    ...over,
  };
}

describe('CLAIM_OUTCOMES', () => {
  it('enumerates exactly won + lost (null is in-flight, not in the stamped enum)', () => {
    expect([...CLAIM_OUTCOMES]).toEqual(['won', 'lost']);
  });

  it('schema-version stays in lock-step with PG default', () => {
    expect(FEATURE_CLAIM_SCHEMA_VERSION).toBe(1);
  });
});

describe('isFeatureClaimRecord', () => {
  it('accepts a well-formed in-flight record', () => {
    expect(isFeatureClaimRecord(makeClaim())).toBe(true);
  });

  it('accepts a well-formed stamped record', () => {
    expect(isFeatureClaimRecord(makeClaim({ outcome: 'won' }))).toBe(true);
    expect(isFeatureClaimRecord(makeClaim({ outcome: 'lost' }))).toBe(true);
  });

  it('rejects unknown outcome string', () => {
    expect(isFeatureClaimRecord(makeClaim({ outcome: 'tied' as never }))).toBe(false);
  });

  it('rejects negative or non-integer seq', () => {
    expect(isFeatureClaimRecord(makeClaim({ seq: -1 }))).toBe(false);
    expect(isFeatureClaimRecord(makeClaim({ seq: 1.5 }))).toBe(false);
  });

  it('accepts seq=0 (Autobase sequences start at 0)', () => {
    expect(isFeatureClaimRecord(makeClaim({ seq: 0 }))).toBe(true);
  });

  it('rejects empty required strings', () => {
    expect(isFeatureClaimRecord(makeClaim({ harness_slug: '' }))).toBe(false);
    expect(isFeatureClaimRecord(makeClaim({ feature_id: '' }))).toBe(false);
    expect(isFeatureClaimRecord(makeClaim({ claimer_pubkey: '' }))).toBe(false);
  });

  it('rejects non-positive github_user_id', () => {
    expect(isFeatureClaimRecord(makeClaim({ claimer_github_user_id: 0 }))).toBe(false);
    expect(isFeatureClaimRecord(makeClaim({ claimer_github_user_id: -1 }))).toBe(false);
  });

  it('rejects non-finite claimed_at', () => {
    expect(isFeatureClaimRecord(makeClaim({ claimed_at: Number.NaN }))).toBe(false);
    expect(isFeatureClaimRecord(makeClaim({ claimed_at: Number.POSITIVE_INFINITY }))).toBe(false);
    expect(isFeatureClaimRecord(makeClaim({ claimed_at: 0 }))).toBe(false);
  });

  it('rejects wrong schema_version', () => {
    expect(isFeatureClaimRecord(makeClaim({ schema_version: 2 as 1 }))).toBe(false);
  });

  it('rejects non-object input', () => {
    expect(isFeatureClaimRecord(null)).toBe(false);
    expect(isFeatureClaimRecord(undefined)).toBe(false);
    expect(isFeatureClaimRecord('not an object')).toBe(false);
    expect(isFeatureClaimRecord(42)).toBe(false);
  });
});

describe('isStampedClaim', () => {
  it('discriminates stamped vs in-flight', () => {
    expect(isStampedClaim(makeClaim({ outcome: 'won' }))).toBe(true);
    expect(isStampedClaim(makeClaim({ outcome: 'lost' }))).toBe(true);
    expect(isStampedClaim(makeClaim({ outcome: null }))).toBe(false);
  });
});

describe('isSameClaim', () => {
  it('keys on (harness_slug, feature_id, seq)', () => {
    expect(
      isSameClaim(
        { harness_slug: 'x', feature_id: 'F-1', seq: 1 },
        { harness_slug: 'x', feature_id: 'F-1', seq: 1 },
      ),
    ).toBe(true);
  });

  it('returns false when any component differs', () => {
    const base = { harness_slug: 'x', feature_id: 'F-1', seq: 1 };
    expect(isSameClaim(base, { ...base, harness_slug: 'y' })).toBe(false);
    expect(isSameClaim(base, { ...base, feature_id: 'F-2' })).toBe(false);
    expect(isSameClaim(base, { ...base, seq: 2 })).toBe(false);
  });
});

describe('composeClaimKey / parseClaimKey round-trip', () => {
  it('round-trips a simple key', () => {
    const key = composeClaimKey({ harness_slug: 'papercup', feature_id: 'F-001', seq: 42 });
    expect(key).toBe('papercup:F-001:42');
    expect(parseClaimKey(key)).toEqual({
      harness_slug: 'papercup',
      feature_id: 'F-001',
      seq: 42,
    });
  });

  it('handles feature_id with colons (rare but theoretically allowed)', () => {
    const key = composeClaimKey({ harness_slug: 'x', feature_id: 'F-1:sub', seq: 0 });
    expect(parseClaimKey(key)).toEqual({ harness_slug: 'x', feature_id: 'F-1:sub', seq: 0 });
  });

  it('returns null for malformed keys', () => {
    expect(parseClaimKey('only-one-segment')).toBeNull();
    expect(parseClaimKey('two:segments')).toBeNull();
    expect(parseClaimKey('h:f:notanumber')).toBeNull();
    expect(parseClaimKey('h:f:-1')).toBeNull();
    expect(parseClaimKey('h:f:1.5')).toBeNull();
    expect(parseClaimKey('')).toBeNull();
    expect(parseClaimKey(':f:1')).toBeNull();
    expect(parseClaimKey('h::1')).toBeNull();
  });

  it('rejects non-string input', () => {
    // @ts-expect-error
    expect(parseClaimKey(null)).toBeNull();
    // @ts-expect-error
    expect(parseClaimKey(42)).toBeNull();
  });
});

describe('arbitrateClaims', () => {
  it('first claim wins, all others lose', () => {
    expect(
      arbitrateClaims([{ seq: 5 }, { seq: 7 }, { seq: 3 }]),
    ).toEqual([
      { seq: 5, outcome: 'won' },
      { seq: 7, outcome: 'lost' },
      { seq: 3, outcome: 'lost' },
    ]);
  });

  it('single claim wins', () => {
    expect(arbitrateClaims([{ seq: 1 }])).toEqual([{ seq: 1, outcome: 'won' }]);
  });

  it('empty input → empty output', () => {
    expect(arbitrateClaims([])).toEqual([]);
  });

  it('does not depend on seq numeric ordering (Autobase merge order is the input order)', () => {
    // If Autobase reports [seq=10, seq=2] as the merge order, seq=10 wins.
    expect(arbitrateClaims([{ seq: 10 }, { seq: 2 }])).toEqual([
      { seq: 10, outcome: 'won' },
      { seq: 2, outcome: 'lost' },
    ]);
  });
});

describe('findWinningClaim', () => {
  it('returns the won claim', () => {
    const claims = [
      makeClaim({ seq: 1, outcome: 'lost', claimer_github_user_id: 100 }),
      makeClaim({ seq: 2, outcome: 'won', claimer_github_user_id: 200 }),
    ];
    const winner = findWinningClaim(claims);
    expect(winner?.claimer_github_user_id).toBe(200);
  });

  it('returns null when no claim has outcome=won', () => {
    expect(findWinningClaim([makeClaim()])).toBeNull();
    expect(findWinningClaim([makeClaim({ outcome: 'lost' })])).toBeNull();
    expect(findWinningClaim([])).toBeNull();
  });

  it('returns the FIRST won claim if multiple appear (defensive idempotency)', () => {
    const claims = [
      makeClaim({ seq: 1, outcome: 'won', claimer_github_user_id: 100 }),
      makeClaim({ seq: 2, outcome: 'won', claimer_github_user_id: 200 }),
    ];
    const winner = findWinningClaim(claims);
    expect(winner?.claimer_github_user_id).toBe(100);
  });
});

describe('activeClaimerGithubUserId', () => {
  it('returns the winning user id', () => {
    const claims = [makeClaim({ outcome: 'won', claimer_github_user_id: 12345 })];
    expect(activeClaimerGithubUserId(claims)).toBe(12345);
  });

  it('returns null when no winner', () => {
    expect(activeClaimerGithubUserId([makeClaim()])).toBeNull();
    expect(activeClaimerGithubUserId([])).toBeNull();
  });
});
