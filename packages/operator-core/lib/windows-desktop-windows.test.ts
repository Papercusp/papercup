/**
 * Unit tests for windows-desktop-windows.ts (Lane 1/2/5 shared contract,
 * windows-desktop-feature-parity-2026-07-02). Hermetic — no real powershell.exe
 * is spawned; the pure parsers are covered directly, `/proc/version` is
 * mocked (node:fs) so isWindowsDesktopHost's WSL-detection is deterministic
 * regardless of what machine the test actually runs on, and the platform
 * guards on the async entry points are covered via that mock + a
 * `process.platform` override for the win32-fallback leg.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  parseWindowListOutput,
  parseSessionIdFromWindowTitle,
  listWindowsByTitle,
  focusWindowByTitle,
  isWindowsDesktopHost,
  __resetIsWindowsDesktopHostCache,
  WINDOW_TITLE_PREFIX,
  type WindowsDesktopWindow,
} from './windows-desktop-windows';

const readFileSyncMock = vi.fn();

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, readFileSync: (...args: unknown[]) => readFileSyncMock(...args) };
});

const realPlatform = process.platform;

/** Override the read-only process.platform for one test. */
function setPlatform(p: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: p, configurable: true });
}

/** A genuine Linux dev box's /proc/version — no "microsoft" anywhere. */
const NATIVE_LINUX_PROC_VERSION =
  'Linux version 6.8.0-generic (buildd@lcy02-amd64) (gcc (Ubuntu 13.2.0) 13.2.0) #1 SMP';
/** A real WSL2 kernel's /proc/version signature. */
const WSL2_PROC_VERSION = 'Linux version 5.15.153.1-microsoft-standard-WSL2 (root@…) #1 SMP';

afterEach(() => {
  setPlatform(realPlatform);
  __resetIsWindowsDesktopHostCache();
  readFileSyncMock.mockReset();
});

describe('parseWindowListOutput (pure hwnd|pid|title parser)', () => {
  it('parses well-formed lines', () => {
    const stdout = ['0x1a2b3c|4321|Papercup — abc-123', '0x9|555|Untitled - Notepad'].join('\n');
    expect(parseWindowListOutput(stdout)).toEqual<WindowsDesktopWindow[]>([
      { hwnd: '0x1a2b3c', pid: 4321, title: 'Papercup — abc-123' },
      { hwnd: '0x9', pid: 555, title: 'Untitled - Notepad' },
    ]);
  });

  it('skips blank lines and lines missing either separator', () => {
    const stdout = ['', '   ', 'no separators at all', '0x1|123'].join('\n');
    expect(parseWindowListOutput(stdout)).toEqual([]);
  });

  it('skips a non-numeric or non-positive pid', () => {
    const stdout = ['0x1|notapid|title', '0x2|0|title', '0x3|-5|title'].join('\n');
    expect(parseWindowListOutput(stdout)).toEqual([]);
  });

  it('preserves a title containing a literal | (rejoins after the SECOND separator)', () => {
    const out = parseWindowListOutput('0x1|100|a|b|c');
    expect(out).toEqual([{ hwnd: '0x1', pid: 100, title: 'a|b|c' }]);
  });

  it('skips a line with an empty hwnd', () => {
    expect(parseWindowListOutput('|100|title')).toEqual([]);
  });
});

describe('parseSessionIdFromWindowTitle (pure title→sessionId extractor)', () => {
  it('extracts the sessionId from the exact contracted title format', () => {
    expect(parseSessionIdFromWindowTitle(`${WINDOW_TITLE_PREFIX}abc-123-def`)).toBe('abc-123-def');
  });

  it('returns null for a title without the prefix', () => {
    expect(parseSessionIdFromWindowTitle('Untitled - Notepad')).toBeNull();
    expect(parseSessionIdFromWindowTitle('Papercup - abc')).toBeNull(); // hyphen, not em dash
  });

  it('returns null when the tag is present but empty', () => {
    expect(parseSessionIdFromWindowTitle(WINDOW_TITLE_PREFIX)).toBeNull();
    expect(parseSessionIdFromWindowTitle(`${WINDOW_TITLE_PREFIX}   `)).toBeNull();
  });
});

describe('isWindowsDesktopHost (the P-025/WI-1646-sibling platform-detection fix)', () => {
  it('win32 short-circuits true without touching /proc/version (defensive fallback leg)', () => {
    setPlatform('win32');
    expect(isWindowsDesktopHost()).toBe(true);
    expect(readFileSyncMock).not.toHaveBeenCalled();
  });

  it('darwin is never WSL — false without touching /proc/version', () => {
    setPlatform('darwin');
    expect(isWindowsDesktopHost()).toBe(false);
    expect(readFileSyncMock).not.toHaveBeenCalled();
  });

  it('linux + a WSL2 kernel /proc/version → true (the actual Windows-desktop-host case)', () => {
    setPlatform('linux');
    readFileSyncMock.mockReturnValue(WSL2_PROC_VERSION);
    expect(isWindowsDesktopHost()).toBe(true);
  });

  it('linux + a native (non-WSL) /proc/version → false (the fleet dev box case)', () => {
    setPlatform('linux');
    readFileSyncMock.mockReturnValue(NATIVE_LINUX_PROC_VERSION);
    expect(isWindowsDesktopHost()).toBe(false);
  });

  it('linux + an unreadable /proc/version → false (best-effort, never throws)', () => {
    setPlatform('linux');
    readFileSyncMock.mockImplementation(() => {
      throw new Error('ENOENT');
    });
    expect(isWindowsDesktopHost()).toBe(false);
  });

  it('caches the result — /proc/version is read at most once per cache lifetime', () => {
    setPlatform('linux');
    readFileSyncMock.mockReturnValue(WSL2_PROC_VERSION);
    expect(isWindowsDesktopHost()).toBe(true);
    expect(isWindowsDesktopHost()).toBe(true);
    expect(readFileSyncMock).toHaveBeenCalledTimes(1);
  });
});

describe('platform guard — listWindowsByTitle/focusWindowByTitle never reached off a Windows desktop host', () => {
  it('listWindowsByTitle short-circuits to [] on a native Linux/macOS host (no spawn attempted)', async () => {
    setPlatform('linux');
    readFileSyncMock.mockReturnValue(NATIVE_LINUX_PROC_VERSION);
    expect(await listWindowsByTitle()).toEqual([]);
    __resetIsWindowsDesktopHostCache();
    setPlatform('darwin');
    expect(await listWindowsByTitle(WINDOW_TITLE_PREFIX)).toEqual([]);
  });

  it('focusWindowByTitle short-circuits to false on a native Linux host (no spawn attempted)', async () => {
    setPlatform('linux');
    readFileSyncMock.mockReturnValue(NATIVE_LINUX_PROC_VERSION);
    expect(await focusWindowByTitle('anything')).toBe(false);
  });
});
