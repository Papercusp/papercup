/**
 * Coverage for shortcut-match: the combo parser + matcher core. Pure logic —
 * KeyboardEvents are plain objects with the read fields. Runs in the bare node
 * env, so navigator is absent → isMac=false → `mod` resolves to Ctrl.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  parseCombo,
  stepMatches,
  tryMatch,
  _resetSequenceState,
  isMacPlatform,
} from './shortcut-match';

const ev = (key: string, mods: Partial<KeyboardEvent> = {}): KeyboardEvent =>
  ({ key, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...mods }) as KeyboardEvent;

beforeEach(() => _resetSequenceState());

describe('parseCombo', () => {
  it('parses modifiers + a normalized key', () => {
    expect(parseCombo('mod+shift+p')).toEqual({
      alternates: [{ steps: [{ key: 'p', mod: true, shift: true }] }],
    });
  });
  it('splits comma alternates and > sequences', () => {
    expect(parseCombo('a, b').alternates).toHaveLength(2);
    expect(parseCombo('g>d').alternates[0].steps).toHaveLength(2);
  });
  it('normalizes special key names', () => {
    expect(parseCombo('slash').alternates[0].steps[0].key).toBe('/');
    expect(parseCombo('Enter').alternates[0].steps[0].key).toBe('Enter');
    expect(parseCombo('f5').alternates[0].steps[0].key).toBe('F5');
    expect(parseCombo('space').alternates[0].steps[0].key).toBe(' ');
  });
});

describe('stepMatches', () => {
  const step = (raw: string) => parseCombo(raw).alternates[0].steps[0];

  it('matches mod+key against Ctrl on non-Mac', () => {
    expect(stepMatches(step('mod+k'), ev('k', { ctrlKey: true }))).toBe(true);
    expect(stepMatches(step('mod+k'), ev('k'))).toBe(false); // no ctrl
  });

  it('rejects an unmodified binding when Ctrl/Meta is held', () => {
    expect(stepMatches(step('j'), ev('j'))).toBe(true);
    expect(stepMatches(step('j'), ev('j', { ctrlKey: true }))).toBe(false);
  });

  it('matches a shifted-variant key (shift+slash → "?")', () => {
    expect(stepMatches(step('shift+slash'), ev('?', { shiftKey: true }))).toBe(true);
  });

  it('rejects an unmodified letter when Shift is held (Shift+J ≠ j)', () => {
    expect(stepMatches(step('j'), ev('J', { shiftKey: true }))).toBe(false);
  });

  it('is case-insensitive for single chars', () => {
    expect(stepMatches(step('k'), ev('K'))).toBe(true);
  });
});

describe('tryMatch — single + sequence', () => {
  it('fires a single-step combo immediately', () => {
    expect(tryMatch('c1', parseCombo('mod+k'), ev('k', { ctrlKey: true }))).toBe(true);
  });

  it('fires a g>d sequence only after both steps', () => {
    const combo = parseCombo('g>d');
    expect(tryMatch('seq', combo, ev('g'))).toBe(false); // first step advances, not complete
    expect(tryMatch('seq', combo, ev('d'))).toBe(true); // completes
  });

  it('a wrong second key aborts the sequence', () => {
    const combo = parseCombo('g>d');
    expect(tryMatch('seq2', combo, ev('g'))).toBe(false);
    expect(tryMatch('seq2', combo, ev('x'))).toBe(false); // not 'd' → reset, no fire
    expect(tryMatch('seq2', combo, ev('d'))).toBe(false); // depth was reset, 'd' isn't step 0
  });

  it('matches any of comma-separated alternates', () => {
    const combo = parseCombo('mod+p, mod+k');
    expect(tryMatch('alt', combo, ev('k', { ctrlKey: true }))).toBe(true);
    expect(tryMatch('alt', combo, ev('p', { ctrlKey: true }))).toBe(true);
  });
});

describe('isMacPlatform — WebKit navigator.platform freeze regression', () => {
  const stubNav = (nav: Partial<Navigator> & { userAgentData?: { platform?: string } }) =>
    vi.stubGlobal('navigator', nav as unknown as Navigator);
  afterEach(() => vi.unstubAllGlobals());

  it('is FALSE on Linux WebKitGTK even though navigator.platform is frozen to "MacIntel"', () => {
    // The Tauri-desktop bug: WebKit freezes navigator.platform to "MacIntel" on
    // EVERY OS, but the userAgent still says Linux. Trusting platform made `mod`
    // demand Cmd → Ctrl+F (find-in-page) + every mod shortcut died on the Linux
    // desktop. The UA OS token must win.
    stubNav({
      userAgent:
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.4 Safari/605.1.15',
      platform: 'MacIntel',
    });
    expect(isMacPlatform()).toBe(false);
  });

  it('is TRUE on real macOS Safari (UA says Macintosh)', () => {
    stubNav({
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17 Safari/605.1.15',
      platform: 'MacIntel',
    });
    expect(isMacPlatform()).toBe(true);
  });

  it('is FALSE on Chromium Linux and Windows', () => {
    stubNav({
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
      platform: 'Linux x86_64',
    });
    expect(isMacPlatform()).toBe(false);
    stubNav({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120',
      platform: 'Win32',
    });
    expect(isMacPlatform()).toBe(false);
  });

  it('mod+f matches Ctrl+F (not Cmd+F) under the frozen-MacIntel WebKitGTK navigator', () => {
    stubNav({
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 Version/26.4 Safari/605.1.15',
      platform: 'MacIntel',
    });
    const combo = parseCombo('mod+f');
    // The user's Ctrl+F now fires…
    expect(tryMatch('find.open', combo, ev('f', { ctrlKey: true }))).toBe(true);
    // …and Cmd is no longer (wrongly) required on a Linux desktop.
    expect(tryMatch('find.open', combo, ev('f', { metaKey: true }))).toBe(false);
  });
});

describe('matcher — edge cases (audit)', () => {
  const step = (raw: string) => parseCombo(raw).alternates[0].steps[0];

  it('a sequence RESETS when the second step arrives after the 1s timeout (no stale completion)', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      const combo = parseCombo('g>d');
      expect(tryMatch('go', combo, ev('g'))).toBe(false); // step 0 armed at t=0
      vi.setSystemTime(1001); // > SEQUENCE_TIMEOUT_MS (1000)
      expect(tryMatch('go', combo, ev('d'))).toBe(false); // too late → does NOT complete the sequence
      // Re-arm cleanly and complete promptly within the window:
      expect(tryMatch('go', combo, ev('g'))).toBe(false);
      expect(tryMatch('go', combo, ev('d'))).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('requires the alt modifier when bound (alt+k)', () => {
    expect(stepMatches(step('alt+k'), ev('k', { altKey: true }))).toBe(true);
    expect(stepMatches(step('alt+k'), ev('k', { altKey: false }))).toBe(false);
  });

  it('matches a shifted number variant (shift+1 → "!")', () => {
    expect(stepMatches(step('shift+1'), ev('!', { shiftKey: true }))).toBe(true);
  });

  it('an empty / blank combo never matches', () => {
    expect(parseCombo('').alternates).toHaveLength(0);
    expect(parseCombo('  ').alternates).toHaveLength(0);
    expect(tryMatch('empty', parseCombo(''), ev('a'))).toBe(false);
  });

  it('normalizes the remaining special keys (arrows, escape, backspace)', () => {
    expect(step('up').key).toBe('ArrowUp');
    expect(step('arrowdown').key).toBe('ArrowDown');
    expect(step('esc').key).toBe('Escape');
    expect(step('backspace').key).toBe('Backspace');
  });
});
