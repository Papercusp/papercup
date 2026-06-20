/**
 * lwwPick HLC integration (D-003, locks-correctness-hardening-2026-06-04).
 *
 * The pure HLC primitives now live in `@papercusp/locks-core`; this test stays
 * with the federation adapter because it exercises `hyperbee/projection.lwwPick`
 * — the OpEnvelope tie-break that orders ops by HLC (with a wall-clock `ts`
 * fallback). It imports only the HLC encoder from the generic lib.
 */

import { describe, it, expect } from 'vitest';
import { encodeHlc } from '@papercusp/locks-core';
import { lwwPick } from '../hyperbee/projection';
import type { OpEnvelope } from '../hyperbee/op-envelope-types';

describe('lwwPick HLC integration (D-003)', () => {
  const op = (over: Partial<OpEnvelope>): OpEnvelope => ({ type: 'put', ...over });
  const enc = (ms: number, count: number) => encodeHlc({ ms, count });

  it('orders by HLC when both ops carry one — overriding a misleading wall-clock ts', () => {
    // a has a LOWER ts but a HIGHER hlc (e.g. its wall clock lagged): HLC wins.
    const a = op({ ts: 10, hlc: enc(2000, 0) });
    const b = op({ ts: 9999, hlc: enc(1000, 0) });
    expect(lwwPick(a, b)).toBe(a);
    expect(lwwPick(b, a)).toBe(a);
  });

  it('breaks an HLC tie by del-beats-put then sourceLogKeyHex', () => {
    const sameHlc = enc(1000, 3);
    const put = op({ type: 'put', hlc: sameHlc, sourceLogKeyHex: 'zzz' });
    const del = op({ type: 'del', hlc: sameHlc, sourceLogKeyHex: 'aaa' });
    expect(lwwPick(put, del)).toBe(del); // del beats put on a tie
    const p1 = op({ type: 'put', hlc: sameHlc, sourceLogKeyHex: 'aaa' });
    const p2 = op({ type: 'put', hlc: sameHlc, sourceLogKeyHex: 'zzz' });
    expect(lwwPick(p1, p2)).toBe(p2); // greater sourceLogKeyHex wins
    expect(lwwPick(p2, p1)).toBe(p2); // order-independent
  });

  it('derives a comparable key from ts for a no-HLC op (EI-1698 total order; back-compat)', () => {
    // Two no-HLC ops still compare by ts (each derives key = encodeHlc(ts, 0)).
    const a = op({ ts: 100 });
    const b = op({ ts: 200 });
    expect(lwwPick(a, b)).toBe(b);
    // Mixed: EI-1698 made the order TOTAL — every op gets ONE comparable key
    // (`op.hlc ?? encodeHlc({ms: ts, count: 0})`), so an HLC op with a higher HLC
    // wins even over a no-HLC op with a higher wall-clock ts. (Pre-EI-1698 this
    // fell back to ts and returned `d`, which switched basis per pair → the
    // NON-TRANSITIVE mixed-HLC bug.) Production-safe: a real no-HLC op is
    // pre-P-010 = OLDEST ts, so its derived key is lowest and it loses just as the
    // ts-fallback gave; only this adversarial synthetic case (a no-HLC ts ABOVE an
    // HLC op's ts) flips — and it flips to the transitive answer.
    const c = op({ ts: 100, hlc: enc(9999, 0) });
    const d = op({ ts: 200 });
    expect(lwwPick(c, d)).toBe(c); // c.hlc=enc(9999) beats d's derived enc(200)
  });
});
