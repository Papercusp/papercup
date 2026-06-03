import { describe, expect, it } from 'vitest';
import {
  canClaimHarness,
  statsAggregateForStatus,
  type BindingStatus,
} from './binding-verifier-types';

describe('canClaimHarness', () => {
  it('verified can claim', () => {
    expect(canClaimHarness('verified')).toBe(true);
  });
  it('pending cannot claim', () => {
    expect(canClaimHarness('pending')).toBe(false);
  });
  it('unverified cannot claim', () => {
    expect(canClaimHarness('unverified')).toBe(false);
  });
});

describe('statsAggregateForStatus', () => {
  it('verified contributors aggregate into stats', () => {
    expect(statsAggregateForStatus('verified')).toBe(true);
  });
  it('pending contributors do NOT aggregate yet (deferred)', () => {
    expect(statsAggregateForStatus('pending')).toBe(false);
  });
  it('unverified contributors are excluded outright', () => {
    expect(statsAggregateForStatus('unverified')).toBe(false);
  });

  it('matches canClaimHarness exactly (both gates currently identical: verified-only)', () => {
    // Sentinel: addendum-1 + memo D-E both say verified-only. If a
    // future memo splits these (e.g. allow pending users to claim
    // with a warning), this test should fail to flag the divergence.
    const statuses: BindingStatus[] = ['verified', 'pending', 'unverified'];
    for (const s of statuses) {
      expect(canClaimHarness(s)).toBe(statsAggregateForStatus(s));
    }
  });
});
