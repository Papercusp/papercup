import { describe, expect, it } from 'vitest';
import {
  appendResidueSample,
  censusTerminalResidue,
  cgroupWindowProtects,
  evaluateResidueTrend,
  isPidInLiveWindowScope,
  resolveTerminalSliceAbs,
  type ResidueSample,
} from './terminal-residue-census';
import { parseResidueSamples } from './terminal-residue-store';
import type { CgroupFs } from './cgroup-read';

const ROOT = '/sys/fs/cgroup';
const TERM = `${ROOT}/user.slice/user-1000.slice/user@1000.service/app.slice/app-org.gnome.Terminal.slice`;

const SERVER = 500;
const USER_MANAGER = 2026497;

/** Mirrors terminal-window.test.ts's fake so the two agree on /proc shape. */
function box(opts: {
  children: Record<string, number[]>;
  ppids: Record<number, number>;
  unreadableScopes?: string[];
}): CgroupFs {
  const files: Record<string, string> = {};
  const dirs = new Set<string>([TERM]);

  for (const [name, pids] of Object.entries(opts.children)) {
    const abs = `${TERM}/${name}`;
    dirs.add(abs);
    if (!opts.unreadableScopes?.includes(name)) files[`${abs}/cgroup.procs`] = pids.join('\n');
  }
  for (const [pid, ppid] of Object.entries(opts.ppids)) {
    files[`/proc/${pid}/stat`] =
      `${pid} (node) S ${ppid} 1 1 0 -1 0 0 0 0 0 1 2 0 0 20 0 1 0 12345 0 0`;
  }

  return {
    readFile: (p) => files[p] ?? null,
    isDir: (p) => dirs.has(p),
    readDir: (p) => {
      const out = new Set<string>();
      for (const d of dirs) {
        if (d.startsWith(`${p}/`)) out.add(d.slice(p.length + 1).split('/')[0]!);
      }
      return [...out];
    },
  };
}

const scope = (n: number) => `vte-spawn-0000000${n}-0000-0000-0000-000000000000.scope`;

describe('censusTerminalResidue', () => {
  it('counts a scope whose window is gone, and leaves live ones alone', () => {
    const fs = box({
      children: {
        'gnome-terminal-server.service': [SERVER],
        [scope(1)]: [1001], // child of the server -> window ALIVE
        [scope(2)]: [2001, 2002], // orphaned onto the user manager -> window DEAD
      },
      ppids: { [SERVER]: 1, 1001: SERVER, 2001: USER_MANAGER, 2002: USER_MANAGER },
    });

    const c = censusTerminalResidue(TERM, fs);

    expect(c.scopesTotal).toBe(2);
    expect(c.scopesDead).toBe(1);
    expect(c.deadPids).toBe(2);
    expect(c.unprobeable).toBe(0);
    expect(c.dead).toEqual([{ scope: scope(2), pidCount: 2 }]);
  });

  it('never counts an undecidable scope as dead — unknown is not dead', () => {
    const fs = box({
      children: {
        'gnome-terminal-server.service': [SERVER],
        [scope(1)]: [1001],
        [scope(2)]: [2001],
      },
      // no /proc entry for 2001 at all -> probe observes nothing -> null
      ppids: { [SERVER]: 1, 1001: SERVER },
      unreadableScopes: [],
    });

    const c = censusTerminalResidue(TERM, fs);

    expect(c.scopesDead).toBe(0);
    expect(c.unprobeable).toBe(1);
  });

  it('ignores non-window units in the slice', () => {
    const fs = box({
      children: {
        'gnome-terminal-server.service': [SERVER],
        'something-else.service': [9001],
        [scope(1)]: [2001],
      },
      ppids: { [SERVER]: 1, 9001: 1, 2001: USER_MANAGER },
    });

    const c = censusTerminalResidue(TERM, fs);
    expect(c.scopesTotal).toBe(1);
    expect(c.scopesDead).toBe(1);
  });

  it('is immune to cmdline — the filter that blinds the scan (D-017)', () => {
    // The probe reads only cgroup.procs + /proc/<pid>/stat. No cmdline is
    // provided by the fake at all, and the census still sees the residue. This is
    // the whole reason P-013 does not build on summary.unaccounted.
    const fs = box({
      children: {
        'gnome-terminal-server.service': [SERVER],
        [scope(1)]: [2001, 2002, 2003],
      },
      ppids: { [SERVER]: 1, 2001: USER_MANAGER, 2002: USER_MANAGER, 2003: USER_MANAGER },
    });

    const c = censusTerminalResidue(TERM, fs);
    expect(c.scopesDead).toBe(1);
    expect(c.deadPids).toBe(3);
  });
});

describe('evaluateResidueTrend', () => {
  const HOUR = 60 * 60_000;
  const DAY = 24 * HOUR;
  const now = 10 * DAY;

  const at = (daysAgo: number, scopesDead: number): ResidueSample => ({
    atMs: now - daysAgo * DAY,
    scopesDead,
  });

  it('flags a rising FLOOR as accumulation', () => {
    const samples = [
      at(6, 3),
      at(5, 4),
      at(4, 3),
      // recent window (<24h)
      { atMs: now - 3 * HOUR, scopesDead: 9 },
      { atMs: now - 2 * HOUR, scopesDead: 11 },
      { atMs: now - 1 * HOUR, scopesDead: 10 },
    ];

    const v = evaluateResidueTrend(samples, { nowMs: now });

    expect(v.trend).toBe('rising');
    expect(v.olderFloor).toBe(3);
    expect(v.recentFloor).toBe(9);
    expect(v.floorDelta).toBe(6);
    expect(v.alarm).toBe(true);
  });

  it('does NOT fire on churn — a moving peak over a flat floor', () => {
    // Windows opening and closing all day swing the max wildly; the floor is what
    // says whether anything is actually stuck. This is the false-positive D-016
    // measured at ~93% for a level-based alarm.
    const samples = [
      at(6, 2),
      at(5, 40),
      at(4, 3),
      { atMs: now - 3 * HOUR, scopesDead: 38 },
      { atMs: now - 2 * HOUR, scopesDead: 2 },
      { atMs: now - 1 * HOUR, scopesDead: 45 },
    ];

    const v = evaluateResidueTrend(samples, { nowMs: now });

    expect(v.trend).toBe('steady');
    expect(v.alarm).toBe(false);
  });

  it('reports falling when residue is being cleared', () => {
    const samples = [
      at(6, 12),
      at(5, 14),
      at(4, 13),
      { atMs: now - 3 * HOUR, scopesDead: 2 },
      { atMs: now - 2 * HOUR, scopesDead: 3 },
      { atMs: now - 1 * HOUR, scopesDead: 2 },
    ];

    const v = evaluateResidueTrend(samples, { nowMs: now });

    expect(v.trend).toBe('falling');
    expect(v.alarm).toBe(false);
  });

  it('says UNKNOWN rather than healthy when history is too thin', () => {
    const v = evaluateResidueTrend(
      [{ atMs: now - HOUR, scopesDead: 30 }],
      { nowMs: now },
    );

    expect(v.trend).toBe('unknown');
    expect(v.alarm).toBe(false);
    expect(v.summary).toMatch(/not the same as healthy/);
  });

  it('ignores samples older than the lookback', () => {
    const samples = [
      at(90, 0), // ancient, outside lookback — must not become the older floor
      at(6, 8),
      at(5, 9),
      at(4, 8),
      { atMs: now - 3 * HOUR, scopesDead: 9 },
      { atMs: now - 2 * HOUR, scopesDead: 10 },
      { atMs: now - 1 * HOUR, scopesDead: 9 },
    ];

    const v = evaluateResidueTrend(samples, { nowMs: now });

    expect(v.olderFloor).toBe(8);
    expect(v.trend).toBe('steady');
  });

  it('treats an unreadable store ([]) as unknown, never as healthy', () => {
    // readResidueSamples returns [] on ANY failure. If that rendered as 'steady'
    // a storage outage would look exactly like "no accumulation" — the laundering
    // shape D-017 is about.
    const v = evaluateResidueTrend([], { nowMs: now });
    expect(v.trend).toBe('unknown');
    expect(v.alarm).toBe(false);
  });

  it('models the 16-day silent accumulation this indicator exists to catch', () => {
    // One scope leaks per day and nothing clears it. No single day looks alarming,
    // which is exactly why a level alarm never fired.
    const samples: ResidueSample[] = [];
    for (let d = 16; d >= 0; d--) {
      samples.push({ atMs: now - d * DAY, scopesDead: 16 - d });
    }
    // enough recent samples to satisfy the floor comparison
    samples.push({ atMs: now - 2 * HOUR, scopesDead: 16 });
    samples.push({ atMs: now - 1 * HOUR, scopesDead: 16 });

    const v = evaluateResidueTrend(samples, { nowMs: now });

    expect(v.trend).toBe('rising');
    expect(v.alarm).toBe(true);
  });
});

describe('isPidInLiveWindowScope / cgroupWindowProtects (P-012 / D-019)', () => {
  /** box() + a /proc/<pid>/cgroup pointing the pid at one of its scopes. */
  const boxWithCgroup = (
    opts: Parameters<typeof box>[0] & { cgroupOf: Record<number, string> },
  ): CgroupFs => {
    const inner = box(opts);
    return {
      ...inner,
      readFile: (p) => {
        const m = /^\/proc\/(\d+)\/cgroup$/.exec(p);
        if (m) {
          const rel = opts.cgroupOf[Number(m[1])];
          return rel ? `0::${rel}\n` : null;
        }
        return inner.readFile(p);
      },
    };
  };

  const rel = (name: string) =>
    `/user.slice/user-1000.slice/user@1000.service/app.slice/app-org.gnome.Terminal.slice/${name}`;

  it('reports alive for a pid inside a live window', () => {
    const fs = boxWithCgroup({
      children: { 'gnome-terminal-server.service': [SERVER], [scope(1)]: [1001] },
      ppids: { [SERVER]: 1, 1001: SERVER },
      cgroupOf: { 1001: rel(scope(1)) },
    });
    expect(isPidInLiveWindowScope(1001, fs)).toBe('alive');
  });

  it('reports dead for a pid whose window is gone', () => {
    const fs = boxWithCgroup({
      children: { 'gnome-terminal-server.service': [SERVER], [scope(2)]: [2001] },
      ppids: { [SERVER]: 1, 2001: USER_MANAGER },
      cgroupOf: { 2001: rel(scope(2)) },
    });
    expect(isPidInLiveWindowScope(2001, fs)).toBe('dead');
  });

  it('reports unknown for a REAL window scope it cannot decide', () => {
    // A window scope whose members have no readable /proc entry. This is the case
    // the reaper's wmctrl leg gets wrong (empty ⇒ unprotected ⇒ kill).
    const fs = boxWithCgroup({
      children: { 'gnome-terminal-server.service': [SERVER], [scope(3)]: [3001] },
      ppids: { [SERVER]: 1 }, // no /proc/3001/stat
      cgroupOf: { 3001: rel(scope(3)) },
    });
    expect(isPidInLiveWindowScope(3001, fs)).toBe('unknown');
  });

  it('distinguishes not-a-window from unknown — collapsing them disables the reaper', () => {
    const fs = boxWithCgroup({
      children: { 'gnome-terminal-server.service': [SERVER] },
      ppids: { [SERVER]: 1 },
      cgroupOf: { 4242: '/system.slice/papercup-bg-host.service' },
    });
    expect(isPidInLiveWindowScope(4242, fs)).toBe('not-a-window');
    // unreadable /proc is likewise "no opinion", never a window verdict
    expect(isPidInLiveWindowScope(9999, fs)).toBe('not-a-window');
  });

  it('PROTECTS on alive and unknown, never on dead or not-a-window (D-019 polarity)', () => {
    // The reaper's existing wmctrl protection fails toward KILLING (an empty set
    // protects nobody); this leg must fail toward SPARING for a real window,
    // matching classifyScope's "unknown stays exempt" — while staying strictly
    // additive, so a non-window session is left to the existing rules.
    expect(cgroupWindowProtects('alive')).toBe(true);
    expect(cgroupWindowProtects('unknown')).toBe(true);
    expect(cgroupWindowProtects('dead')).toBe(false);
    expect(cgroupWindowProtects('not-a-window')).toBe(false);
  });
});

describe('resolveTerminalSliceAbs', () => {
  it('resolves the terminal slice under the user manager root', () => {
    expect(resolveTerminalSliceAbs('/user.slice/user-1000.slice/user@1000.service')).toBe(
      `${ROOT}/user.slice/user-1000.slice/user@1000.service/app.slice/app-org.gnome.Terminal.slice`,
    );
  });

  it('is null when there is no user manager root, rather than guessing a path', () => {
    expect(resolveTerminalSliceAbs(null)).toBeNull();
  });

  it('targets the Terminal slice, NOT app.slice (the too-wide probe reads everything as alive)', () => {
    const abs = resolveTerminalSliceAbs('/user.slice/user-1000.slice/user@1000.service')!;
    expect(abs.endsWith('/app-org.gnome.Terminal.slice')).toBe(true);
  });
});

describe('appendResidueSample', () => {
  const HOUR = 60 * 60_000;
  const DAY = 24 * HOUR;

  it('appends and keeps chronological order', () => {
    const ring = appendResidueSample(
      [{ atMs: 1000, scopesDead: 1 }],
      { atMs: 2000, scopesDead: 2 },
    );
    expect(ring).toEqual([
      { atMs: 1000, scopesDead: 1 },
      { atMs: 2000, scopesDead: 2 },
    ]);
  });

  it('prunes samples older than the retention window', () => {
    const now = 100 * DAY;
    const ring = appendResidueSample(
      [
        { atMs: now - 60 * DAY, scopesDead: 99 }, // way outside default 21d
        { atMs: now - 2 * DAY, scopesDead: 5 },
      ],
      { atMs: now, scopesDead: 6 },
    );
    expect(ring.map((s) => s.scopesDead)).toEqual([5, 6]);
  });

  it('retains LONGER than the trend lookback, so both windows can be populated', () => {
    // Default retention (21d) must exceed the default trend lookback (7d),
    // otherwise the older comparison window is always empty and the verdict is
    // permanently 'unknown'.
    const now = 100 * DAY;
    const ring = appendResidueSample(
      [{ atMs: now - 10 * DAY, scopesDead: 3 }],
      { atMs: now, scopesDead: 4 },
    );
    expect(ring).toHaveLength(2);
  });

  it('caps ring length', () => {
    const now = 100 * DAY;
    const existing = Array.from({ length: 10 }, (_, i) => ({
      atMs: now - (10 - i) * HOUR,
      scopesDead: i,
    }));
    const ring = appendResidueSample(existing, { atMs: now, scopesDead: 42 }, { maxSamples: 5 });
    expect(ring).toHaveLength(5);
    expect(ring[ring.length - 1]).toEqual({ atMs: now, scopesDead: 42 });
  });
});

describe('parseResidueSamples', () => {
  it('reads a well-formed ring', () => {
    expect(parseResidueSamples([{ atMs: 2, scopesDead: 1 }, { atMs: 1, scopesDead: 0 }])).toEqual([
      { atMs: 1, scopesDead: 0 },
      { atMs: 2, scopesDead: 1 },
    ]);
  });

  it('discards malformed entries instead of throwing', () => {
    expect(
      parseResidueSamples([
        { atMs: 1, scopesDead: 2 },
        null,
        'nope',
        { atMs: 'x', scopesDead: 1 },
        { atMs: 3 },
        { atMs: Number.NaN, scopesDead: 1 },
      ]),
    ).toEqual([{ atMs: 1, scopesDead: 2 }]);
  });

  it('reads a non-array (absent key, wrong shape) as empty', () => {
    expect(parseResidueSamples(undefined)).toEqual([]);
    expect(parseResidueSamples({})).toEqual([]);
  });
});
