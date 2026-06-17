import { describe, expect, it } from 'vitest';
import { applyGainPcm16 } from './gain';

describe('applyGainPcm16', () => {
  // S2: unity gain is an identity FAST PATH — it returns the SAME frame instance
  // (no copy), so callers must not assume a fresh buffer at gain === 1.
  it('gain === 1 is pass-through and returns the same instance', () => {
    const frame = Int16Array.of(1, -2, 32767, -32768);
    expect(applyGainPcm16(frame, 1)).toBe(frame);
  });

  // S2: gain 0 zeroes every sample.
  it('gain 0 produces all zeros', () => {
    const out = applyGainPcm16(Int16Array.of(100, -200, 32767, -32768), 0);
    expect(Array.from(out)).toEqual([0, 0, 0, 0]);
  });

  // S2: clamp on negative-gain overflow — negating the most-negative sample
  // (-32768) yields +32768, one past the int16 max, and must clamp to 32767.
  it('clamps the +overflow from negating the min sample (gain -1 on -32768)', () => {
    const out = applyGainPcm16(Int16Array.of(-32768), -1);
    expect(out[0]).toBe(32767);
  });

  // S2: symmetric clamp at the low rail — a large positive gain that pushes a
  // sample below -32768 clamps to -32768.
  it('clamps below the int16 min to -32768', () => {
    const out = applyGainPcm16(Int16Array.of(-20000), 4);
    expect(out[0]).toBe(-32768);
  });

  // S2: NaN gain coerces every sample to 0 via the `v | 0` cast (NaN passes
  // neither clamp branch, then `NaN | 0 === 0`). Pinned so the coercion path is
  // explicit, not incidental.
  it('gain NaN coerces all samples to 0', () => {
    const out = applyGainPcm16(Int16Array.of(1000, -1000, 32767), NaN);
    expect(Array.from(out)).toEqual([0, 0, 0]);
  });

  // S2: in-range scaling truncates toward zero (the `v | 0` cast), NOT rounding.
  it('truncates toward zero (no rounding) within range', () => {
    // 3 * 0.5 = 1.5 → 1 ; -3 * 0.5 = -1.5 → -1
    const out = applyGainPcm16(Int16Array.of(3, -3), 0.5);
    expect(Array.from(out)).toEqual([1, -1]);
  });

  it('empty frame yields an empty frame', () => {
    const out = applyGainPcm16(new Int16Array(0), 0.5);
    expect(out.length).toBe(0);
  });
});
