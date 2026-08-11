import { describe, it, expect } from 'vitest';
import {
  armedColor,
  countProcessBuckets,
  fmtAge,
  fmtArmed,
  fmtBytes,
  fmtCpu,
  processBucket,
  stateColor,
  TASK_KINDS,
} from './TasksClient';

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

  it('does NOT alarm on ended_unobserved — a routine shutdown nobody watched, not an escape (D-018)', () => {
    // ended_unobserved is systemd-confirmed clean; sharing `--bad`/`--warn` with
    // stranded (the escape/anomaly class) would re-create the exact noise D-018
    // exists to eliminate.
    expect(stateColor('ended_unobserved')).not.toBe(stateColor('unaccounted'));
    expect(stateColor('ended_unobserved')).not.toBe(stateColor('stranded'));
  });
});

describe('fmtArmed (P-019)', () => {
  it('renders THREE outcomes, because `armed` has three values', () => {
    // `armed: null` means NOT APPLICABLE OR UNREACHABLE, never "off" (WI-6447). The
    // filed defect is `armed !== false`, which reports a timer whose state could not be
    // read as armed — and on this pane the reader's next move after "armed" is to stop
    // looking, so the false-confident direction is the expensive one.
    expect(fmtArmed(null, true)).toBe('unknown');
    expect(fmtArmed(false, true)).toBe('disarmed');
    expect(fmtArmed(true, true)).toBe('armed');
  });

  it('marks an UNFEDERATED armed row as declared, not measured', () => {
    // An unfederated row's armed flag came from a static manifest, not from asking the
    // process that owns the timer. The repo convention is to read `federated` before
    // trusting fire-state; this is that convention made visible in the cell.
    expect(fmtArmed(true, false)).toBe('armed (declared)');
    expect(fmtArmed(true, false)).not.toBe(fmtArmed(true, true));
  });

  it('does not let federation dress up a disarmed or unknown row', () => {
    // Federation qualifies a POSITIVE claim. It must not change what we say about a
    // row that is off or unreachable.
    expect(fmtArmed(false, false)).toBe(fmtArmed(false, true));
    expect(fmtArmed(null, false)).toBe(fmtArmed(null, true));
  });
});

describe('armedColor (P-019)', () => {
  it('never paints UNKNOWN with the good colour', () => {
    // A grey unknown and a green armed must not be confusable at a glance — that is
    // the whole reason the null is preserved through the projection.
    expect(armedColor(null)).not.toBe(armedColor(true));
    expect(armedColor(false)).not.toBe(armedColor(true));
  });
});

describe('TASK_KINDS', () => {
  it('offers both kinds plus the combined default', () => {
    // The pane's claim is that it is a task manager, not a process manager — so
    // `recurring` must be reachable, and `all` is what makes that the default posture.
    expect([...TASK_KINDS]).toEqual(['all', 'running', 'recurring']);
  });
});

describe('process provenance', () => {
  it('keeps managed, unaccounted, closed-window, and exempt lifetimes distinct', () => {
    expect(processBucket({ owned: true, scope: 'owned' })).toBe('managed');
    expect(processBucket({ owned: false, scope: 'unaccounted' })).toBe('unaccounted');
    expect(processBucket({ owned: false, scope: 'abandoned-window' })).toBe('abandoned-window');
    expect(processBucket({ owned: false, scope: 'exempt' })).toBe('exempt');
  });

  it('fails an older payload with no scope discriminant toward visibility', () => {
    expect(processBucket({ owned: false, scope: undefined })).toBe('unaccounted');
  });

  it('counts each public classification without flattening every non-owned row into a gap', () => {
    const rows = [
      { pid: 1, cmdline: 'a', cgroupPath: '/a', owned: true, scope: 'owned', exemptReason: null },
      { pid: 2, cmdline: 'b', cgroupPath: '/b', owned: false, scope: 'unaccounted', exemptReason: null },
      { pid: 3, cmdline: 'c', cgroupPath: '/c', owned: false, scope: 'abandoned-window', exemptReason: null },
      { pid: 4, cmdline: 'd', cgroupPath: '/d', owned: false, scope: 'exempt', exemptReason: 'human-terminal' },
    ] as const;

    expect(countProcessBuckets(rows)).toEqual({
      managed: 1,
      unaccounted: 1,
      'abandoned-window': 1,
      exempt: 1,
    });
  });
});
