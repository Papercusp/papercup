import { describe, expect, it } from 'vitest';
import {
  PENDING_GRACE_WINDOW_MAX_MS,
  PENDING_GRACE_WINDOW_MS,
  canClaimHarness,
  clampGraceWindowMs,
  deriveBindingStatus,
  statsAggregateForStatus,
  type BindingStatus,
  type ChannelResult,
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

describe('clampGraceWindowMs', () => {
  it('returns the value when within range', () => {
    expect(clampGraceWindowMs(1000)).toBe(1000);
    expect(clampGraceWindowMs(PENDING_GRACE_WINDOW_MS)).toBe(PENDING_GRACE_WINDOW_MS);
  });
  it('clamps above max to max (1-week per memo Q-2)', () => {
    expect(clampGraceWindowMs(PENDING_GRACE_WINDOW_MAX_MS + 1)).toBe(PENDING_GRACE_WINDOW_MAX_MS);
    expect(clampGraceWindowMs(365 * 24 * 60 * 60 * 1000)).toBe(PENDING_GRACE_WINDOW_MAX_MS);
  });
  it('falls back to default on negative input', () => {
    expect(clampGraceWindowMs(-1)).toBe(PENDING_GRACE_WINDOW_MS);
    expect(clampGraceWindowMs(-1_000_000)).toBe(PENDING_GRACE_WINDOW_MS);
  });
  it('falls back to default on NaN / Infinity', () => {
    expect(clampGraceWindowMs(Number.NaN)).toBe(PENDING_GRACE_WINDOW_MS);
    expect(clampGraceWindowMs(Number.POSITIVE_INFINITY)).toBe(PENDING_GRACE_WINDOW_MS);
  });
  it('accepts 0 as a valid (immediate-flip) window', () => {
    expect(clampGraceWindowMs(0)).toBe(0);
  });
});

describe('deriveBindingStatus', () => {
  const ok: ChannelResult = { kind: 'ok' };
  const pending: ChannelResult = { kind: 'pending', reason: 'just_joined_channel2_propagating' };
  const fail: ChannelResult = { kind: 'fail', reason: 'unknown' };

  it('both channels ok → verified', () => {
    expect(deriveBindingStatus({ channel1: ok, channel2: ok })).toBe('verified');
  });

  it('channel 1 fail → unverified', () => {
    expect(deriveBindingStatus({ channel1: fail, channel2: ok })).toBe('unverified');
    expect(deriveBindingStatus({ channel1: fail, channel2: fail })).toBe('unverified');
    expect(deriveBindingStatus({ channel1: fail, channel2: pending })).toBe('unverified');
  });

  it('channel 1 ok + channel 2 fail → unverified', () => {
    expect(deriveBindingStatus({ channel1: ok, channel2: fail })).toBe('unverified');
  });

  it('channel 1 ok + channel 2 pending, within grace → pending', () => {
    const now = 1_700_000_000_000;
    expect(
      deriveBindingStatus({
        channel1: ok,
        channel2: pending,
        channel2PendingSince: now - 1000, // 1s ago, well within 24h grace
        nowMs: now,
      }),
    ).toBe('pending');
  });

  it('channel 1 ok + channel 2 pending, past grace → unverified', () => {
    const now = 1_700_000_000_000;
    expect(
      deriveBindingStatus({
        channel1: ok,
        channel2: pending,
        channel2PendingSince: now - PENDING_GRACE_WINDOW_MS - 1, // just past 24h
        nowMs: now,
      }),
    ).toBe('unverified');
  });

  it('exactly at the grace boundary → still pending (≤ not <)', () => {
    const now = 1_700_000_000_000;
    expect(
      deriveBindingStatus({
        channel1: ok,
        channel2: pending,
        channel2PendingSince: now - PENDING_GRACE_WINDOW_MS, // exactly 24h
        nowMs: now,
      }),
    ).toBe('pending');
  });

  it('caller-supplied grace window is honored (with clamp)', () => {
    const now = 1_700_000_000_000;
    // 1-hour grace: 30 min ago is still pending
    expect(
      deriveBindingStatus({
        channel1: ok,
        channel2: pending,
        channel2PendingSince: now - 30 * 60 * 1000,
        graceWindowMs: 60 * 60 * 1000,
        nowMs: now,
      }),
    ).toBe('pending');
    // 1-hour grace: 2 hours ago is unverified
    expect(
      deriveBindingStatus({
        channel1: ok,
        channel2: pending,
        channel2PendingSince: now - 2 * 60 * 60 * 1000,
        graceWindowMs: 60 * 60 * 1000,
        nowMs: now,
      }),
    ).toBe('unverified');
  });

  it('channel 1 pending (defensive — invalid state) → unverified', () => {
    // Channel 1 is synchronous; if it returns pending, that's a bug.
    // Defensive code treats it as unverified rather than crashing.
    expect(deriveBindingStatus({ channel1: pending, channel2: ok })).toBe('unverified');
  });

  it('channel2PendingSince omitted → uses nowMs (fresh pending)', () => {
    const now = 1_700_000_000_000;
    expect(
      deriveBindingStatus({
        channel1: ok,
        channel2: pending,
        // no channel2PendingSince
        nowMs: now,
      }),
    ).toBe('pending');
  });
});

describe('PENDING_GRACE_WINDOW_MS constants', () => {
  it('default is 24 hours', () => {
    expect(PENDING_GRACE_WINDOW_MS).toBe(24 * 60 * 60 * 1000);
  });
  it('max is 1 week', () => {
    expect(PENDING_GRACE_WINDOW_MAX_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });
  it('max is exactly 7x default', () => {
    expect(PENDING_GRACE_WINDOW_MAX_MS).toBe(7 * PENDING_GRACE_WINDOW_MS);
  });
});
