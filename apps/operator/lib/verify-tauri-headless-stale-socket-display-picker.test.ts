/**
 * verify-tauri-headless-stale-socket-display-picker.test.ts — the RECURRENCE
 * GUARD for EI-16466.
 *
 * The bug: scripts/verify-tauri-headless.sh --boot-only picked display :90 and
 * failed with "FATAL: Xvfb :90 never came up" — xvfb.log showed
 * "_XSERVTransSocketOpenCOTSServer: Unable to open socket ... Cannot establish
 * any listening sockets - Make sure an X server isn't already running".
 *
 * Root cause: the auto-picker loop only checked `DISPLAY=:$N xdpyinfo` to decide
 * if a display number is free. /tmp/.X11-unix/X90 was a STALE unix-socket file
 * (no lock file /tmp/.X90-lock, no live Xvfb/Xorg process) left behind by some
 * earlier crashed/killed Xvfb (the WI-2115 leaked-Xvfb lesson this same script's
 * header already warns about). xdpyinfo correctly reports no live server there,
 * so the picker judged :90 "free" and handed it to Xvfb, which then can't bind
 * because the orphaned socket file is still on disk. This leaks routinely across
 * the fleet's many isolated Tauri verification runs (17 stray sockets observed on
 * one box), not a one-off.
 *
 * The fix: the picker loop ALSO treats `[ -S /tmp/.X11-unix/X$DISPLAY_NUM ]` (a
 * stale socket file present) as "occupied", in addition to the xdpyinfo live-probe
 * — so it walks past a stale display number instead of colliding with it. Does
 * NOT attempt to clean up someone else's leaked socket — only stops reusing the
 * number (out of scope: the underlying leak itself, i.e. Xvfb dying without its
 * socket+lock being removed on a hard kill that skips the script's own EXIT trap).
 *
 * A `readFileSync` text guard is the right shape here (same rationale as the
 * sibling verify-tauri-headless-*.test.ts): the script boots a real Xvfb/Tauri
 * stack, so its display-picker wiring can only be asserted at the wiring site,
 * not by running a live boot in CI.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SCRIPT = resolve(__dirname, '../../../scripts/verify-tauri-headless.sh');
const src = readFileSync(SCRIPT, 'utf8');

describe('EI-16466 — verify-tauri-headless display picker skips stale leaked Xvfb sockets', () => {
  it('is the right script (guards a vacuous suite)', () => {
    expect(src).toContain('verify-tauri-headless');
    expect(src).toMatch(/DISPLAY_NUM=90/);
  });

  it('the auto-pick loop treats a stale /tmp/.X11-unix socket file as occupied, not just a live xdpyinfo probe', () => {
    const loop = src.match(
      /while x_display_taken "\$DISPLAY_NUM"; do[\s\S]*?\n\s*done/,
    )?.[0];
    expect(loop).toBeTruthy();
    // The exact fix: the picker delegates occupancy to a predicate that includes
    // both the live-server probe and stale socket files.
    expect(loop).toContain('x_display_taken "$DISPLAY_NUM" || break');
    expect(src).toContain('[ -S "/tmp/.X11-unix/X$1" ] && return 0');
  });

  it('the pre-fix bug is gone: the loop delegates occupancy to the shared predicate', () => {
    const loopLine = src.split('\n').find((l) => l.includes('while x_display_taken "$DISPLAY_NUM"'));
    expect(loopLine).toBeTruthy();
    expect(loopLine).not.toContain('xdpyinfo');
    const taken = src.match(/x_display_taken\(\)\s*\{[\s\S]*?\n\}/)?.[0];
    expect(taken).toBeTruthy();
    expect(taken).toContain('xdpyinfo');
    expect(taken).toContain('[ -S "/tmp/.X11-unix/X$1" ] && return 0');
  });

  it('picker still starts at :90 and walks forward past any occupied number', () => {
    expect(src).toMatch(/DISPLAY_NUM=90\s*\n\s*while[\s\S]*?\n\s*DISPLAY_NUM=\$\(\(DISPLAY_NUM \+ 1\)\)\s*\n\s*done/);
  });
});
