/**
 * EI-19407722209410974 — pins the single-sourced Linux terminal table.
 *
 * `console-spawn.ts` and `terminal-spawn.ts` each used to carry their own copy.
 * That duplication is not a tidiness complaint: it is why the
 * GNOME_TERMINAL_SCREEN fix (EI-19385011811175105) landed in one file and left
 * the other — the busier one — broken for another day.
 *
 * Two things are pinned here, and the SECOND is the one that matters:
 *
 *  1. the groups still contain what they claim to (a client-server terminal must
 *     not quietly migrate into the process-per-window group or vice versa — the
 *     split drives WI-4718's ghost-avoidance and WI-4272's display override);
 *
 *  2. the FLAT order is byte-identical to the literal that used to live in
 *     terminal-spawn.ts. That literal is written out longhand below rather than
 *     derived, deliberately: a test that builds its expectation from the same
 *     constant it is checking proves nothing. This is the historical value,
 *     transcribed, so that if someone reorders the groups for console-spawn's
 *     benefit they are told immediately that they also just changed which
 *     terminal the HUD's "New session" button opens.
 */
import { describe, expect, it } from 'vitest';
import {
  CLIENT_SERVER_TERMINALS,
  LINUX_TERMINALS_FLAT,
  PROCESS_PER_WINDOW_TERMINALS,
} from './linux-terminals';
import { LINUX_TERMINALS } from './terminal-spawn';

/** Verbatim transcription of terminal-spawn.ts's pre-dedupe literal. Do not derive this. */
const HISTORICAL_FLAT_ORDER: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['gnome-terminal', ['--wait', '--window', '--']],
  ['konsole', ['--new-window', '-e']],
  ['xfce4-terminal', ['--window', '-e']],
  ['alacritty', ['-e']],
  ['kitty', ['--']],
  ['wezterm', ['start', '--always-new-process', '--']],
  ['xterm', ['-e']],
];

describe('linux-terminals (single-sourced table)', () => {
  it('the flat order is unchanged from the literal terminal-spawn.ts used to hold', () => {
    expect(LINUX_TERMINALS_FLAT).toEqual(HISTORICAL_FLAT_ORDER);
  });

  it("terminal-spawn's exported LINUX_TERMINALS is that same order", () => {
    // The export is kept so this module's own callers/tests are untouched by the
    // move; this asserts the alias did not silently become something else.
    expect(LINUX_TERMINALS).toEqual(HISTORICAL_FLAT_ORDER);
  });

  it('the two groups partition the flat list with no loss, overlap, or reordering', () => {
    expect([...CLIENT_SERVER_TERMINALS, ...PROCESS_PER_WINDOW_TERMINALS]).toEqual(
      LINUX_TERMINALS_FLAT,
    );
    const names = LINUX_TERMINALS_FLAT.map(([bin]) => bin);
    expect(new Set(names).size).toBe(names.length);
  });

  it('group membership is by window model, not by name — the WI-4718/WI-4272 invariant', () => {
    // gnome-terminal/konsole/xfce4 hand off to a D-Bus factory and ignore the
    // injected DISPLAY; the others ARE their own window and honour it. Misfiling
    // one is how a launch ghosts or opens on the wrong display.
    expect(CLIENT_SERVER_TERMINALS.map(([b]) => b)).toEqual([
      'gnome-terminal',
      'konsole',
      'xfce4-terminal',
    ]);
    expect(PROCESS_PER_WINDOW_TERMINALS.map(([b]) => b)).toEqual([
      'alacritty',
      'kitty',
      'wezterm',
      'xterm',
    ]);
  });

  it('every entry carries the args that open a NEW window', () => {
    for (const [bin, args] of LINUX_TERMINALS_FLAT) {
      expect(bin, 'empty binary name').toBeTruthy();
      expect(args.length, `${bin} has no new-window args`).toBeGreaterThan(0);
    }
  });
});
