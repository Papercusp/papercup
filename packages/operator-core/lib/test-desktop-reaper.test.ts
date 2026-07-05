import { describe, it, expect, vi } from 'vitest';
import {
  classifyDesktop,
  findReapCandidates,
  shouldAlarm,
  formatReaperToast,
  runTestDesktopReaperOnce,
  policyFromEnv,
  DEFAULT_POLICY,
  parsePgid,
  parsePpid,
  killDesktopProcsWithEndedSessions,
  type ProcSample,
  type ReaperPolicy,
  type DesktopKillDeps,
} from './test-desktop-reaper';

function sample(p: Partial<ProcSample> = {}): ProcSample {
  return { pid: 1000, cmdline: '', state: 'S', cpuPercent: 0, ageSeconds: 600, ...p };
}

// Real, representative cmdlines.
const PLAYWRIGHT_HEADLESS =
  '/home/x/.cache/ms-playwright/chromium-1140/chrome-linux/chrome --headless=new --remote-debugging-pipe --user-data-dir=/tmp/playwright_chromiumdev_profile-AbC --no-sandbox';
const PLAYWRIGHT_REMOTE_DEBUG =
  '/usr/bin/chromium --remote-debugging-port=0 --user-data-dir=/tmp/pw-xyz about:blank';
const LIVE_TAURI_DESKTOP =
  '/home/marsh-office/.local/share/papercusp/papercusp --some-real-flag';
const LIVE_WEBKIT_CHILD = '/usr/lib/webkit2gtk-4.1/WebKitWebProcess 7 12';
const LIVE_USER_CHROME = '/opt/google/chrome/chrome --profile-directory=Default https://news.example';
const NON_BROWSER = '/usr/bin/node /home/x/papercup/apps/operator/bin/hono-host.ts';

describe('classifyDesktop (safety-critical)', () => {
  it('flags Playwright headless / remote-debugging chromium as test-desktop', () => {
    expect(classifyDesktop(PLAYWRIGHT_HEADLESS)).toBe('test-desktop');
    expect(classifyDesktop(PLAYWRIGHT_REMOTE_DEBUG)).toBe('test-desktop');
  });

  it('NEVER flags a real browser/webview without a test marker — fail-safe to live-desktop', () => {
    // The whole point of P-006: the user's real desktop must be untouchable.
    expect(classifyDesktop(LIVE_WEBKIT_CHILD)).toBe('live-desktop');
    expect(classifyDesktop(LIVE_USER_CHROME)).toBe('live-desktop');
    // The app's own main process (argv0 = the `papercusp` binary) is not a browser
    // by cmdline → 'not-desktop', which is equally un-reapable. The invariant that
    // matters for safety is simply: it is NEVER 'test-desktop'.
    expect(classifyDesktop(LIVE_TAURI_DESKTOP)).not.toBe('test-desktop');
  });

  it('classifies non-browser processes and empty cmdlines as not-desktop', () => {
    expect(classifyDesktop(NON_BROWSER)).toBe('not-desktop');
    expect(classifyDesktop('')).toBe('not-desktop');
  });

  it('a tauri-dev repo webview without a test marker fails safe to live-desktop (out of scope)', () => {
    expect(classifyDesktop('/home/x/papercup/papercusp-desktop/src-tauri/target/debug/papercusp')).toBe(
      'live-desktop',
    );
  });
});

describe('findReapCandidates', () => {
  it('flags a runaway test desktop over CPU+age thresholds', () => {
    const c = findReapCandidates([sample({ pid: 1, cmdline: PLAYWRIGHT_HEADLESS, cpuPercent: 95, ageSeconds: 1800 })]);
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ pid: 1, reason: 'runaway-test-desktop' });
  });

  it('does NOT flag a test desktop below the CPU threshold or below the min age', () => {
    expect(
      findReapCandidates([sample({ cmdline: PLAYWRIGHT_HEADLESS, cpuPercent: 5, ageSeconds: 1800 })]),
    ).toEqual([]);
    expect(
      findReapCandidates([sample({ cmdline: PLAYWRIGHT_HEADLESS, cpuPercent: 99, ageSeconds: 30 })]),
    ).toEqual([]);
  });

  it('NEVER flags the live desktop even when it pegs 100% CPU (the core safety invariant)', () => {
    expect(
      findReapCandidates([
        sample({ pid: 7, cmdline: LIVE_TAURI_DESKTOP, cpuPercent: 100, ageSeconds: 99999 }),
        sample({ pid: 8, cmdline: LIVE_USER_CHROME, cpuPercent: 100, ageSeconds: 99999 }),
        sample({ pid: 9, cmdline: LIVE_WEBKIT_CHILD, cpuPercent: 100, ageSeconds: 99999 }),
      ]),
    ).toEqual([]);
  });

  it('flags a zombie whose parent is unknown/non-browser (the generic not-reaping signal)', () => {
    // parentIsBrowser undefined (couldn't read parent) → fail toward counting.
    const c = findReapCandidates([sample({ pid: 42, state: 'Z', cmdline: '' })]);
    expect(c).toEqual([{ pid: 42, reason: 'zombie', cpuPercent: 0, ageSeconds: 600, cmdline: '' }]);
    // parentIsBrowser=false (a non-browser parent genuinely not reaping) → counted.
    expect(findReapCandidates([sample({ pid: 43, state: 'Z', cmdline: '', parentIsBrowser: false })])).toHaveLength(1);
  });

  it('does NOT count a defunct child of a browser/webview — normal renderer churn, not a leak (P-006)', () => {
    // The dominant real-world false alarm: the user's live Edge/Chrome/WebKit browser
    // constantly spawns + reaps renderer/utility children; a handful of defunct ones
    // at any instant is normal churn, not a reap-worthy leak. Applies to a live-desktop
    // browser AND a test-desktop browser (its runaway CPU is the separate signal).
    const zombies = Array.from({ length: 30 }, (_, i) =>
      sample({ pid: 100 + i, state: 'Z', cmdline: '', parentIsBrowser: true }),
    );
    expect(findReapCandidates(zombies)).toEqual([]);
    // A real non-browser leak still surfaces even when mixed with browser churn.
    const mixed = [...zombies, sample({ pid: 999, state: 'Z', cmdline: '', parentIsBrowser: false })];
    const c = findReapCandidates(mixed);
    expect(c).toEqual([{ pid: 999, reason: 'zombie', cpuPercent: 0, ageSeconds: 600, cmdline: '' }]);
  });

  it('ignores a non-browser process pegging CPU', () => {
    expect(findReapCandidates([sample({ cmdline: NON_BROWSER, cpuPercent: 100, ageSeconds: 1800 })])).toEqual([]);
  });
});

describe('shouldAlarm', () => {
  const policy: ReaperPolicy = { ...DEFAULT_POLICY, zombieAlarmThreshold: 3 };
  it('alarms on any runaway desktop', () => {
    expect(shouldAlarm([{ pid: 1, reason: 'runaway-test-desktop', cpuPercent: 90, ageSeconds: 999, cmdline: 'x' }], policy)).toBe(
      true,
    );
  });
  it('does not alarm on a small zombie count, alarms once the pile hits the threshold', () => {
    const z = (pid: number) => ({ pid, reason: 'zombie' as const, cpuPercent: 0, ageSeconds: 1, cmdline: '' });
    expect(shouldAlarm([z(1), z(2)], policy)).toBe(false);
    expect(shouldAlarm([z(1), z(2), z(3)], policy)).toBe(true);
  });
  it('does not alarm on nothing', () => {
    expect(shouldAlarm([], policy)).toBe(false);
  });
});

describe('formatReaperToast', () => {
  it('names runaway pids, marks them NOT the live desktop, and states auto-reap is not armed', () => {
    const t = formatReaperToast([
      { pid: 555, reason: 'runaway-test-desktop', cpuPercent: 97, ageSeconds: 1800, cmdline: PLAYWRIGHT_HEADLESS },
    ]);
    expect(t.level).toBe('warning');
    expect(t.message).toContain('1 runaway desktop');
    expect(t.description).toContain('pid 555');
    expect(t.description).toContain('NOT the live desktop');
    expect(t.description.toLowerCase()).toContain('auto-reap is intentionally not armed');
  });
});

describe('runTestDesktopReaperOnce', () => {
  it('emits exactly one toast when there is a runaway desktop, and returns the candidates', async () => {
    const emitToast = vi.fn(async (_t: { level: string; message: string; description: string }) => {});
    const res = await runTestDesktopReaperOnce({
      sample: async () => [sample({ pid: 3, cmdline: PLAYWRIGHT_HEADLESS, cpuPercent: 90, ageSeconds: 1800 })],
      emitToast,
    });
    expect(res.alarmed).toBe(true);
    expect(res.candidates.map((c) => c.pid)).toEqual([3]);
    expect(emitToast).toHaveBeenCalledTimes(1);
    expect(emitToast.mock.calls[0][0].level).toBe('warning');
  });

  it('emits NO toast when only the live desktop is busy', async () => {
    const emitToast = vi.fn(async (_t: { level: string; message: string; description: string }) => {});
    const res = await runTestDesktopReaperOnce({
      sample: async () => [sample({ pid: 7, cmdline: LIVE_TAURI_DESKTOP, cpuPercent: 100, ageSeconds: 99999 })],
      emitToast,
    });
    expect(res.alarmed).toBe(false);
    expect(emitToast).not.toHaveBeenCalled();
  });

  it('never throws when sampling fails — returns an empty, non-alarmed result', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const emitToast = vi.fn(async (_t: { level: string; message: string; description: string }) => {});
    const res = await runTestDesktopReaperOnce({
      sample: async () => {
        throw new Error('boom /proc unreadable');
      },
      emitToast,
    });
    expect(res).toEqual({ sampled: 0, candidates: [], alarmed: false });
    expect(emitToast).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('policyFromEnv', () => {
  it('falls back to defaults when env is unset', () => {
    expect(policyFromEnv()).toEqual(DEFAULT_POLICY);
  });
});

// ── Slice 2: adv-session-based kill ──────────────────────────────────────────

// A /proc/<pid>/stat line for pid 1234. comm may contain spaces; split after the
// last ')'. Fields after ')': state ppid pgrp session tty_nr tpgid …
const SAMPLE_STAT = '1234 (some comm (with parens)) S 100 1234 1234 0 -1 0 0 0 0 0 100 50';

describe('parsePgid', () => {
  it('extracts the pgrp from a stat line', () => {
    expect(parsePgid(SAMPLE_STAT)).toBe(1234);
  });
  it('returns null when the stat line has no closing paren', () => {
    expect(parsePgid('bad line')).toBeNull();
  });
  it('returns null for pgrp=0 (kernel thread)', () => {
    expect(parsePgid('1 (idle) S 0 0 0 0 -1 0 0 0')).toBeNull();
  });
});

describe('parsePpid', () => {
  it('extracts the ppid from a stat line', () => {
    // ppid is index 1 in the post-')' tokens; SAMPLE_STAT ppid=100
    expect(parsePpid(SAMPLE_STAT)).toBe(100);
  });
  it('returns null when the stat line has no closing paren', () => {
    expect(parsePpid('bad')).toBeNull();
  });
});

// ── killDesktopProcsWithEndedSessions ──────────────────────────────────────────

function makeDeps(overrides: Partial<DesktopKillDeps> = {}): DesktopKillDeps {
  return {
    listProc: async () => ['1', '2', '3', '100', '200'],
    readCmdline: async (pid) => {
      if (pid === 100) return '/home/marsh-office/.cargo-target/debug/papercusp-desktop\0';
      if (pid === 200) return '/usr/lib/x86_64-linux-gnu/webkit2gtk-4.1/WebKitWebProcess 4 42\0';
      return `process-${pid}`;
    },
    readEnviron: async (pid) => {
      if (pid === 100) return `HOME=/home/u\0PAPERCUSP_ADV_SESSION_ID=42\0SHELL=/bin/bash\0`;
      return '';
    },
    readStat: async (pid) => {
      // pid 200 has ppid=100 (a webkit child)
      if (pid === 200) return `200 (WebKitWebProcess) S 100 200 200 0 0 0 0 0 0 0 50 30`;
      return `${pid} (proc) S 1 ${pid} ${pid} 0 0 0 0 0 0 0 10 5`;
    },
    endedAdvSessionIds: async (ids) => new Set(ids.filter((id) => id === 42)),
    pidCarriesSessionId: async (pid, id) => pid === 100 && id === 42,
    sigterm: vi.fn(() => true),
    sigkill: vi.fn(() => true),
    pidAlive: (pid) => [100, 200].includes(pid),
    wait: async () => {},
    ...overrides,
  };
}

describe('killDesktopProcsWithEndedSessions', () => {
  it('kills a desktop process and its webkit child when the session is ended', async () => {
    const deps = makeDeps();
    const result = await killDesktopProcsWithEndedSessions({ deps });
    expect(result.enabled).toBe(true);
    expect(result.dryRun).toBe(false);
    expect(result.scanned).toBe(1); // one papercusp-desktop proc found
    // Both the desktop (100) and its webkit child (200) should be killed
    expect(result.killed.sort()).toEqual([100, 200].sort());
    expect(result.skipped).toEqual([]);
    expect(deps.sigterm).toHaveBeenCalledWith(100);
  });

  it('dry run reports what would be killed without signalling', async () => {
    const deps = makeDeps();
    const result = await killDesktopProcsWithEndedSessions({ dryRun: true, deps });
    expect(result.dryRun).toBe(true);
    expect(result.killed.sort()).toEqual([100, 200].sort());
    expect(deps.sigterm).not.toHaveBeenCalled();
    expect(deps.sigkill).not.toHaveBeenCalled();
  });

  it('skips a desktop whose session is NOT ended', async () => {
    const deps = makeDeps({
      endedAdvSessionIds: async () => new Set<number>(), // none ended
    });
    const result = await killDesktopProcsWithEndedSessions({ deps });
    expect(result.killed).toEqual([]);
    expect(result.skipped).toEqual([100]);
    expect(deps.sigterm).not.toHaveBeenCalled();
  });

  it('skips a process that fails the pid-recycle guard', async () => {
    const deps = makeDeps({
      pidCarriesSessionId: async () => false, // recycle guard fails
    });
    const result = await killDesktopProcsWithEndedSessions({ deps });
    // desktop was targeted but recycle guard prevented signalling
    expect(deps.sigterm).not.toHaveBeenCalled();
    expect(result.killed).not.toContain(100);
  });

  it('returns empty result when no desktop procs exist', async () => {
    const deps = makeDeps({
      readCmdline: async () => 'node something-unrelated',
    });
    const result = await killDesktopProcsWithEndedSessions({ deps });
    expect(result.scanned).toBe(0);
    expect(result.killed).toEqual([]);
  });

  it('returns gracefully when listProc throws', async () => {
    const deps = makeDeps({
      listProc: async () => { throw new Error('no /proc'); },
    });
    const result = await killDesktopProcsWithEndedSessions({ deps });
    expect(result.enabled).toBe(true);
    expect(result.killed).toEqual([]);
  });

  it('returns gracefully when endedAdvSessionIds throws', async () => {
    const deps = makeDeps({
      endedAdvSessionIds: async () => { throw new Error('pg down'); },
    });
    const result = await killDesktopProcsWithEndedSessions({ deps });
    expect(result.enabled).toBe(true);
    expect(result.killed).toEqual([]);
  });
});
