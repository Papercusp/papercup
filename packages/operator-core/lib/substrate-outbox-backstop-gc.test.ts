import { describe, it, expect } from 'vitest';
import {
  backstopGcCutoffs,
  DRAINED_RETENTION_MS,
  ORPHAN_UNDRAINED_RETENTION_MS,
  EPHEMERAL_UNDRAINED_RETENTION_MS,
  EPHEMERAL_SLUG_PATTERNS,
  WILDCARD_UNDRAINED_RETENTION_MS,
} from './substrate-outbox-backstop-gc';

// Pure-logic unit tests for the retention cutoffs. The live DELETE behaviour over a
// real PG is covered by substrate-outbox-backstop-gc.integration.test.ts.
describe('backstopGcCutoffs', () => {
  const NOW = 1_800_000_000_000;

  it('derives the drained / undrained / ephemeral cutoffs from the clock', () => {
    const c = backstopGcCutoffs(NOW);
    expect(c.drainedBefore).toBe(NOW - DRAINED_RETENTION_MS);
    expect(c.undrainedBefore).toBe(NOW - ORPHAN_UNDRAINED_RETENTION_MS);
    expect(c.ephemeralUndrainedBefore).toBe(NOW - EPHEMERAL_UNDRAINED_RETENTION_MS);
    expect(c.wildcardUndrainedBefore).toBe(NOW - WILDCARD_UNDRAINED_RETENTION_MS);
    expect(c.ephemeralSlugPatterns).toEqual(EPHEMERAL_SLUG_PATTERNS);
  });

  it('reaps ephemeral debris far sooner than the 48h orphan TTL, yet far later than the ~1s drain', () => {
    // Known-dead-at-capture ⇒ a much tighter window than the generic orphan TTL...
    expect(EPHEMERAL_UNDRAINED_RETENTION_MS).toBeLessThan(ORPHAN_UNDRAINED_RETENTION_MS);
    // ...but still vastly longer than the ~1s drain cadence, so a real in-flight row is never dropped.
    expect(EPHEMERAL_UNDRAINED_RETENTION_MS).toBeGreaterThan(60_000);
    // The ephemeral cutoff timestamp is therefore MORE RECENT than the orphan cutoff.
    const c = backstopGcCutoffs(NOW);
    expect(c.ephemeralUndrainedBefore).toBeGreaterThan(c.undrainedBefore);
  });

  it('targets only the unambiguous one-shot contract-test pattern (not recurring routines)', () => {
    expect(EPHEMERAL_SLUG_PATTERNS).toContain('contract-test-%');
    // Recurring test routines (xbench xbq*, p016*, canary) DO boot + drain, so they must
    // NOT be matched — they fall to the normal 48h orphan TTL.
    expect(EPHEMERAL_SLUG_PATTERNS.some((p) => p.startsWith('xbq') || p.startsWith('p016') || p.includes('canary'))).toBe(
      false,
    );
  });

  it('reaps wildcard harness rows on a short TTL because no concrete drain can own them', () => {
    expect(WILDCARD_UNDRAINED_RETENTION_MS).toBeLessThan(EPHEMERAL_UNDRAINED_RETENTION_MS);
    expect(WILDCARD_UNDRAINED_RETENTION_MS).toBeGreaterThan(60_000);
    const c = backstopGcCutoffs(NOW);
    expect(c.wildcardUndrainedBefore).toBeGreaterThan(c.ephemeralUndrainedBefore);
  });
});
