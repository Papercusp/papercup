/**
 * verify-tauri-headless-bind-retry.test.ts — the RECURRENCE GUARD for
 * EI-18734124566158657.
 *
 * The bug: scripts/verify-tauri-headless.sh picks a free port (fed_pick_free_port)
 * and takes an advisory flock on it (fed_acquire_port_lock), but that lock only
 * protects against a CONCURRENT invocation of THIS SAME script racing for the same
 * port — it does nothing against a squatter that never took the lock at all (a
 * leaked/orphaned sidecar from a crashed prior run, or an unrelated process that
 * happens to bind the same port during the ~2-minute Xvfb+cargo+webview boot
 * between our ss-probe and our sidecar's actual bind). That still surfaced as a
 * FATAL EADDRINUSE ~120s into boot, with no retry — the caller had to notice the
 * non-zero exit and re-run the whole expensive boot by hand.
 *
 * The fix: bound, automatic retry. On detecting the sidecar lost the bind race,
 * tear down this attempt, release the stale port lock, re-pick+re-lock a FRESH
 * port pair (reusing the same pick_and_lock_ports walk-forward the initial pick
 * uses), and re-launch — before surfacing anything as fatal. Only a SECOND loss
 * (default MAX_BOOT_ATTEMPTS=2) is fatal.
 *
 * A `readFileSync` text guard is the right shape here (same rationale as the
 * sibling verify-tauri-headless-*.test.ts): the script boots a real
 * Tauri/Xvfb/sidecar stack, so this wiring can only be asserted at the wiring
 * site, not by running it in CI.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SCRIPT = resolve(__dirname, '../../../scripts/verify-tauri-headless.sh');
const src = readFileSync(SCRIPT, 'utf8');

describe('EI-18734124566158657 — verify-tauri-headless retries once on a bind-time port race', () => {
  it('is the right script (guards a vacuous suite)', () => {
    expect(src).toContain('verify-tauri-headless');
  });

  it('factors the port pick+lock walk-forward into a reusable function', () => {
    const fn = src.match(/pick_and_lock_ports\(\) \{([\s\S]*?)\n\}/)?.[1];
    expect(fn).toBeTruthy();
    expect(fn).toMatch(/fed_pick_free_port "\$PORT_BASE"/);
    expect(fn).toMatch(/fed_acquire_port_lock "\$DEV_PORT" "\$PORT_LOCK_DIR"/);
    expect(fn).toMatch(/fed_acquire_port_lock "\$PTY_PORT" "\$PORT_LOCK_DIR"/);
    // The initial pick calls the same function — one procedure, not a duplicate copy.
    expect(src).toMatch(/\npick_and_lock_ports\n/);
  });

  it('factors launch.sh generation + exec into a reusable function so a retry can re-run it', () => {
    const fn = src.match(/write_and_launch_tauri\(\) \{([\s\S]*?)\n\}/)?.[1];
    expect(fn).toBeTruthy();
    expect(fn).toMatch(/setsid "\$WORK\/launch\.sh" >"\$LOG" 2>&1 &/);
    expect(fn).toMatch(/TAURI_PID=\$!/);
    // Uses the CURRENT DEV_PORT/PTY_PORT at call time (not a value baked in once),
    // so a re-pick before the retry call actually changes what gets launched.
    expect(fn).toMatch(/OPERATOR_DEV_PORT="\$DEV_PORT" OPERATOR_DEV_PTY_PORT="\$PTY_PORT"/);
  });

  it('bounds the boot-attempt loop, configurable, defaulting to one retry', () => {
    expect(src).toMatch(/MAX_BOOT_ATTEMPTS="\$\{VERIFY_TAURI_MAX_BOOT_ATTEMPTS:-2\}"/);
    expect(src).toMatch(/BOOT_ATTEMPTS=0/);
  });

  it('on a bind-time EADDRINUSE with attempts remaining: kills this attempt, releases the lock, re-picks, and CONTINUES (never exits)', () => {
    const loop = src.match(/while :; do\n  BOOT_ATTEMPTS=\$\(\(BOOT_ATTEMPTS \+ 1\)\)([\s\S]*?)\ndone/)?.[1];
    expect(loop).toBeTruthy();

    const retryBranch = loop!.match(
      /if \[ "\$BOOT_ATTEMPTS" -lt "\$MAX_BOOT_ATTEMPTS" \]; then([\s\S]*?)\n {2}fi/,
    )?.[1];
    expect(retryBranch).toBeTruthy();
    expect(retryBranch).toMatch(/kill -TERM -- -\$TAURI_PID/);
    expect(retryBranch).toMatch(/fed_release_port_locks/);
    expect(retryBranch).toMatch(/pick_and_lock_ports/);
    expect(retryBranch).toMatch(/continue/);
    // The retry path must never itself exit — only the post-retry-budget fatal below does.
    expect(retryBranch).not.toMatch(/exit 1/);
  });

  it('only surfaces fatal once the retry budget is exhausted, and says so', () => {
    const loop = src.match(/while :; do\n  BOOT_ATTEMPTS=\$\(\(BOOT_ATTEMPTS \+ 1\)\)([\s\S]*?)\ndone/)?.[1];
    expect(loop).toBeTruthy();
    // The FATAL branch (after the retry-budget guard) — must still exist and exit 1.
    expect(loop).toMatch(/FATAL: our operator sidecar could not bind :\$DEV_PORT \(EADDRINUSE\)/);
    expect(loop).toMatch(/attempt\(s\) across freshly-picked ports/);
    const fatalIdx = loop!.indexOf('FATAL: our operator sidecar could not bind');
    const exitIdx = loop!.indexOf('exit 1', fatalIdx);
    expect(fatalIdx).toBeGreaterThan(-1);
    expect(exitIdx).toBeGreaterThan(fatalIdx);
  });

  it('a clean bind (no EADDRINUSE) breaks the loop and proceeds without retrying', () => {
    const loop = src.match(/while :; do\n  BOOT_ATTEMPTS=\$\(\(BOOT_ATTEMPTS \+ 1\)\)([\s\S]*?)\ndone/)?.[1];
    expect(loop).toBeTruthy();
    expect(loop).toMatch(/if ! grep -qE "EADDRINUSE\.\*:\$DEV_PORT\\b" "\$LOG" 2>\/dev\/null; then\s*\n\s*break/);
  });

  it('non-port-race fatal exits (bridge timeout, tauri exited early) are unchanged — no retry for those', () => {
    const loop = src.match(/while :; do\n  BOOT_ATTEMPTS=\$\(\(BOOT_ATTEMPTS \+ 1\)\)([\s\S]*?)\ndone/)?.[1];
    expect(loop).toBeTruthy();
    expect(loop).toMatch(/tauri dev exited before the bridge came up/);
    expect(loop).toMatch(/bridge did not come up within \$\{TIMEOUT\}s/);
  });
});
