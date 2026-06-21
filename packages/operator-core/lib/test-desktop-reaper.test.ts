import { describe, it, expect, vi } from 'vitest';
import {
  classifyDesktop,
  findReapCandidates,
  shouldAlarm,
  formatReaperToast,
  runTestDesktopReaperOnce,
  policyFromEnv,
  DEFAULT_POLICY,
  type ProcSample,
  type ReaperPolicy,
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

  it('flags zombie/defunct processes by state regardless of cmdline', () => {
    const c = findReapCandidates([sample({ pid: 42, state: 'Z', cmdline: '' })]);
    expect(c).toEqual([{ pid: 42, reason: 'zombie', cpuPercent: 0, ageSeconds: 600, cmdline: '' }]);
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
