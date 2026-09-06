/**
 * P-036 — offline convergence and double-spend end to end, over TWO REAL PEER
 * PROCESSES on a local testnet DHT.
 *
 * This file is a thin wrapper: every assertion lives in
 * `run-two-peer-commerce.ts`, which is the production door and runs identically
 * from the CLI and from here. That is deliberate — a rig whose assertions only
 * exist inside a vitest file cannot be run by an operator when the thing it
 * checks actually breaks.
 *
 * The peers are separate OS processes with their own corestore roots (D-057:
 * never the dogfood hive store), so nothing in the convergence result can be
 * explained by shared in-process state.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { runTwoPeerCommerce, type TwoPeerCommerceReport } from './run-two-peer-commerce';

/** DHT bootstrap + two child processes + a partition heal: minutes, not seconds. */
const TIMEOUT_MS = 300_000;

let report: TwoPeerCommerceReport | null = null;

async function once(): Promise<TwoPeerCommerceReport> {
  report ??= await runTwoPeerCommerce({});
  return report;
}

afterAll(() => {
  if (report && !report.ok) {
    // The scenario details carry the failing fold; print them where a CI log
    // will keep them, since the per-`it` message only names one scenario.
    console.error(JSON.stringify(report.scenarios, null, 2));
  }
});

describe('two real peer processes exchange P2P commerce and settlement events', () => {
  it(
    'passes every P-036 scenario',
    async () => {
      const result = await once();
      const failed = result.scenarios.filter((s) => !s.ok);
      expect(failed.map((s) => `${s.name}: ${s.detail}`)).toEqual([]);
      expect(result.ok).toBe(true);
    },
    TIMEOUT_MS,
  );

  it(
    'covers the acceptance clauses by name, so a silently-dropped scenario fails',
    async () => {
      const result = await once();
      // A run that stopped early would still report `ok` over the scenarios it
      // managed to record; naming the full set is what makes that detectable.
      expect(result.scenarios.map((s) => s.name)).toEqual([
        'mesh-formed',
        'propagates-without-partition',
        'partitioned-divergence',
        'converged-after-heal',
        'double-spend-refused',
        'claim-is-not-finality',
        'duplicate-receipt',
        'conflict-quarantined',
        'settlement-claimed-is-pending',
        'settlement-final-is-money-received',
        'settlement-submitted-once',
      ]);
    },
    TIMEOUT_MS,
  );

  it(
    'ends with both peer processes holding an identical converged fold',
    async () => {
      const result = await once();
      expect(result.finalStates).toHaveLength(2);
      const [a, b] = result.finalStates;
      expect(a.peerId).not.toBe(b.peerId);
      expect([...b.acceptedEventIds].sort()).toEqual([...a.acceptedEventIds].sort());
      expect(b.rollup).toEqual(a.rollup);
      expect(b.escrow).toEqual(a.escrow);
      // The escrow is never over-drawn, whichever peer you ask.
      expect(BigInt(a.escrow.settledMicros) + BigInt(a.escrow.escrowRemainingMicros)).toBeLessThanOrEqual(12_000n);
      expect(a.escrow.doubleSpendCount).toBe(1);
    },
    TIMEOUT_MS,
  );
});
