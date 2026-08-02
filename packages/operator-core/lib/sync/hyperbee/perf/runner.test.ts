import { describe, it, expect } from 'vitest';
import { parseSwapPages, computeHostHealth, parsePsiSome } from './runner';

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

describe('parsePsiSome (EI-19301664378023382)', () => {
  it('parses avg10/avg60 out of a real /proc/pressure/memory shape', () => {
    const text = [
      'some avg10=0.03 avg60=5.07 avg300=8.22 total=47076542478',
      'full avg10=0.02 avg60=4.25 avg300=6.55 total=39585873377',
    ].join('\n');
    expect(parsePsiSome(text)).toEqual({ avg10: 0.03, avg60: 5.07 });
  });

  it('parses a real /proc/pressure/cpu shape (no "full" line — cpu PSI has none)', () => {
    const text = 'some avg10=0.79 avg60=1.15 avg300=1.44 total=65889176130';
    expect(parsePsiSome(text)).toEqual({ avg10: 0.79, avg60: 1.15 });
  });

  it('returns null when there is no "some" line (non-Linux / unexpected shape)', () => {
    expect(parsePsiSome('full avg10=0.00 avg60=0.00 avg300=0.00 total=0')).toBeNull();
  });

  it('returns null on empty input', () => {
    expect(parsePsiSome('')).toBeNull();
  });

  it('reproduces the 2026-08-02 audit finding: low PSI alongside a high swap-page-delta', () => {
    // EI-19301664378023382's measured mismatch: the runner's swap-delta confound fired
    // "oversubscribed" (deltas of 2,394,052 and 259,671 pages, both ≫ the 1000-page
    // threshold) while a same-moment PSI memory check showed avg60 ~5%, avg10 ~0% —
    // i.e. the kernel's own stall-time accounting did not show sustained thrashing.
    // This test just pins the PARSE of that exact measured line; the composite
    // decision of whether to weigh it is left to the reader of the report/log,
    // deliberately NOT re-wired into computeHostHealth (see runner.ts's rationale).
    const text = 'some avg10=0.00 avg60=5.07 avg300=8.22 total=47076542478';
    expect(parsePsiSome(text)).toEqual({ avg10: 0, avg60: 5.07 });
  });
});
