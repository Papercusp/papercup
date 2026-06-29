import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  parseWmctrlList,
  selectOnDesktopSessions,
  listOpenWindows,
  __resetDesktopLivenessCache,
  type OpenWindow,
  type DesktopCandidateSession,
} from './desktop-window-liveness';

beforeEach(() => {
  __resetDesktopLivenessCache();
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
