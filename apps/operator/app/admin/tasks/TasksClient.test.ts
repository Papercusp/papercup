import { describe, it, expect } from 'vitest';
import { fmtBytes, fmtCpu, fmtAge, stateColor } from './TasksClient';

describe('fmtBytes', () => {
  it('scales through the units', () => {
    expect(fmtBytes(512)).toBe('512 B');
    expect(fmtBytes(2048)).toBe('2.0 KB');
    expect(fmtBytes(5 * 1024 * 1024)).toBe('5.0 MB');
    // A real reading sampled off this box's operator scope — 7247708160 is just
    // under 6.75 GiB, so it rounds DOWN. Kept as a live-derived value rather than a
    // tidy power of two precisely because that is the arithmetic that bites.
    expect(fmtBytes(7_247_708_160)).toBe('6.7 GB');
  });

  it('drops the decimal once the number is big enough not to need it', () => {
    expect(fmtBytes(50 * 1024 * 1024)).toBe('50 MB');
  });

  it('renders UNKNOWN as an em-dash, never as 0', () => {
    // A fabricated 0 reads as a real measurement in a pane whose entire job is
    // telling you what is eating the box. The whole read path preserves this
    // distinction from the cgroup parser upward; the formatter is the last hop.
    expect(fmtBytes(null)).toBe('—');
    expect(fmtBytes(0)).toBe('0 B');
  });
});

describe('fmtCpu', () => {
  it('uses ms below a second and seconds above', () => {
    expect(fmtCpu(123_456)).toBe('123 ms');
    expect(fmtCpu(7_847_165_841)).toBe('7847 s');
  });

  it('renders unknown as an em-dash', () => {
    expect(fmtCpu(null)).toBe('—');
  });
});

describe('fmtAge', () => {
  it('scales seconds → minutes → hours → days', () => {
    const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
    expect(fmtAge(ago(5_000))).toBe('5s');
    expect(fmtAge(ago(5 * 60_000))).toBe('5m');
    expect(fmtAge(ago(3 * 3600_000 + 20 * 60_000))).toBe('3h 20m');
    expect(fmtAge(ago(2 * 86_400_000))).toBe('2d');
  });

  it('does not render a negative age from a clock skew', () => {
    expect(fmtAge(new Date(Date.now() + 60_000).toISOString())).toBe('0s');
  });

  it('renders an unparseable timestamp as an em-dash', () => {
    expect(fmtAge('not-a-date')).toBe('—');
  });
});

describe('stateColor', () => {
  it('makes `unaccounted` the loudest state', () => {
    // It is the one state on this pane that means something is WRONG rather than
    // merely busy — a process inside our slice that no chokepoint registered.
    // `--bad` is the operator's defined alarm token; the pane originally reached for
    // an undefined `--danger`, which the css-tokens lint (rightly) rejects — every
    // colour here must be a real, themeable token, not a fallback hex.
    expect(stateColor('unaccounted')).toBe('var(--bad)');
    expect(stateColor('running')).not.toBe(stateColor('unaccounted'));
  });

  it('distinguishes foreign (not ours) from running (ours)', () => {
    expect(stateColor('foreign')).not.toBe(stateColor('running'));
  });
});
