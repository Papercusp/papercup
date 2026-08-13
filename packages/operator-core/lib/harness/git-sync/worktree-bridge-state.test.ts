import { describe, expect, it } from 'vitest';
import {
  ACCEPT_FREE_WARN_AFTER,
  decideWorktreeBridgePersistence,
  nextWorktreeBridgeState,
  shouldWarnAcceptFree,
  type WorktreeBridgeTickFacts,
} from './worktree-bridge-state';

/**
 * EI-19332963201820362. These guard a detector, so they are written against the
 * ways a detector fails SILENTLY — losing its state, or resetting itself during
 * the very condition it exists to report — not just the happy path.
 */
describe('nextWorktreeBridgeState', () => {
  const base: WorktreeBridgeTickFacts = {
    lastEventId: 100,
    epochSeq: { epoch: 1, seq: 5 },
    stagingSha: 'a'.repeat(40),
    consumed: 0,
    accepted: 0,
    rejectedTerminal: {},
    nowMs: 1_000_000,
  };

  it('returns a COMPLETE object — every persisted field is present', () => {
    // The structural guarantee. `patchRoutineMetadata` is a top-level jsonb
    // merge, so a missing key here is a DELETED key in the database. This test
    // is what makes "a writer forgot a field" impossible to ship.
    const out = nextWorktreeBridgeState(null, base);
    expect(Object.keys(out).sort()).toEqual(
      [
        'accepted',
        'acceptFreeSince',
        'acceptFreeTicks',
        'at',
        'consumed',
        'epochSeq',
        'lastEventId',
        'rejectedTerminal',
        'stagingSha',
      ].sort(),
    );
    for (const [k, v] of Object.entries(out)) {
      if (k === 'acceptFreeSince' || k === 'epochSeq' || k === 'stagingSha') continue; // legitimately nullable
      expect(v, `${k} must never be undefined — jsonb would drop it`).not.toBeUndefined();
    }
  });

  describe('the accept-free streak is a THREE-way decision', () => {
    it('consumed 0 CARRIES the streak — a quiet tick is not evidence either way', () => {
      // THE REGRESSION THIS MODULE EXISTS FOR. The original inline form was
      // `consumed > 0 && accepted === 0 ? prior + 1 : 0`, which RESET on a quiet
      // tick — so any lull erased an in-progress freeze signal.
      const out = nextWorktreeBridgeState({ acceptFreeTicks: 7, acceptFreeSince: 900_000 }, { ...base, consumed: 0 });
      expect(out.acceptFreeTicks).toBe(7);
      expect(out.acceptFreeSince).toBe(900_000);
    });

    it('consumed >0 with accepted 0 INCREMENTS and stamps the start', () => {
      const out = nextWorktreeBridgeState(null, {
        ...base,
        consumed: 3,
        accepted: 0,
        rejectedTerminal: { 'non-fast-forward': 3 },
      });
      expect(out.acceptFreeTicks).toBe(1);
      expect(out.acceptFreeSince).toBe(base.nowMs);
    });

    it('an ongoing streak PRESERVES the original start, it does not re-stamp it', () => {
      // Otherwise the streak's age is always ~one tick and a freeze can never
      // be aged — the field would look fresh throughout a six-hour stall.
      const out = nextWorktreeBridgeState({ acceptFreeTicks: 4, acceptFreeSince: 500_000 }, { ...base, consumed: 2 });
      expect(out.acceptFreeTicks).toBe(5);
      expect(out.acceptFreeSince).toBe(500_000);
    });

    it('any accept RESETS the streak — a detector that cannot go green gets ignored', () => {
      const out = nextWorktreeBridgeState(
        { acceptFreeTicks: 42, acceptFreeSince: 1 },
        { ...base, consumed: 2, accepted: 1, rejectedTerminal: { 'non-fast-forward': 1 } },
      );
      expect(out.acceptFreeTicks).toBe(0);
      expect(out.acceptFreeSince).toBeNull();
    });
  });

  describe('prior-state degradation', () => {
    it('treats null, undefined, absent and jsonb-null priors identically', () => {
      // Rows written before these fields existed simply lack them, and jsonb
      // hands back null rather than undefined. All four must behave as "no
      // streak yet" — never NaN, never undefined leaking into the DB.
      for (const prior of [null, undefined, {}, { acceptFreeTicks: null, acceptFreeSince: null }]) {
        const out = nextWorktreeBridgeState(prior, { ...base, consumed: 1, accepted: 0 });
        expect(out.acceptFreeTicks).toBe(1);
        expect(out.acceptFreeSince).toBe(base.nowMs);
      }
    });
  });

  it('a sustained freeze accumulates across ticks, and one accept clears it', () => {
    // End-to-end shape of the 2026-08-02 incident: many ticks consuming
    // announcements and accepting none, then the drain passes the watermark.
    let state = nextWorktreeBridgeState(null, { ...base, consumed: 2, accepted: 0 });
    for (let i = 0; i < 5; i++) {
      state = nextWorktreeBridgeState(state, { ...base, consumed: 2, accepted: 0, nowMs: base.nowMs + i });
    }
    expect(state.acceptFreeTicks).toBe(6);
    expect(state.acceptFreeSince).toBe(base.nowMs); // aged from the true start

    const recovered = nextWorktreeBridgeState(state, { ...base, consumed: 1, accepted: 1 });
    expect(recovered.acceptFreeTicks).toBe(0);
    expect(recovered.acceptFreeSince).toBeNull();
  });
});

describe('decideWorktreeBridgePersistence (P-505 caller/persistence seam)', () => {
  const nowMs = 100_000_000;
  const pendingRows = [
    { id: 41, tsMs: nowMs - 1_000 },
    { id: 42, tsMs: nowMs - 2_000 },
    { id: 44, tsMs: nowMs - 3_000 },
  ];
  const outcome = {
    unprocessedFromIndex: 1,
    watermark: { epochSeq: { epoch: 8, seq: 3 }, stagingSha: 'b'.repeat(40) },
    results: [{ outcome: 'accepted' }, { outcome: 'rejected' }],
    acceptedCount: 1,
    terminalRejections: {},
  };

  it('threads a retryable stop into persisted lastEventId instead of the collected maximum', () => {
    const decision = decideWorktreeBridgePersistence({
      prior: null,
      maxRowId: 44,
      pendingRows,
      outcome,
      nowMs,
    });

    expect(decision.cursorDecision).toEqual({ cursor: 41, expiredRow: null });
    expect(decision.bridgeState).toMatchObject({
      lastEventId: 41,
      epochSeq: outcome.watermark.epochSeq,
      stagingSha: outcome.watermark.stagingSha,
      consumed: 2,
      accepted: 1,
    });
  });

  it('fails before constructing persistable state when the stop index is not row-aligned', () => {
    expect(() =>
      decideWorktreeBridgePersistence({
        prior: null,
        maxRowId: 44,
        pendingRows,
        outcome: { ...outcome, unprocessedFromIndex: pendingRows.length },
        nowMs,
      }),
    ).toThrow(RangeError);
  });
});

describe('shouldWarnAcceptFree', () => {
  it('stays silent below the threshold — one accept-free tick is ordinary', () => {
    for (let n = 0; n < ACCEPT_FREE_WARN_AFTER; n++) expect(shouldWarnAcceptFree(n)).toBe(false);
  });

  it('fires on the crossing tick and every 10th after, not every tick', () => {
    expect(shouldWarnAcceptFree(3)).toBe(true);
    expect(shouldWarnAcceptFree(4)).toBe(false);
    expect(shouldWarnAcceptFree(12)).toBe(false);
    expect(shouldWarnAcceptFree(13)).toBe(true);
    expect(shouldWarnAcceptFree(23)).toBe(true);
  });

  it('a long freeze keeps signalling — it never goes permanently quiet', () => {
    const fires = Array.from({ length: 200 }, (_, n) => n).filter(shouldWarnAcceptFree);
    expect(fires.length).toBeGreaterThan(15);
  });
});
