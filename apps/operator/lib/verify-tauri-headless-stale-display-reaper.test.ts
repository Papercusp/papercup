/**
 * verify-tauri-headless-stale-display-reaper.test.ts — the RECURRENCE GUARD for
 * EI-18738872670541790.
 *
 * The bug: a leaked Xvfb (display :93, pid observed up 7.5+ days) from a
 * verify-tauri-headless.sh run that died without reaching its teardown trap (or a
 * --boot-only caller who never ran the printed stop script) sits there FOREVER —
 * the auto-picker's existing "occupied" check (live xdpyinfo probe OR a stale
 * socket file, EI-16466's own fix) correctly treats a genuinely-live Xvfb as
 * occupied and walks past it, but nothing ever RECLAIMS it. On a box running many
 * concurrent isolated verifiers this permanently narrows the picker's pool by one
 * display per leak, and the failure it eventually causes (pool exhaustion) is
 * misattributed to whoever draws the short straw next, not to the leak.
 *
 * The fix: a conservative two-signal reaper. A candidate display is reclaimed
 * ONLY when BOTH hold: (a) no live papercusp-desktop app or bin/hono-host.ts
 * sidecar is actually attached to that DISPLAY right now (display_has_owning_app
 * — openbox deliberately does NOT count, since it comes up before the app does,
 * so counting it would treat a still-booting OR crashed-before-app-launch
 * instance as "owned" forever), AND (b) its Xvfb has been running longer than
 * VERIFY_TAURI_STALE_DISPLAY_MAX_AGE_SEC (default 3600s). Either signal alone is
 * not proof of abandonment — a wrong kill on a shared box destroys a peer's
 * in-flight work — so both must agree before anything is touched. Kills are by
 * EXACT pid discovered via /proc/<pid>/environ DISPLAY-matching (the same
 * technique this script already uses for BRIDGE_PID/SIDECAR_PID), never a broad
 * pattern-kill.
 *
 * A `readFileSync` text guard is the right shape here (same rationale as every
 * sibling verify-tauri-headless-*.test.ts, including the EI-16466 stale-socket
 * one this reaper sits right next to): the script boots a real Xvfb/Tauri stack,
 * so its display-picker wiring can only be asserted at the wiring site, not by
 * running a live multi-day-leak scenario in CI. (The reaper's actual kill/age
 * logic was functionally verified live against a real throwaway Xvfb instance —
 * see the EI's completion evidence — which this static guard complements rather
 * than duplicates.)
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SCRIPT = resolve(__dirname, '../../../scripts/verify-tauri-headless.sh');
const src = readFileSync(SCRIPT, 'utf8');

describe('EI-18738872670541790 — verify-tauri-headless reclaims an abandoned (not just stale-socket) leaked display', () => {
  it('is the right script (guards a vacuous suite)', () => {
    expect(src).toContain('verify-tauri-headless');
    expect(src).toContain('reap_stale_display_if_abandoned');
  });

  it('the picker loop attempts to reclaim before falling back to skipping past the display', () => {
    const loop = src.match(
      /while DISPLAY=":\$DISPLAY_NUM" xdpyinfo >\/dev\/null 2>&1[\s\S]*?\n\s*done/,
    )?.[0];
    expect(loop).toBeTruthy();
    expect(loop).toContain('reap_stale_display_if_abandoned "$DISPLAY_NUM" && break');
    // The pre-existing stale-socket skip (EI-16466) must still be intact alongside it.
    expect(loop).toMatch(/\|\|\s*\[\s*-S\s*"\/tmp\/\.X11-unix\/X\$DISPLAY_NUM"\s*\]/);
  });

  it('a display with no live Xvfb is never touched (only "just skip past it" applies, as before)', () => {
    const fn = src.match(/reap_stale_display_if_abandoned\(\)\s*\{[\s\S]*?\n\}/)?.[0];
    expect(fn).toBeTruthy();
    expect(fn).toMatch(/xvfb_pid="\$\(pgrep -f "Xvfb :\$n " 2>\/dev\/null \| head -1\)"/);
    expect(fn).toMatch(/\[ -n "\$xvfb_pid" \] \|\| return 1/);
  });

  it('reclaiming requires BOTH no owning app AND an age past the configurable threshold', () => {
    const fn = src.match(/reap_stale_display_if_abandoned\(\)\s*\{[\s\S]*?\n\}/)?.[0];
    expect(fn).toBeTruthy();
    expect(fn).toContain('display_has_owning_app "$n" && return 1');
    expect(fn).toMatch(/\[ "\$age" -ge "\$STALE_DISPLAY_MAX_AGE" \] \|\| return 1/);
  });

  it('the age threshold is configurable via VERIFY_TAURI_STALE_DISPLAY_MAX_AGE_SEC, default 3600', () => {
    expect(src).toContain('STALE_DISPLAY_MAX_AGE="${VERIFY_TAURI_STALE_DISPLAY_MAX_AGE_SEC:-3600}"');
    expect(src).toContain('VERIFY_TAURI_STALE_DISPLAY_MAX_AGE_SEC');
  });

  it('owning-app detection checks the real app/sidecar processes, and deliberately excludes openbox', () => {
    const fn = src.match(/display_has_owning_app\(\)\s*\{[\s\S]*?\n\}/)?.[0];
    expect(fn).toBeTruthy();
    expect(fn).toContain('debug/papercusp-desktop');
    expect(fn).toContain('bin/hono-host.ts');
    expect(fn).not.toContain('openbox');
  });

  it('any kill is by an exact pid discovered via DISPLAY-matching, never a broad pkill pattern', () => {
    const fn = src.match(/reap_stale_display_if_abandoned\(\)\s*\{[\s\S]*?\n\}/)?.[0];
    expect(fn).toBeTruthy();
    expect(fn).toContain('kill -9 "$xvfb_pid"');
    expect(fn).toContain('kill -9 "$ob_pid"');
    expect(fn).not.toMatch(/pkill\s+-9\s+-f\s+"Xvfb/); // that broad form is reserved for OWN-display teardown only
    // the socket this run's own display bound to is cleaned up on reclaim
    expect(fn).toContain('rm -f "/tmp/.X11-unix/X$n"');
  });

  it('find_pid_by_display_env matches an EXACT DISPLAY value, not a substring (so :93 never matches :930)', () => {
    const fn = src.match(/find_pid_by_display_env\(\)\s*\{[\s\S]*?\n\}/)?.[0];
    expect(fn).toBeTruthy();
    expect(fn).toContain('grep -qxF "DISPLAY=$want_display"');
  });
});
