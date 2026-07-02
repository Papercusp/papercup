import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  parseWmctrlList,
  selectOnDesktopSessions,
  listOpenWindows,
  __resetDesktopLivenessCache,
  parseActiveWindowId,
  ownerOwnsWindow,
  parsePpidFromStat,
  pidHasWindowAncestor,
  windowOwningPids,
  type OpenWindow,
  type DesktopCandidateSession,
} from './desktop-window-liveness';
import { WINDOW_TITLE_PREFIX } from './windows-desktop-windows';

const listWindowsByTitleMock = vi.fn();

// Keep the real parseSessionIdFromWindowTitle/WINDOW_TITLE_PREFIX (desktop-window-
// liveness.ts's own matcher logic depends on them); only listWindowsByTitle — the
// IO seam — is mocked, so the win32 branch of listOpenWindows is unit-testable
// without a real powershell.exe.
vi.mock('./windows-desktop-windows', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./windows-desktop-windows')>();
  return { ...actual, listWindowsByTitle: (...args: unknown[]) => listWindowsByTitleMock(...args) };
});

const realPlatform = process.platform;

/** Override the read-only process.platform for one test. */
function setPlatform(p: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: p, configurable: true });
}

beforeEach(() => {
  __resetDesktopLivenessCache();
  listWindowsByTitleMock.mockReset();
  listWindowsByTitleMock.mockResolvedValue([]);
});

afterEach(() => {
  setPlatform(realPlatform);
});

describe('parseWmctrlList (pure wmctrl -lp parser)', () => {
  it('parses <wid> <desktop> <pid> <host> <title> lines, keeping the [adv:N] tag in the title', () => {
    const stdout = [
      '0x04200007  0 469879 thinkpad SH[adv:42]: my plan',
      '0x05000003  1 470001 thinkpad OMP[adv:7]: another',
    ].join('\n');
    const out = parseWmctrlList(stdout);
    expect(out).toEqual<OpenWindow[]>([
      { wid: '0x04200007', pid: 469879, title: 'SH[adv:42]: my plan' },
      { wid: '0x05000003', pid: 470001, title: 'OMP[adv:7]: another' },
    ]);
  });

  it('skips blank lines and lines without a 0x… window id', () => {
    const stdout = ['', '   ', 'garbage line no wid', '0x1 0 100 host title'].join('\n');
    expect(parseWmctrlList(stdout).map((w) => w.wid)).toEqual(['0x1']);
  });

  it('a non-numeric or zero pid maps to null (never a spurious 0/NaN match key)', () => {
    const out = parseWmctrlList(['0x1 0 0 host t', '0x2 0 notapid host t'].join('\n'));
    expect(out.map((w) => w.pid)).toEqual([null, null]);
  });

  it('preserves multi-word titles (collapsed whitespace is fine for tag matching)', () => {
    expect(parseWmctrlList('0x1 0 5 host a  b   c').slice(0, 1)[0].title).toContain('a b c');
  });
});

describe('selectOnDesktopSessions (pure match: which sessions have a live window)', () => {
  const win = (wid: string, pid: number | null, title = ''): OpenWindow => ({ wid, pid, title });
  const sess = (over: Partial<DesktopCandidateSession> & { advSessionId: number }): DesktopCandidateSession => ({
    coordOwnerId: null,
    sessionId: null,
    windowId: null,
    pid: null,
    ...over,
  });

  it('matches by recorded window_id (primary key)', () => {
    const sets = selectOnDesktopSessions(
      [sess({ advSessionId: 1, coordOwnerId: 'su-a', sessionId: 'uuid-a', windowId: '0xWID' })],
      [win('0xWID', 999)],
    );
    expect([...sets.owners]).toEqual(['su-a']);
    expect([...sets.sessionIds]).toEqual(['uuid-a']);
    expect([...sets.advSessionIds]).toEqual([1]);
  });

  it('matches by the [adv:<id>] window-title tag when window_id was not captured', () => {
    const sets = selectOnDesktopSessions(
      [sess({ advSessionId: 42, coordOwnerId: 'su-b', windowId: null, pid: null })],
      [win('0xZZ', 123, 'SH[adv:42]: working')],
    );
    expect([...sets.owners]).toEqual(['su-b']);
    expect([...sets.advSessionIds]).toEqual([42]);
  });

  it('matches by recorded pid (fallback for emulators whose window pid == launch pid)', () => {
    const sets = selectOnDesktopSessions(
      [sess({ advSessionId: 3, coordOwnerId: 'su-c', pid: 555 })],
      [win('0xWID', 555)],
    );
    expect([...sets.owners]).toEqual(['su-c']);
  });

  it('does NOT match a session whose window is closed (no wid/tag/pid hit)', () => {
    const sets = selectOnDesktopSessions(
      [sess({ advSessionId: 9, coordOwnerId: 'su-gone', windowId: '0xCLOSED', pid: 111 })],
      [win('0xOTHER', 222, 'SH[adv:8]: unrelated')],
    );
    expect(sets.owners.size).toBe(0);
    expect(sets.sessionIds.size).toBe(0);
    expect(sets.advSessionIds.size).toBe(0);
  });

  it('empty windows (headless box) or empty sessions → empty sets', () => {
    expect(selectOnDesktopSessions([sess({ advSessionId: 1, windowId: '0x1' })], []).owners.size).toBe(0);
    expect(selectOnDesktopSessions([], [win('0x1', 1)]).owners.size).toBe(0);
  });

  it('a matched session with null owner/sessionId still records its advSessionId (console row)', () => {
    const sets = selectOnDesktopSessions(
      [sess({ advSessionId: 5, coordOwnerId: null, sessionId: null, windowId: '0xW' })],
      [win('0xW', 1)],
    );
    expect(sets.owners.size).toBe(0);
    expect(sets.sessionIds.size).toBe(0);
    expect([...sets.advSessionIds]).toEqual([5]);
  });

  describe('Windows title-tag leg (P-019 — matches by `Papercup — <sessionId>`, not wid/pid)', () => {
    it('matches a session by its sessionId embedded in a window title, with no windowId/pid at all', () => {
      const sets = selectOnDesktopSessions(
        [sess({ advSessionId: 7, coordOwnerId: 'su-win', sessionId: 'native-uuid-1', windowId: null, pid: null })],
        [win('0xHWND', 4321, `${WINDOW_TITLE_PREFIX}native-uuid-1`)],
      );
      expect([...sets.owners]).toEqual(['su-win']);
      expect([...sets.sessionIds]).toEqual(['native-uuid-1']);
      expect([...sets.advSessionIds]).toEqual([7]);
    });

    it('does not match when the title carries a DIFFERENT sessionId', () => {
      const sets = selectOnDesktopSessions(
        [sess({ advSessionId: 8, coordOwnerId: 'su-other', sessionId: 'native-uuid-2' })],
        [win('0xHWND', 1, `${WINDOW_TITLE_PREFIX}some-other-session`)],
      );
      expect(sets.owners.size).toBe(0);
    });

    it('a session with no sessionId is never matched by the title leg (only wid/pid/tag can match it)', () => {
      const sets = selectOnDesktopSessions(
        [sess({ advSessionId: 9, coordOwnerId: 'su-none', sessionId: null })],
        [win('0xHWND', 1, `${WINDOW_TITLE_PREFIX}anything`)],
      );
      expect(sets.owners.size).toBe(0);
    });
  });
});

describe('listOpenWindows (TTL-cached wmctrl spawn seam)', () => {
  it('forks wmctrl at most once within the TTL, then refreshes after it expires', async () => {
    const run = vi.fn(() => '0x1 0 100 host SH[adv:1]: x');
    const first = await listOpenWindows({ run, nowMs: 1000, ttlMs: 5000 });
    expect(first).toHaveLength(1);
    expect(run).toHaveBeenCalledTimes(1);
    // within TTL → cache hit, no second spawn
    await listOpenWindows({ run, nowMs: 4000, ttlMs: 5000 });
    expect(run).toHaveBeenCalledTimes(1);
    // past TTL → re-spawn
    await listOpenWindows({ run, nowMs: 7000, ttlMs: 5000 });
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('a failed/empty wmctrl run yields [] (headless box / no DISPLAY)', async () => {
    const run = vi.fn(() => null);
    expect(await listOpenWindows({ run, nowMs: 1, ttlMs: 0 })).toEqual([]);
  });
});

describe('listOpenWindows — win32 branch (P-019, enumerates via listWindowsByTitle, not wmctrl)', () => {
  it('on win32 with no injected deps.run, maps listWindowsByTitle results into OpenWindow[]', async () => {
    setPlatform('win32');
    listWindowsByTitleMock.mockResolvedValue([
      { hwnd: '0xABC', pid: 4321, title: `${WINDOW_TITLE_PREFIX}sess-1` },
    ]);
    const windows = await listOpenWindows({ nowMs: 1, ttlMs: 0 });
    expect(windows).toEqual<OpenWindow[]>([{ wid: '0xABC', pid: 4321, title: `${WINDOW_TITLE_PREFIX}sess-1` }]);
    expect(listWindowsByTitleMock).toHaveBeenCalledTimes(1);
  });

  it('a failed/empty listWindowsByTitle yields [] (mirrors the wmctrl fail-soft contract)', async () => {
    setPlatform('win32');
    listWindowsByTitleMock.mockRejectedValue(new Error('no powershell.exe'));
    expect(await listOpenWindows({ nowMs: 1, ttlMs: 0 })).toEqual([]);
  });

  it('an explicitly injected deps.run STILL wins on win32 (the test seam always wins)', async () => {
    setPlatform('win32');
    const run = vi.fn(() => '0x1 0 100 host SH[adv:1]: x');
    const windows = await listOpenWindows({ run, nowMs: 1, ttlMs: 0 });
    expect(windows).toHaveLength(1);
    expect(listWindowsByTitleMock).not.toHaveBeenCalled();
  });
});

describe('focused-window attendance (gateway-rayobyte-hardening P-006)', () => {
  it('parseActiveWindowId parses xprop output and normalizes hex numerically', () => {
    expect(parseActiveWindowId('_NET_ACTIVE_WINDOW(WINDOW): window id # 0x4200007')).toBe(0x4200007);
    expect(parseActiveWindowId('_NET_ACTIVE_WINDOW(WINDOW): window id # 0x0')).toBeNull(); // no active window
    expect(parseActiveWindowId('garbage')).toBeNull();
  });

  it('ownerOwnsWindow matches the FOCUSED window by wid / pid / [adv:] tag, only for the right owner', () => {
    const windows = [
      { wid: '0x04200007', pid: 111, title: 'claude — su console [adv:42]' },
      { wid: '0x04200009', pid: 222, title: 'fleet member [adv:43]' },
    ];
    const sessions = [
      { advSessionId: 42, coordOwnerId: 'su-human', sessionId: null, windowId: '0x4200007', pid: null },
      { advSessionId: 43, coordOwnerId: 'su-fleet', sessionId: null, windowId: null, pid: 222 },
    ];
    const active = 0x4200007;
    expect(ownerOwnsWindow(sessions, windows, active, 'su-human')).toBe(true); // wid match (xprop short-hex vs wmctrl padded)
    expect(ownerOwnsWindow(sessions, windows, active, 'su-fleet')).toBe(false); // focused window is NOT theirs
    expect(ownerOwnsWindow(sessions, windows, 0x4200009, 'su-fleet')).toBe(true); // pid match on their own window
    expect(ownerOwnsWindow(sessions, windows, 0xdead, 'su-human')).toBe(false); // active window unknown to wmctrl
  });
});

describe('proc-ancestry on-desktop detection (WI-1586 — the launch-capture-free leg)', () => {
  // A /proc/<pid>/stat line: pid (comm) state ppid pgrp session tty_nr tpgid …
  const stat = (pid: number, comm: string, ppid: number) => `${pid} (${comm}) S ${ppid} ${pid} ${pid} 0 -1 4194304`;

  describe('parsePpidFromStat', () => {
    it('parses ppid from a normal stat line', () => {
      expect(parsePpidFromStat(stat(100, 'node', 42))).toBe(42);
    });

    it('handles comm with spaces and parens (slice after the LAST close-paren)', () => {
      expect(parsePpidFromStat('200 (my (weird) proc) S 77 200 200 0 -1 0')).toBe(77);
    });

    it('garbage / pid-1 root → null (chain ends, never a bogus walk)', () => {
      expect(parsePpidFromStat('garbage')).toBeNull();
      expect(parsePpidFromStat('1 (init) S 0 1 1 0 -1 0')).toBeNull(); // ppid 0
    });
  });

  describe('pidHasWindowAncestor', () => {
    /** In-memory proc tree: pid → [comm, ppid]. */
    const tree = (t: Record<number, number>) => async (pid: number) =>
      t[pid] != null ? stat(pid, 'p', t[pid]) : null;

    it('matches the gnome-terminal shape: host ← shell ← terminal-server (window owner)', async () => {
      // 363663 (psu host) ← 363649 (bash) ← 1357544 (gnome-terminal-server, owns the windows)
      const readStat = tree({ 363663: 363649, 363649: 1357544, 1357544: 1 });
      expect(await pidHasWindowAncestor(363663, new Set([1357544]), readStat)).toBe(true);
    });

    it('matches the pid itself (window pid == the session pid, e.g. standalone emulators)', async () => {
      expect(await pidHasWindowAncestor(500, new Set([500]), tree({}))).toBe(true);
    });

    it('a headless chain (reparented to init / spawned by a service) never matches', async () => {
      const readStat = tree({ 1999914: 1999867, 1999867: 1346348, 1346348: 1 });
      expect(await pidHasWindowAncestor(1999914, new Set([1357544]), readStat)).toBe(false);
    });

    it('a vanished proc mid-walk ends the chain (best-effort, never over-protects on garbage)', async () => {
      const readStat = tree({ 100: 99 }); // 99 has no stat (gone)
      expect(await pidHasWindowAncestor(100, new Set([1357544]), readStat)).toBe(false);
    });

    it('empty window-pid set short-circuits to false', async () => {
      const readStat = vi.fn(async () => stat(1, 'x', 1));
      expect(await pidHasWindowAncestor(100, new Set(), readStat)).toBe(false);
      expect(readStat).not.toHaveBeenCalled();
    });

    it('a ppid CYCLE (corrupt stat) is bounded by the depth cap, not an infinite loop', async () => {
      const readStat = tree({ 100: 200, 200: 100 }); // cycle
      expect(await pidHasWindowAncestor(100, new Set([1357544]), readStat)).toBe(false);
    });
  });

  describe('windowOwningPids', () => {
    it('collects distinct window pids, dropping null/zero', () => {
      const pids = windowOwningPids([
        { wid: '0x1', pid: 1357544, title: 'Terminal' },
        { wid: '0x2', pid: 1357544, title: 'Terminal' },
        { wid: '0x3', pid: null, title: 'no pid' },
      ]);
      expect([...pids]).toEqual([1357544]);
    });
  });
});
