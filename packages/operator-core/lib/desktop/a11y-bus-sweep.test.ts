import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MIN_AGE_SEC,
  parseA11yConfDir,
  parseDisplayFromEnviron,
  selectStaleBuses,
  type A11yBusProcess,
} from './a11y-bus-sweep';

const HOUR = 3600;

function bus(over: Partial<A11yBusProcess> = {}): A11yBusProcess {
  return {
    pid: 1234,
    confDir: '/tmp/pcv/pc-a11y-abc123',
    display: ':110',
    ageSec: 77 * HOUR,
    ...over,
  };
}

describe('selectStaleBuses', () => {
  it('reaps a bus whose display is gone and which is past the age margin', () => {
    const { reap, keep } = selectStaleBuses([bus()], { liveDisplays: new Set([':111']) });
    expect(reap.map((p) => p.pid)).toEqual([1234]);
    expect(keep).toEqual([]);
  });

  it('never reaps a bus whose display is still live, however old it is', () => {
    const { reap, keep } = selectStaleBuses([bus({ ageSec: 1000 * HOUR })], {
      liveDisplays: new Set([':110']),
    });
    expect(reap).toEqual([]);
    expect(keep[0]?.reason).toBe('display-live');
  });

  it('never reaps a young bus — this is the mid-provision race guard', () => {
    const { reap, keep } = selectStaleBuses([bus({ ageSec: 30 })], { liveDisplays: new Set() });
    expect(reap).toEqual([]);
    expect(keep[0]?.reason).toBe('too-young');
  });

  it('never reaps a bus whose display could not be read', () => {
    // An unreadable /proc entry must be indistinguishable from a live one, not
    // from garbage: this asymmetry is what keeps the sweep off live work.
    const { reap, keep } = selectStaleBuses([bus({ display: null })], { liveDisplays: new Set() });
    expect(reap).toEqual([]);
    expect(keep[0]?.reason).toBe('display-unknown');
  });

  it('partitions a mixed population without dropping any process', () => {
    const procs = [
      bus({ pid: 1, display: ':110', ageSec: 77 * HOUR }), // reap
      bus({ pid: 2, display: ':111', ageSec: 77 * HOUR }), // live display
      bus({ pid: 3, display: ':112', ageSec: 60 }), // too young
      bus({ pid: 4, display: null, ageSec: 77 * HOUR }), // unknown
    ];
    const { reap, keep } = selectStaleBuses(procs, { liveDisplays: new Set([':111']) });
    expect(reap.map((p) => p.pid)).toEqual([1]);
    expect(keep.map((k) => k.proc.pid).sort()).toEqual([2, 3, 4]);
    expect(reap.length + keep.length).toBe(procs.length);
  });

  it('honours an explicit minAgeSec over the default', () => {
    const procs = [bus({ ageSec: 2 * HOUR })];
    expect(selectStaleBuses(procs, { liveDisplays: new Set() }).reap).toEqual([]);
    expect(
      selectStaleBuses(procs, { liveDisplays: new Set(), minAgeSec: HOUR }).reap.map((p) => p.pid),
    ).toEqual([1234]);
  });

  it('defaults the age margin to six hours', () => {
    expect(DEFAULT_MIN_AGE_SEC).toBe(6 * HOUR);
  });
});

describe('parseA11yConfDir — it must not match a foreign dbus', () => {
  it('extracts our own session bus directory', () => {
    // Verbatim from a leaked daemon measured on the box 2026-08-23.
    const cmdline = 'dbus-daemon --config-file=/tmp/pcv/pc-a11y-kKnq4Y/session.conf --fork --print-address';
    expect(parseA11yConfDir(cmdline)).toBe('/tmp/pcv/pc-a11y-kKnq4Y');
  });

  it.each([
    ['the host accessibility bus', '/usr/bin/dbus-daemon --config-file=/usr/share/defaults/at-spi2/accessibility.conf --nofork --print-address 11'],
    ['a real login session bus', '/usr/bin/dbus-daemon --session --address=systemd: --nofork --systemd-activation'],
    ['a system bus', '/usr/bin/dbus-daemon --system --address=systemd: --nofork'],
    ['a lookalike path that is not ours', 'dbus-daemon --config-file=/tmp/pcv/pc-a11yX/session.conf --fork'],
  ])('returns null for %s', (_label, cmdline) => {
    expect(parseA11yConfDir(cmdline)).toBeNull();
  });
});

describe('parseDisplayFromEnviron', () => {
  it('reads DISPLAY out of a NUL-separated environ blob', () => {
    expect(parseDisplayFromEnviron('PATH=/usr/bin\0DISPLAY=:110\0HOME=/root\0')).toBe(':110');
  });

  it('returns null when DISPLAY is absent or empty', () => {
    expect(parseDisplayFromEnviron('PATH=/usr/bin\0HOME=/root\0')).toBeNull();
    expect(parseDisplayFromEnviron('DISPLAY=\0')).toBeNull();
  });

  it('does not match a variable that merely ends in DISPLAY', () => {
    expect(parseDisplayFromEnviron('WAYLAND_DISPLAY=wayland-0\0')).toBeNull();
  });
});
