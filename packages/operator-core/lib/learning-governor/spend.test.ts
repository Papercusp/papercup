/**
 * Learning spend reservation + settlement — the pure decisions
 * (blender-evidence-driven-learning-redesign-2026-09-04 P-005).
 *
 * The cases that matter are the ones the post-hoc ledger could not express:
 * an attempt in flight, an attempt that cancels, an attempt that fails after
 * burning money, and an evaluation that completes only part of its work. Each
 * has its own describe block below, because each is a separate way the old
 * `if (costUsd > 0)` guard lost spend.
 */
import { describe, expect, it } from 'vitest';
import { validateLearningContract, type LearningContract } from '../experiment/types';
import {
  planReservation,
  reservationHeadroomUsd,
  settleReservation,
  summarizeSpendPositions,
  toLearningSpend,
  type SpendPositionRow,
} from './spend';

const lifetime = (budgetUsd: number | null, spentUsd = 0) =>
  ({ budgetKind: 'lifetime', budgetUsd, spentUsd }) as const;
const perCycle = (budgetUsd: number | null, spentUsd = 0) =>
  ({ budgetKind: 'per-cycle', budgetUsd, spentUsd }) as const;

describe('reservationHeadroomUsd', () => {
  it('subtracts spend, open reservations AND the floor from a lifetime cap', () => {
    // 10 budget − 2 spent − 3 already reserved by attempts in flight − 0.5 floor.
    expect(reservationHeadroomUsd(lifetime(10, 2), 3, 0.5)).toBe(4.5);
  });

  it('is the term that stops concurrent attempts overspending the same headroom', () => {
    // Two attempts read the SAME registration; the second sees the first's
    // reservation. Without the open term both would read 9.5 and both grant.
    const first = reservationHeadroomUsd(lifetime(10, 0), 0, 0.5);
    const second = reservationHeadroomUsd(lifetime(10, 0), first!, 0.5);
    expect(first).toBe(9.5);
    expect(second).toBe(0);
  });

  it('never goes negative when spend has already passed the cap', () => {
    expect(reservationHeadroomUsd(lifetime(10, 12), 0, 0.5)).toBe(0);
  });

  it('reports a per-cycle row as its per-run cap, unchanged by other open attempts', () => {
    // Per-cycle rows are 'native' enforcement: the LOOP bounds each run at the
    // cap, so open attempts on other runs are deliberately not charged here.
    expect(reservationHeadroomUsd(perCycle(2), 5, 0.5)).toBe(2);
  });

  it('reports null — never "unbounded" — for an unbudgeted or missing registration', () => {
    expect(reservationHeadroomUsd(lifetime(null), 0)).toBeNull();
    expect(reservationHeadroomUsd(null, 0)).toBeNull();
    expect(reservationHeadroomUsd(undefined, 0)).toBeNull();
  });
});

describe('planReservation', () => {
  it('grants the full request when headroom covers it', () => {
    expect(planReservation({ requestedUsd: 2, headroomUsd: 5 })).toMatchObject({
      ok: true,
      reservedUsd: 2,
      clamped: false,
    });
  });

  it('CLAMPS to headroom rather than refusing work that partly fits', () => {
    expect(planReservation({ requestedUsd: 8, headroomUsd: 3 })).toMatchObject({
      ok: true,
      reservedUsd: 3,
      clamped: true,
    });
  });

  it('refuses fail-closed on an unbudgeted row — no budget is not "no limit"', () => {
    expect(planReservation({ requestedUsd: 1, headroomUsd: null })).toMatchObject({
      ok: false,
      reason: 'unbudgeted',
      reservedUsd: 0,
    });
  });

  it('refuses when there is no headroom left', () => {
    expect(planReservation({ requestedUsd: 1, headroomUsd: 0 })).toMatchObject({
      ok: false,
      reason: 'no-headroom',
    });
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])('refuses an invalid amount (%s)', (requestedUsd) => {
    expect(planReservation({ requestedUsd, headroomUsd: 5 })).toMatchObject({
      ok: false,
      reason: 'invalid-amount',
    });
  });

  it('ALLOWS a zero-cost attempt so a free call still ledgers', () => {
    // The whole point of the reservation lifecycle: an attempt exists even
    // when it costs nothing. Refusing here would recreate the `costUsd > 0`
    // blind spot one layer up.
    expect(planReservation({ requestedUsd: 0, headroomUsd: 5 })).toMatchObject({
      ok: true,
      reservedUsd: 0,
    });
  });
});

describe('settleReservation — every attempt closes, whatever happened', () => {
  it('settles a full use with nothing released', () => {
    expect(settleReservation({ reservedUsd: 2, disposition: 'used', usedUsd: 2 })).toEqual({
      status: 'settled',
      usedUsd: 2,
      releasedUsd: 0,
      overrunUsd: 0,
    });
  });

  it('releases the remainder of a PARTIAL evaluation', () => {
    // 3 of 10 tasks ran: the charge is real, the rest goes back to headroom.
    expect(settleReservation({ reservedUsd: 5, disposition: 'used', usedUsd: 1.5 })).toEqual({
      status: 'settled',
      usedUsd: 1.5,
      releasedUsd: 3.5,
      overrunUsd: 0,
    });
  });

  it('closes a CANCELLED attempt, releasing the whole reservation', () => {
    expect(settleReservation({ reservedUsd: 4, disposition: 'cancelled' })).toEqual({
      status: 'cancelled',
      usedUsd: 0,
      releasedUsd: 4,
      overrunUsd: 0,
    });
  });

  it('charges a FAILED proposer call for the tokens it burned before throwing', () => {
    // The case the old ledger dropped entirely: money spent, then an exception.
    expect(settleReservation({ reservedUsd: 4, disposition: 'failed', usedUsd: 0.4 })).toEqual({
      status: 'failed',
      usedUsd: 0.4,
      releasedUsd: 3.6,
      overrunUsd: 0,
    });
  });

  it('lets a cancellation carry a charge — cancelled is not a synonym for free', () => {
    expect(settleReservation({ reservedUsd: 4, disposition: 'cancelled', usedUsd: 0.75 })).toMatchObject({
      status: 'cancelled',
      usedUsd: 0.75,
      releasedUsd: 3.25,
    });
  });

  it('records an OVERRUN in full rather than clamping it out of sight', () => {
    // Clamping would under-report money genuinely burned — the exact failure
    // this module exists to remove.
    expect(settleReservation({ reservedUsd: 1, disposition: 'used', usedUsd: 1.6 })).toEqual({
      status: 'settled',
      usedUsd: 1.6,
      releasedUsd: 0,
      overrunUsd: 0.6000000000000001,
    });
  });

  it('treats a negative or non-finite charge as zero', () => {
    expect(settleReservation({ reservedUsd: 2, disposition: 'used', usedUsd: -5 }).usedUsd).toBe(0);
    expect(settleReservation({ reservedUsd: 2, disposition: 'used', usedUsd: Number.NaN }).usedUsd).toBe(0);
  });
});

describe('summarizeSpendPositions — the four amounts, separately', () => {
  const row = (o: Partial<SpendPositionRow>): SpendPositionRow => ({
    requestedUsd: 0,
    reservedUsd: 0,
    usedUsd: 0,
    status: 'open',
    ...o,
  });

  it('is all zeroes with no attempts', () => {
    expect(summarizeSpendPositions([])).toMatchObject({
      requestedUsd: 0,
      reservedUsd: 0,
      usedUsd: 0,
      unsettledUsd: 0,
      openAttempts: 0,
    });
  });

  it('separates in-flight reservation from settled charge', () => {
    const positions = summarizeSpendPositions([
      row({ requestedUsd: 5, reservedUsd: 5, usedUsd: 2, status: 'settled' }),
      row({ requestedUsd: 3, reservedUsd: 3, status: 'open' }),
    ]);
    expect(positions).toMatchObject({
      requestedUsd: 8,
      reservedUsd: 8,
      usedUsd: 2,
      unsettledUsd: 3, // the number the post-hoc ledger could not express
      openAttempts: 1,
    });
  });

  it('counts a cancelled/failed attempt as reserved-and-released, not as use', () => {
    const positions = summarizeSpendPositions([
      row({ requestedUsd: 4, reservedUsd: 4, usedUsd: 0, status: 'cancelled' }),
      row({ requestedUsd: 4, reservedUsd: 4, usedUsd: 0.4, status: 'failed' }),
    ]);
    expect(positions).toMatchObject({ usedUsd: 0.4, unsettledUsd: 0, openAttempts: 0 });
  });

  it('never counts an OPEN row as having charged anything', () => {
    // An open row's used_usd is 0 by construction, but a stale/torn read must
    // not be able to book it as spend either.
    const positions = summarizeSpendPositions([row({ reservedUsd: 2, usedUsd: 9, status: 'open' })]);
    expect(positions.usedUsd).toBe(0);
    expect(positions.unsettledUsd).toBe(2);
  });

  it('reconciles an overrun by growing the reservation to what was consumed', () => {
    const positions = summarizeSpendPositions([
      row({ requestedUsd: 1, reservedUsd: 1, usedUsd: 1.5, status: 'settled' }),
    ]);
    expect(positions).toMatchObject({
      requestedUsd: 1.5,
      reservedUsd: 1.5,
      usedUsd: 1.5,
      overrunAttempts: 1,
    });
  });
});

describe('toLearningSpend — the governor IS the contract`s spend record', () => {
  // Only the SPEND leg is under test here (contract.test.ts owns the rest), so
  // the other legs are structurally present but deliberately unpopulated — the
  // assertions filter to `spend.*` errors. What matters is that the validator
  // can reach the spend checks without tripping over a missing nested object.
  const contractWith = (spend: LearningContract['spend']): LearningContract =>
    ({
      contractVersion: '1',
      candidate: {
        id: 'cand-1',
        version: 'v2',
        parentVersion: 'v1',
        variantHash: 'vh',
        actor: { id: 'su-test' },
        potScope: { potId: 'papercusp', workspaceId: 'ws' },
      },
      experiment: { baselineId: 'base', challengerId: 'chal', repeats: 1 },
      evidence: [],
      spend,
      decision: { authority: { id: 'su-test' }, reason: 'test', evidenceIds: [] },
      outcomes: [],
    }) as unknown as LearningContract;

  it('produces a spend record the P-001 contract validator accepts', () => {
    const positions = summarizeSpendPositions([
      { requestedUsd: 5, reservedUsd: 4, usedUsd: 3, status: 'settled' },
      { requestedUsd: 2, reservedUsd: 2, usedUsd: 0, status: 'open' },
    ]);
    const spend = toLearningSpend(positions, '2026-09-04T01:00:00.000Z');
    // The invariants validateLearningContract enforces, satisfied by construction.
    expect(spend.reservedUsd).toBeLessThanOrEqual(spend.requestedUsd);
    expect(spend.usedUsd + spend.unsettledUsd).toBeLessThanOrEqual(spend.reservedUsd);
    const errors = validateLearningContract(contractWith(spend)).errors;
    expect(errors.filter((e) => e.startsWith('spend.'))).toEqual([]);
  });

  it('an OVERRUN still yields a valid contract spend record', () => {
    // Without overrun reconciliation this is exactly the case that would emit
    // a contract the validator rejects while the ledger is perfectly honest.
    const positions = summarizeSpendPositions([
      { requestedUsd: 1, reservedUsd: 1, usedUsd: 1.5, status: 'settled' },
    ]);
    const spend = toLearningSpend(positions, '2026-09-04T01:00:00.000Z');
    expect(validateLearningContract(contractWith(spend)).errors.filter((e) => e.startsWith('spend.'))).toEqual(
      [],
    );
  });

  it('withholds settledAt while any attempt is still open', () => {
    const open = summarizeSpendPositions([{ requestedUsd: 2, reservedUsd: 2, usedUsd: 0, status: 'open' }]);
    expect(toLearningSpend(open, '2026-09-04T01:00:00.000Z').settledAt).toBeUndefined();
    const closed = summarizeSpendPositions([
      { requestedUsd: 2, reservedUsd: 2, usedUsd: 2, status: 'settled' },
    ]);
    expect(toLearningSpend(closed, '2026-09-04T01:00:00.000Z').settledAt).toBe('2026-09-04T01:00:00.000Z');
  });
});
