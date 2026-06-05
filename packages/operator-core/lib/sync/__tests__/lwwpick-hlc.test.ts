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

  it('falls back to ts when either op lacks an HLC (back-compat)', () => {
    const a = op({ ts: 100 });
    const b = op({ ts: 200 });
    expect(lwwPick(a, b)).toBe(b);
    // Mixed: only one has hlc → ts path (additive rollout safety).
    const c = op({ ts: 100, hlc: enc(9999, 0) });
    const d = op({ ts: 200 });
    expect(lwwPick(c, d)).toBe(d); // ts 200 > 100, hlc ignored because d has none
  });
});
