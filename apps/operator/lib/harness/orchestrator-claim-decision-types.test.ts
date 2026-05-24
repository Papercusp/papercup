import { describe, expect, it } from 'vitest';
import {
  AUTOBASE_MERGE_CONVERGENCE_HEALTHY_MS,
  AUTOBASE_MERGE_CONVERGENCE_TIMEOUT_MS,
  CLAIM_AWAIT_POLL_INTERVAL_MS,
  CLAIM_LOSS_COOLDOWN_MS,
  auditOutcomeFromDecision,
  decideClaimResolution,
  decideShouldAttemptClaim,
  isClaimable,
  isMeshConvergenceTimeout,
  pickNextClaimableFeature,
} from './orchestrator-claim-decision-types';
import type { FeatureClaimRecord } from './feature-claim-types';

function makeClaim(over: Partial<FeatureClaimRecord> = {}): FeatureClaimRecord {
  return {
    harness_slug: 'papercup',
    feature_id: 'F-001',
    seq: 1,
    claimer_pubkey: 'ed25519:A',
    claimer_github_user_id: 100,
    claimed_at: 1716_000_000_000,
    outcome: null,
    schema_version: 1,
    ...over,
  };
}

describe('constants', () => {
  it('CLAIM_LOSS_COOLDOWN_MS is 5s', () => {
    expect(CLAIM_LOSS_COOLDOWN_MS).toBe(5_000);
  });

  it('CLAIM_AWAIT_POLL_INTERVAL_MS is 100ms (sub-200ms healthy mesh latency)', () => {
    expect(CLAIM_AWAIT_POLL_INTERVAL_MS).toBe(100);
  });

  it('AUTOBASE_MERGE_CONVERGENCE_HEALTHY_MS is 200ms per §0.6', () => {
    expect(AUTOBASE_MERGE_CONVERGENCE_HEALTHY_MS).toBe(200);
  });

  it('AUTOBASE_MERGE_CONVERGENCE_TIMEOUT_MS is 5s (mesh-unhealthy escalation)', () => {
    expect(AUTOBASE_MERGE_CONVERGENCE_TIMEOUT_MS).toBe(5_000);
  });
});

describe('decideShouldAttemptClaim', () => {
  it('attempt when in_queue + empty working_users + no blockers', () => {
    expect(
      decideShouldAttemptClaim({
        feature_state: 'in_queue',
        working_users: [],
        blocker_feature_ids: [],
      }),
    ).toEqual({ kind: 'attempt' });
  });

  it('skip_wrong_state for non-in_queue states', () => {
    for (const s of ['backlog', 'working', 'pending_done', 'shipped'] as const) {
      const r = decideShouldAttemptClaim({
        feature_state: s,
        working_users: [],
        blocker_feature_ids: [],
      });
      expect(r.kind).toBe('skip_wrong_state');
      if (r.kind === 'skip_wrong_state') expect(r.state).toBe(s);
    }
  });

  it('skip_already_working when working_users non-empty', () => {
    const r = decideShouldAttemptClaim({
      feature_state: 'in_queue',
      working_users: [100, 200],
      blocker_feature_ids: [],
    });
    expect(r.kind).toBe('skip_already_working');
    if (r.kind === 'skip_already_working') {
      expect(r.working_users).toEqual([100, 200]);
    }
  });

  it('skip_blocked when blockers exist', () => {
    const r = decideShouldAttemptClaim({
      feature_state: 'in_queue',
      working_users: [],
      blocker_feature_ids: ['F-blocker'],
    });
    expect(r.kind).toBe('skip_blocked');
    if (r.kind === 'skip_blocked') {
      expect(r.blocker_feature_ids).toEqual(['F-blocker']);
    }
  });
});

describe('decideClaimResolution', () => {
  it('await when no in-flight claims', () => {
    expect(
      decideClaimResolution({ inflight_by_merge_order: [], my_pubkey: 'ed25519:A' }),
    ).toEqual({ kind: 'await' });
  });

  it('dispatch when my claim is first in merge order', () => {
    const r = decideClaimResolution({
      inflight_by_merge_order: [
        makeClaim({ claimer_pubkey: 'ed25519:A', seq: 1 }),
        makeClaim({ claimer_pubkey: 'ed25519:B', seq: 2 }),
      ],
      my_pubkey: 'ed25519:A',
    });
    expect(r.kind).toBe('dispatch');
    if (r.kind === 'dispatch') {
      expect(r.winning_claim.claimer_pubkey).toBe('ed25519:A');
    }
  });

  it('stand_down when another claim is first', () => {
    const r = decideClaimResolution({
      inflight_by_merge_order: [
        makeClaim({ claimer_pubkey: 'ed25519:B', seq: 7 }),
        makeClaim({ claimer_pubkey: 'ed25519:A', seq: 1 }),
      ],
      my_pubkey: 'ed25519:A',
    });
    expect(r.kind).toBe('stand_down');
    if (r.kind === 'stand_down') {
      expect(r.winner_pubkey).toBe('ed25519:B');
      expect(r.winner_seq).toBe(7);
    }
  });

  it('single-claim case: dispatch for my own claim', () => {
    const r = decideClaimResolution({
      inflight_by_merge_order: [makeClaim({ claimer_pubkey: 'ed25519:A' })],
      my_pubkey: 'ed25519:A',
    });
    expect(r.kind).toBe('dispatch');
  });

  it("single-claim case: stand_down when it's not mine", () => {
    const r = decideClaimResolution({
      inflight_by_merge_order: [makeClaim({ claimer_pubkey: 'ed25519:OTHER' })],
      my_pubkey: 'ed25519:A',
    });
    expect(r.kind).toBe('stand_down');
  });
});

describe('isMeshConvergenceTimeout', () => {
  const NOW = 1716_000_005_001;

  it('true when claim is older than 5s', () => {
    expect(isMeshConvergenceTimeout({ claimed_at: NOW - 5_001, now: NOW })).toBe(true);
  });

  it('false when claim is within 5s', () => {
    expect(isMeshConvergenceTimeout({ claimed_at: NOW - 1_000, now: NOW })).toBe(false);
  });

  it('boundary: exactly 5s is NOT timeout (strict greater-than)', () => {
    expect(
      isMeshConvergenceTimeout({
        claimed_at: NOW - AUTOBASE_MERGE_CONVERGENCE_TIMEOUT_MS,
        now: NOW,
      }),
    ).toBe(false);
  });
});

describe('pickNextClaimableFeature', () => {
  it('returns first in_queue feature in the list', () => {
    expect(
      pickNextClaimableFeature([
        { feature_id: 'F-1', state: 'working' },
        { feature_id: 'F-2', state: 'in_queue' },
        { feature_id: 'F-3', state: 'in_queue' },
      ]),
    ).toBe('F-2');
  });

  it('returns null when nothing in_queue', () => {
    expect(
      pickNextClaimableFeature([
        { feature_id: 'F-1', state: 'working' },
        { feature_id: 'F-2', state: 'shipped' },
      ]),
    ).toBeNull();
  });

  it('returns null for empty list', () => {
    expect(pickNextClaimableFeature([])).toBeNull();
  });
});

describe('isClaimable', () => {
  it('true only for in_queue', () => {
    expect(isClaimable('in_queue')).toBe(true);
    for (const s of ['backlog', 'working', 'pending_done', 'shipped'] as const) {
      expect(isClaimable(s)).toBe(false);
    }
  });
});

describe('auditOutcomeFromDecision', () => {
  it('dispatch → won', () => {
    expect(
      auditOutcomeFromDecision({ kind: 'dispatch', winning_claim: makeClaim() }),
    ).toBe('won');
  });

  it('stand_down → lost', () => {
    expect(
      auditOutcomeFromDecision({ kind: 'stand_down', winner_pubkey: 'X', winner_seq: 1 }),
    ).toBe('lost');
  });

  it('await → error', () => {
    expect(auditOutcomeFromDecision({ kind: 'await' })).toBe('error');
  });
});
