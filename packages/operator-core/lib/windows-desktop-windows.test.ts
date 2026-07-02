/**
 * Unit tests for windows-desktop-windows.ts (Lane 1/2/5 shared contract,
 * windows-desktop-feature-parity-2026-07-02). Hermetic — no real powershell.exe
 * is spawned; the pure parsers are covered directly, and the platform guards on
 * the async entry points are covered via `process.platform` override.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  parseWindowListOutput,
  parseSessionIdFromWindowTitle,
  listWindowsByTitle,
  focusWindowByTitle,
  WINDOW_TITLE_PREFIX,
  type WindowsDesktopWindow,
} from './windows-desktop-windows';

const realPlatform = process.platform;

/** Override the read-only process.platform for one test. */
function setPlatform(p: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: p, configurable: true });
}

afterEach(() => {
  setPlatform(realPlatform);
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

describe('platform guard — never reached off win32', () => {
  it('listWindowsByTitle short-circuits to [] on non-win32 (no spawn attempted)', async () => {
    setPlatform('linux');
    expect(await listWindowsByTitle()).toEqual([]);
    setPlatform('darwin');
    expect(await listWindowsByTitle(WINDOW_TITLE_PREFIX)).toEqual([]);
  });

  it('focusWindowByTitle short-circuits to false on non-win32 (no spawn attempted)', async () => {
    setPlatform('linux');
    expect(await focusWindowByTitle('anything')).toBe(false);
  });
});
