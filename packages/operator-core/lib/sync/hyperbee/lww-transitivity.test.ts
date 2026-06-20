import { describe, expect, it } from 'vitest';
import { encodeHlc } from '@papercusp/locks-core';
import { lwwPick } from './projection';
import type { OpEnvelope } from './op-envelope-types';

/**
 * EI-1698 — the LWW comparator (`lwwPick`, mirrored by the PG `fed_hlc` guard)
 * must be a TOTAL, TRANSITIVE order, so the merge fold picks the same winner
 * regardless of delivery order. Today Step 1 switches basis per pair —
 * "if BOTH ops carry an HLC → compare HLC, ELSE → compare ts" — which is
 * NON-TRANSITIVE under mixed HLC presence and lets two peers in a rolling
 * upgrade DIVERGE on a contended key.
 *
 * The deterministic minimal repro (from the work item): a no-HLC op whose `ts`
 * sits BETWEEN two HLC ops on the same key forms a comparison cycle —
 *   X = {hlc: HIGH, ts: 100}, Y = {hlc: none, ts: 150}, Z = {hlc: LOW, ts: 200}
 *   lwwPick(X,Y)=Y (mixed→ts), lwwPick(Y,Z)=Z (mixed→ts), lwwPick(X,Z)=X (HLC)
 *   ⇒ X>Z, Z>Y, Y>X — a cycle ⇒ fold([X,Y,Z]) ≠ fold([Z,Y,X]).
 *
 * FIX (one ordering key of record, the D-001 principle): give EVERY op a single
 * comparable key — `op.hlc ?? encodeHlc({ms: op.ts, count: 0})` — and always
 * string-compare it. Total + transitive, and backward-compatible (a no-HLC op
 * is pre-P-010 = oldest ts → lowest derived key → same convergence as today).
 *
 * This test is RED on the current `lwwPick` (order-dependent fold) and GREEN
 * after the fix. Teeth: it fails today, passes once the derived-key order lands.
 */

function op(over: Partial<OpEnvelope>): OpEnvelope {
  return {
    type: 'put',
    table: 'features_consolidated',
    hbKey: 'K-contended',
    value: { v: over.hlc ?? over.ts ?? 0 },
    ts: 0,
    schema_version: 1,
    writerPubkey: 'w',
    sourceLogKeyHex: '',
    ...over,
  } as OpEnvelope;
}

// Fixed-width sortable HLC strings (encodeHlc convention: ms.padStart(15):count.padStart(5)).
const HIGH = encodeHlc({ ms: 9_000, count: 0 });
const LOW = encodeHlc({ ms: 1_000, count: 0 });

// The cycle witnesses, distinguished by `value` so we can identify the fold winner.
const X = op({ hlc: HIGH, ts: 100, value: { id: 'X' } }); // upgraded peer, recv-advanced HLC
const Y = op({ hlc: undefined, ts: 150, value: { id: 'Y' } }); // pre-314 peer, no HLC, ts between X and Z
const Z = op({ hlc: LOW, ts: 200, value: { id: 'Z' } }); // upgraded peer

/** Fold a list of same-key ops through lwwPick (the merge winner-fold). */
function fold(ops: OpEnvelope[]): OpEnvelope {
  return ops.reduce((acc, cur) => lwwPick(acc, cur));
}

const winnerId = (o: OpEnvelope): string => (o.value as { id?: string })?.id ?? '?';

describe('EI-1698 — lwwPick is a total, transitive order under mixed HLC presence', () => {
  it('the merge fold is ORDER-INDEPENDENT (no winner cycle)', () => {
    // Same three ops, opposite delivery orders → MUST agree on the winner.
    expect(winnerId(fold([X, Y, Z]))).toBe(winnerId(fold([Z, Y, X])));
    // And every permutation must agree (a transitive order has one maximum).
    const perms: OpEnvelope[][] = [
      [X, Y, Z],
      [X, Z, Y],
      [Y, X, Z],
      [Y, Z, X],
      [Z, X, Y],
      [Z, Y, X],
    ];
    const winners = new Set(perms.map((p) => winnerId(fold(p))));
    expect(winners.size).toBe(1);
  });

  it('pairwise comparisons are acyclic (transitive): NOT (X>Z ∧ Z>Y ∧ Y>X)', () => {
    const gt = (a: OpEnvelope, b: OpEnvelope) => winnerId(lwwPick(a, b)) === winnerId(a);
    // A cycle would be X>Z, Z>Y, Y>X all true simultaneously.
    const cyclic = gt(X, Z) && gt(Z, Y) && gt(Y, X);
    expect(cyclic).toBe(false);
  });

  it('backward-compatible: among only HLC ops, the highest HLC still wins', () => {
    expect(winnerId(lwwPick(X, Z))).toBe('X'); // HIGH beats LOW
  });

  it('backward-compatible: among only no-HLC ops, the highest ts still wins', () => {
    const a = op({ hlc: undefined, ts: 100, value: { id: 'a' } });
    const b = op({ hlc: undefined, ts: 200, value: { id: 'b' } });
    expect(winnerId(lwwPick(a, b))).toBe('b');
  });
});
