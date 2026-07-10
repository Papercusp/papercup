import { describe, it, expect } from 'vitest';
import { parseSwapPages, computeHostHealth } from './runner';

describe('parseSwapPages (EI-9145)', () => {
  it('parses pswpin/pswpout out of a real /proc/vmstat shape', () => {
    const text = ['nr_free_pages 12345', 'pswpin 200', 'pswpout 900', 'pgpgin 55555'].join('\n');
    expect(parseSwapPages(text)).toEqual({ pswpin: 200, pswpout: 900 });
  });

  it('returns null when the fields are missing (non-Linux / unexpected shape)', () => {
    expect(parseSwapPages('nr_free_pages 12345\npgpgin 55555')).toBeNull();
  });

  it('returns null on empty input', () => {
    expect(parseSwapPages('')).toBeNull();
  });
});

describe('computeHostHealth (EI-9145 + EI-8843)', () => {
  it('neither CPU nor swap confound ⇒ not oversubscribed', () => {
    expect(computeHostHealth({ ratio1m: 0.4, swapPagesDelta: 10 })).toEqual({
      oversubscribed: false,
      swapping: false,
    });
  });

  it('CPU ratio over the limit alone ⇒ oversubscribed, not swapping', () => {
    expect(computeHostHealth({ ratio1m: 1.5, swapPagesDelta: 0 })).toEqual({
      oversubscribed: true,
      swapping: false,
    });
  });

  it('swap delta over the threshold alone (low CPU ratio) ⇒ oversubscribed via swapping — the EI-9087 case', () => {
    // Reproduces the observed 2026-07-10 pattern: CPU ratio back near 1x
    // (1.13, just over the CPU-only limit is irrelevant here) but heavy
    // swap I/O during the run window should still flag it.
    expect(computeHostHealth({ ratio1m: 0.9, swapPagesDelta: 50_000 })).toEqual({
      oversubscribed: true,
      swapping: true,
    });
  });

  it('null swapPagesDelta (non-Linux / sample failure) never itself triggers swapping', () => {
    expect(computeHostHealth({ ratio1m: 0.5, swapPagesDelta: null })).toEqual({
      oversubscribed: false,
      swapping: false,
    });
  });

  it('both confounds ⇒ oversubscribed AND swapping true', () => {
    expect(computeHostHealth({ ratio1m: 1.6, swapPagesDelta: 100_000 })).toEqual({
      oversubscribed: true,
      swapping: true,
    });
  });

  it('delta exactly at the threshold is NOT swapping (strictly greater-than)', () => {
    expect(computeHostHealth({ ratio1m: 0.5, swapPagesDelta: 1000 })).toEqual({
      oversubscribed: false,
      swapping: false,
    });
  });
});
