/**
 * work-item-redundancy.test.ts — pure unit tests for BOINC redundancy
 * (decentralized-dispatch-scaling-2026-06-08 P-014).
 *
 * Covers the network/PG-free cores: the deterministic winner selection
 * (compareReplicaVerdicts / pickRedundancyWinner — the tie-break every peer must agree on)
 * and the master-switch flag reader. The DB store + the judge→adopt flow are exercised in
 * work-item-redundancy.integration.test.ts (real PG + a fake llmCall).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';

// The pure functions don't touch PG, but importing the module pulls work-items.ts +
// gym/primitives (their stores are lazy). Stub getOrgPg so import never needs a real pool.
vi.mock('@papercusp/db-org', async () => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...actual, getOrgPg: () => ({ sql: (() => {}) as never }) };
});

const { compareReplicaVerdicts, pickRedundancyWinner, workItemRedundancyEnabled, MIN_REDUNDANCY } =
  await import('./work-item-redundancy');

type V = { replicaIndex: number; composite: number; acquiredTs: string; owner: string };

describe('pickRedundancyWinner — deterministic winner selection', () => {
  it('picks the HIGHEST composite', () => {
    const verdicts: V[] = [
      { replicaIndex: 0, composite: 3.5, acquiredTs: '2026-06-08T00:00:00.000Z', owner: 'su-a' },
      { replicaIndex: 1, composite: 8.5, acquiredTs: '2026-06-08T00:00:01.000Z', owner: 'su-b' },
      { replicaIndex: 2, composite: 6.0, acquiredTs: '2026-06-08T00:00:02.000Z', owner: 'su-c' },
    ];
    expect(pickRedundancyWinner(verdicts)).toBe(1);
  });

  it('tie on composite → EARLIEST acquired_ts wins (did the most work)', () => {
    const verdicts: V[] = [
      { replicaIndex: 0, composite: 7, acquiredTs: '2026-06-08T00:00:05.000Z', owner: 'su-a' },
      { replicaIndex: 1, composite: 7, acquiredTs: '2026-06-08T00:00:01.000Z', owner: 'su-b' },
    ];
    expect(pickRedundancyWinner(verdicts)).toBe(1);
  });

  it('tie on composite + acquired_ts → LOWEST owner wins', () => {
    const ts = '2026-06-08T00:00:01.000Z';
    const verdicts: V[] = [
      { replicaIndex: 0, composite: 7, acquiredTs: ts, owner: 'su-z' },
      { replicaIndex: 1, composite: 7, acquiredTs: ts, owner: 'su-a' },
    ];
    expect(pickRedundancyWinner(verdicts)).toBe(1);
  });

  it('full tie → LOWEST replica_index (final disambiguator)', () => {
    const ts = '2026-06-08T00:00:01.000Z';
    const verdicts: V[] = [
      { replicaIndex: 3, composite: 7, acquiredTs: ts, owner: 'su-a' },
      { replicaIndex: 1, composite: 7, acquiredTs: ts, owner: 'su-a' },
    ];
    expect(pickRedundancyWinner(verdicts)).toBe(1);
  });

  it('empty → null', () => {
    expect(pickRedundancyWinner([])).toBeNull();
  });

  it('property: the winner beats-or-ties every other verdict, and is order-independent', () => {
    const verdictArb = fc
      .array(
        fc.record({
          composite: fc.double({ min: 0, max: 10, noNaN: true }),
          acquiredMs: fc.integer({ min: 0, max: 10_000 }),
          owner: fc.string({ minLength: 1, maxLength: 6 }),
        }),
        { minLength: 1, maxLength: 8 },
      )
      // assign a UNIQUE replica_index per element (the slot is unique by construction)
      .map((rows) =>
        rows.map((r, i) => ({
          replicaIndex: i,
          composite: r.composite,
          acquiredTs: new Date(r.acquiredMs).toISOString(),
          owner: r.owner,
        })),
      );

    fc.assert(
      fc.property(verdictArb, (verdicts) => {
        const winnerIdx = pickRedundancyWinner(verdicts)!;
        const winner = verdicts.find((v) => v.replicaIndex === winnerIdx)!;
        // The winner is the minimum under the total order: it beats-or-ties every other.
        for (const other of verdicts) {
          expect(compareReplicaVerdicts(winner, other)).toBeLessThanOrEqual(0);
        }
        // Order-independent: reversing the input yields the same winner.
        expect(pickRedundancyWinner([...verdicts].reverse())).toBe(winnerIdx);
      }),
    );
  });

  it('does not mutate its input', () => {
    const verdicts: V[] = [
      { replicaIndex: 1, composite: 5, acquiredTs: 't1', owner: 'b' },
      { replicaIndex: 0, composite: 9, acquiredTs: 't0', owner: 'a' },
    ];
    const before = verdicts.map((v) => v.replicaIndex);
    pickRedundancyWinner(verdicts);
    expect(verdicts.map((v) => v.replicaIndex)).toEqual(before);
  });
});

describe('workItemRedundancyEnabled — the master switch (off by default)', () => {
  const prev = process.env.PAPERCUSP_WORKITEM_REDUNDANCY;
  afterEach(() => {
    if (prev === undefined) delete process.env.PAPERCUSP_WORKITEM_REDUNDANCY;
    else process.env.PAPERCUSP_WORKITEM_REDUNDANCY = prev;
  });

  it('is OFF when unset', () => {
    delete process.env.PAPERCUSP_WORKITEM_REDUNDANCY;
    expect(workItemRedundancyEnabled()).toBe(false);
  });
  it('is ON only for exactly "1"', () => {
    process.env.PAPERCUSP_WORKITEM_REDUNDANCY = '1';
    expect(workItemRedundancyEnabled()).toBe(true);
    process.env.PAPERCUSP_WORKITEM_REDUNDANCY = 'true';
    expect(workItemRedundancyEnabled()).toBe(false);
    process.env.PAPERCUSP_WORKITEM_REDUNDANCY = '0';
    expect(workItemRedundancyEnabled()).toBe(false);
  });

  it('MIN_REDUNDANCY is 2 (need ≥2 to compare)', () => {
    expect(MIN_REDUNDANCY).toBe(2);
  });
});
