/**
 * Unit tests for `reseedLeaderCompactionLimit` — the P-009 become-a-leader compaction-cap
 * re-seed (owner directive 2026-07-19, per-member-declarative-launch-specs). The presence +
 * model-spec seams are mocked; `agent-config-constants` runs REAL (real clamp / default /
 * member-cap logic) so the [1m] leader-cap vs member-cap gap is exercised for real. Covers
 * every `reason` branch of LeaderReseedOutcome plus the never-throw fail-safe (a re-seed miss
 * must never fail the already-committed leadership transfer).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  COMPACTION_LIMIT_DEFAULT_1M_CAP,
  COMPACTION_LIMIT_DEFAULT_1M_FLEET_MEMBER_CAP,
} from '../../agent-config-constants';

const getPresence = vi.fn();
const setCompactionLimit = vi.fn();
const resolveModelSpecForOwner = vi.fn();

// take-leadership-core statically imports these — stub so no DB module loads at import time.
vi.mock('../../agent-fleets-store', () => ({
  FLEET_TYPES: ['single', 'paired'] as const,
  setFleetLeader: vi.fn(),
}));
vi.mock('../coordination/presence', () => ({
  heartbeatPresence: vi.fn(),
  setPresenceFleet: vi.fn(),
  getPresence: (...a: unknown[]) => getPresence(...a),
  setCompactionLimit: (...a: unknown[]) => setCompactionLimit(...a),
}));
vi.mock('../coordination/presence-fleet', () => ({ fetchPresenceFleet: vi.fn() }));
vi.mock('../coordination/messages', () => ({ sendMessage: vi.fn() }));
// Dynamically imported inside the function — mock only the spec resolver; constants run REAL.
vi.mock('../../compaction-usage', () => ({
  resolveModelSpecForOwner: (...a: unknown[]) => resolveModelSpecForOwner(...a),
}));

import { reseedLeaderCompactionLimit } from './take-leadership-core';

const OWNER = 'su-bob';
// Track the REAL constant (agent-config-constants runs unmocked here) so this test never
// drifts when the fleet-member default changes (e.g. owner 2026-07-19: 300k→200k).
const MEMBER_CAP = COMPACTION_LIMIT_DEFAULT_1M_FLEET_MEMBER_CAP;
// DERIVED, never a literal — the same rule CUSTOM_LIMIT's comment below states.
// This was hardcoded `400_000` and went red the moment owner directive 2026-09-21
// moved the leader/solo cap to 450k, even though nothing about the re-seed changed:
// a hand-copied constant is a second copy of a truth the source owns.
const LEADER_CAP = COMPACTION_LIMIT_DEFAULT_1M_CAP;
/** A limit that is provably NEITHER cap — the midpoint cannot equal either
 *  endpoint while MEMBER_CAP < LEADER_CAP, so a future cap move cannot silently
 *  turn this fixture into an exact member-seed match (which is what happened to
 *  the hardcoded 250_000 it replaced). */
const CUSTOM_LIMIT = Math.round((MEMBER_CAP + LEADER_CAP) / 2);

function presenceWithLimit(limit: number | null) {
  return { compactionLimit: limit } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  resolveModelSpecForOwner.mockResolvedValue('opus[1m]'); // default: a [1m] session (leader-cap/member-cap gap)
  getPresence.mockResolvedValue(presenceWithLimit(MEMBER_CAP));
  setCompactionLimit.mockResolvedValue(undefined);
});

describe('reseedLeaderCompactionLimit (P-009 become-a-leader cap re-seed)', () => {
  it('lifts a stuck member-cap seed to the leader default on a [1m] session', async () => {
    const out = await reseedLeaderCompactionLimit(OWNER);
    expect(setCompactionLimit).toHaveBeenCalledWith(OWNER, LEADER_CAP, { explicit: false });
    expect(out).toEqual({ applied: LEADER_CAP, from: MEMBER_CAP, reason: 'member-cap-lifted' });
  });

  it('leaves an already-leader-grade limit untouched (not exactly the member-cap seed)', async () => {
    getPresence.mockResolvedValue(presenceWithLimit(LEADER_CAP));
    const out = await reseedLeaderCompactionLimit(OWNER);
    expect(setCompactionLimit).not.toHaveBeenCalled();
    expect(out).toEqual({ applied: LEADER_CAP, from: LEADER_CAP, reason: 'already-leader-grade' });
  });

  it('leaves a deliberately-tuned custom limit untouched (only the EXACT member seed lifts)', async () => {
    // DERIVED, never a literal: this fixture must be a value that is neither cap,
    // or it stops testing what it names. It was hardcoded 250_000 — custom while
    // the member cap was 200k, and exactly the cap after owner 2026-09-02 raised
    // it to 250k, at which point the re-seed correctly fired and this test failed
    // for the right reason. The midpoint can never equal either endpoint while
    // MEMBER_CAP < LEADER_CAP, so the next cap move cannot re-break it.
    expect(CUSTOM_LIMIT).not.toBe(MEMBER_CAP);
    expect(CUSTOM_LIMIT).not.toBe(LEADER_CAP);
    getPresence.mockResolvedValue(presenceWithLimit(CUSTOM_LIMIT));
    const out = await reseedLeaderCompactionLimit(OWNER);
    expect(setCompactionLimit).not.toHaveBeenCalled();
    expect(out).toMatchObject({ reason: 'already-leader-grade', from: CUSTOM_LIMIT });
  });

  it('does not auto-lift an explicit member-cap override when taking leadership', async () => {
    getPresence.mockResolvedValue({ compactionLimit: MEMBER_CAP, compactionLimitExplicit: true });
    const out = await reseedLeaderCompactionLimit(OWNER);
    expect(setCompactionLimit).not.toHaveBeenCalled();
    expect(out).toEqual({ applied: MEMBER_CAP, from: MEMBER_CAP, reason: 'already-leader-grade' });
  });

  it('an explicit compactionLimit wins and is clamped to the leader ceiling', async () => {
    const out = await reseedLeaderCompactionLimit(OWNER, { compactionLimit: 999_999 });
    expect(setCompactionLimit).toHaveBeenCalledWith(OWNER, LEADER_CAP, { explicit: true }); // clamped down to the leader cap
    expect(out).toMatchObject({ applied: LEADER_CAP, reason: 'explicit-limit' });
  });

  it('an explicit contextSize suppresses the auto-lift (caller is shaping the session)', async () => {
    const out = await reseedLeaderCompactionLimit(OWNER, { contextSize: 'trimmed' });
    expect(setCompactionLimit).not.toHaveBeenCalled();
    expect(out).toEqual({ applied: MEMBER_CAP, from: MEMBER_CAP, reason: 'explicit-context-size' });
  });

  it('a non-[1m] spec has no member/leader gap → nothing to lift', async () => {
    resolveModelSpecForOwner.mockResolvedValue('opus'); // bare 200k-window spec → 158k, both roles
    getPresence.mockResolvedValue(presenceWithLimit(MEMBER_CAP));
    const out = await reseedLeaderCompactionLimit(OWNER);
    expect(setCompactionLimit).not.toHaveBeenCalled();
    expect(out).toMatchObject({ reason: 'non-1m-no-cap-gap' });
  });

  it('never throws — a presence-read failure yields null (the transfer must not fail on a re-seed miss)', async () => {
    getPresence.mockRejectedValue(new Error('presence down'));
    // current resolves to null; a null current !== the member-cap seed → already-leader-grade path,
    // which does NOT write — the important guarantee is that the function returns, never throws.
    const out = await reseedLeaderCompactionLimit(OWNER);
    expect(out).not.toBeNull();
    expect(setCompactionLimit).not.toHaveBeenCalled();
  });

  it('returns null (never throws) when the set write itself fails on the lift path', async () => {
    setCompactionLimit.mockRejectedValue(new Error('write down'));
    const out = await reseedLeaderCompactionLimit(OWNER); // member-cap seed → tries to lift → write throws
    expect(out).toBeNull();
  });
});
