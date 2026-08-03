/**
 * EI-19313376980892266 — the ONE ORACLE for claim concurrency.
 *
 * Before this, `maxConcurrentClaims` had four consumers and three behaviours:
 * `getNextWorkItem` enforced it, `get_next.ts`'s miss diagnosis enforced it via an
 * INDEPENDENT second copy of the rule, `fleet:leader-brief` never consulted it, and
 * `work_items:claim` had no check at all. Two copies of a rule that must agree will
 * eventually disagree; two surfaces that never consult it already did.
 *
 * These tests pin the shared DECISION. The point is not that `>=` works — it is that
 * there is exactly one place where that comparison is spelled, so a future edit cannot
 * change one surface's answer without changing every surface's answer.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MAX_CONCURRENT_CLAIMS,
  evaluateClaimConcurrency,
} from './claim-spec-store';

describe('evaluateClaimConcurrency — the shared verdict', () => {
  it('defaults to one held lane when the spec names no limit (EI-11796 fail-closed default)', () => {
    expect(DEFAULT_MAX_CONCURRENT_CLAIMS).toBe(1);
    const v = evaluateClaimConcurrency({ activeClaims: [{ id: 'WI-1' }] });
    expect(v).toMatchObject({ blocked: true, activeClaims: 1, maxConcurrentClaims: 1 });
  });

  it('is NOT blocked when the bee holds nothing', () => {
    const v = evaluateClaimConcurrency({ activeClaims: [] });
    expect(v.blocked).toBe(false);
    expect(v.activeClaims).toBe(0);
    expect(v.heldIds).toEqual([]);
  });

  it('honours a leader-authored limit above 1 rather than assuming the default', () => {
    // The false-suppression direction: with a hard-coded 1, a member holding one claim
    // under a concurrency-2 spec would be reported blocked and its genuine starvation
    // signal silenced.
    const v = evaluateClaimConcurrency({
      activeClaims: [{ id: 'WI-1' }],
      maxConcurrentClaims: 2,
    });
    expect(v.blocked).toBe(false);
    expect(v.maxConcurrentClaims).toBe(2);
  });

  it('blocks at the limit, not merely above it (>= is the scheduler semantic)', () => {
    const at = evaluateClaimConcurrency({
      activeClaims: [{ id: 'WI-1' }, { id: 'WI-2' }],
      maxConcurrentClaims: 2,
    });
    expect(at.blocked).toBe(true);
  });

  it('names the held ids so a refusal or alert can say exactly what to release', () => {
    const v = evaluateClaimConcurrency({ activeClaims: [{ id: 'WI-1' }, { id: 'WI-2' }] });
    expect(v.heldIds).toEqual(['WI-1', 'WI-2']);
  });

  it('accepts a bare count for callers that only have a number (heldIds then empty, never fabricated)', () => {
    const v = evaluateClaimConcurrency({ activeClaims: 3, maxConcurrentClaims: 2 });
    expect(v).toMatchObject({ blocked: true, activeClaims: 3, heldIds: [] });
  });

  it('treats a nullish limit as the default rather than as "unlimited"', () => {
    // Reading absent-as-unlimited would silently disable the cap everywhere at once.
    expect(evaluateClaimConcurrency({ activeClaims: [{ id: 'A' }], maxConcurrentClaims: null }).blocked).toBe(true);
    expect(evaluateClaimConcurrency({ activeClaims: [{ id: 'A' }], maxConcurrentClaims: undefined }).blocked).toBe(true);
  });
});
