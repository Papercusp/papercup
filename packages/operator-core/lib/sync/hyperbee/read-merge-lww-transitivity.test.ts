/**
 * read-merge-lww-transitivity.test.ts — EI-1698 (incremental half, su-c2a63).
 *
 * The incremental merge's `beatsStored` comparator is a HAND-MIRROR of `lwwPick`
 * (projection.ts). dc9db fixed lwwPick to a SINGLE total order (derive an HLC for every
 * op: `op.hlc ?? encodeHlc({ms: ts})`), but beatsStored kept the OLD "HLC when BOTH carry
 * one, ELSE ts" rule — which switches comparison basis per pair and is NON-TRANSITIVE under
 * mixed-HLC presence, so the incremental fold could pick a DIFFERENT winner than a
 * from-scratch re-fold → cross-peer divergence in production (the main merge path runs the
 * incremental fold every poll).
 *
 * This pins the fix at the PUBLIC API: every fold order of a mixed-HLC op set must land on
 * the SAME winner. TEETH: under the pre-fix beatsStored the X/Y/Z set below forms a winner
 * cycle (X>Y by HLC, Y>Z by ts 9>7, Z>X by ts 7>1), so different delivery orders pick
 * different winners — this test FAILS on that ordering and PASSES on the synth-HLC total order.
 */
import { describe, it, expect } from 'vitest';
import { createMergeCursor, mergeAdmittedLogsIncremental, type AdmittedLog } from './read-merge';
import { encodeHlc } from '@papercusp/locks-core';
import type { OpEnvelope } from './op-envelope-types';
import type { PeerLogOp } from './peer-log';

function memLog(keyHex: string, ops: PeerLogOp[]): AdmittedLog {
  return { keyHex, length: ops.length, get: async (i) => ops[i] ?? null };
}
function op(value: string, ts: number, hlc?: string): PeerLogOp {
  return {
    type: 'put',
    table: 't',
    hbKey: 'k',
    value: { v: value },
    ts,
    schema_version: 1,
    author_pubkey: 'pk',
    ...(hlc ? { hlc } : {}),
  };
}

// The mixed-HLC trio that formed a winner CYCLE under the old "HLC-when-both-else-ts" rule:
//   X = hlc(ms5),  Y = hlc(ms3),  Z = NO hlc with ts=7.
//   Old rule: X>Y (HLC "ms5">"ms3"), Y>Z (ts 9>7), Z>X (ts 7>1) → X>Y>Z>X, a cycle.
// New synth-HLC rule: derived keys ms5 / ms3 / ms7 → Z (ms7) is the UNIQUE max for EVERY order.
const X = op('X', 1, encodeHlc({ ms: 5, count: 0 }));
const Y = op('Y', 9, encodeHlc({ ms: 3, count: 0 }));
const Z = op('Z', 7); // no hlc → derived encodeHlc({ms: 7, count: 0})

const PERMUTATIONS: PeerLogOp[][] = [
  [X, Y, Z],
  [X, Z, Y],
  [Y, X, Z],
  [Y, Z, X],
  [Z, X, Y],
  [Z, Y, X],
];

/** Fold a single log (the merge folds in array order) and return the final winner's value —
 *  the merge applies each op that beats the current winner, so the LAST applied is the max. */
async function foldWinner(order: PeerLogOp[]): Promise<string> {
  const cursor = createMergeCursor();
  let last = '';
  const apply = async (o: OpEnvelope): Promise<boolean> => {
    last = (o.value as { v: string }).v;
    return true;
  };
  await mergeAdmittedLogsIncremental([memLog('L', order)], cursor, { applyImpl: apply, getTimeoutMs: 0 });
  return last;
}

describe('EI-1698 — incremental beatsStored is a synth-HLC TOTAL order (fold-order-independent)', () => {
  it('every fold order of the mixed-HLC X/Y/Z set picks the SAME winner (Z, ms7) — no cycle', async () => {
    const winners = await Promise.all(PERMUTATIONS.map(foldWinner));
    // All 6 permutations agree → total order. (Pre-fix: [X,Y,Z]→Z but [Y,Z,X]→X = divergence.)
    expect(winners).toEqual(['Z', 'Z', 'Z', 'Z', 'Z', 'Z']);
    expect(new Set(winners).size).toBe(1);
  });

  it('a pure no-HLC (ts-only) set still resolves by ts, order-independently (back-compat)', async () => {
    const a = op('a', 3);
    const b = op('b', 7);
    const c = op('c', 5);
    for (const order of [
      [a, b, c],
      [c, b, a],
      [b, a, c],
    ]) {
      expect(await foldWinner(order)).toBe('b'); // ts=7 is max regardless of order
    }
  });

  it('a pure HLC set resolves by HLC, order-independently (back-compat)', async () => {
    const a = op('a', 0, encodeHlc({ ms: 1, count: 2 }));
    const b = op('b', 0, encodeHlc({ ms: 1, count: 9 }));
    const c = op('c', 0, encodeHlc({ ms: 1, count: 5 }));
    for (const order of [
      [a, b, c],
      [c, b, a],
      [b, c, a],
    ]) {
      expect(await foldWinner(order)).toBe('b'); // count=9 is max regardless of order
    }
  });
});
