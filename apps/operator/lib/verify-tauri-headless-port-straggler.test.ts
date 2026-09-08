/**
 * verify-tauri-headless-port-straggler.test.ts — the RECURRENCE GUARD for EI-11559.
 *
 * The bug: scripts/verify-tauri-headless.sh derives its dev/pty ports FROM THE
 * DISPLAY number (WI-4342), and releases its advisory port lock the instant
 * teardown signals the tauri process group. But the operator sidecar
 * (papercusp-desktop/bin/dev-operator-ifneeded.sh) runs in its OWN process group
 * behind a detached reaper + a restart-on-nonzero supervision loop, so it can keep
 * DEV_PORT/PTY_PORT bound for SECONDS after that signal — "the squatter that only
 * exists during someone's boot/teardown window". When Xvfb (the display) is killed
 * while that sidecar straggles, the NEXT run reusing the now-free display derives
 * the SAME port, sees it free at pick-time, acquires the now-free lock, and dies
 * FATAL EADDRINUSE at BIND-time ~100s later (observed 2026-07-13 on display :90 /
 * port :33700 across two consecutive --boot-only runs).
 *
 * The fix: HOLD the advisory port lock until OUR derived ports are actually free.
 * The still-held flock then forces a concurrent run onto a disjoint port via the
 * existing pick-time walk-forward loop (fed_acquire_port_lock fails → PORT_BASE
 * walks forward). Applied to BOTH teardown paths:
 *   • normal `--` run: teardown() runs wait_owned_ports_free BEFORE
 *     fed_release_port_locks;
 *   • `--boot-only`: the lock keeper holds the lock for the LIFETIME OF THE DISPLAY
 *     (XVFB_PID, not the early-exiting tauri-dev wrapper TAURI_PID — WI-4975) and
 *     then drains the port before exiting; stop.sh no longer force-kills the keeper
 *     (which would release the flock immediately).
 * The wait is PASSIVE (the sidecar's own reaper does the killing) and bounded, so a
 * genuinely wedged port only delays teardown, never deadlocks it — and it can never
 * tear down a live --boot-only app (WI-4975 safe).
 *
 * A `readFileSync` text guard is the right shape here (same rationale as the sibling
 * verify-tauri-headless-*.test.ts): the script boots a real Tauri/Xvfb/sidecar
 * stack, so its teardown wiring can only be asserted at the wiring site, not by
 * running it in CI.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SCRIPT = resolve(__dirname, '../../../scripts/verify-tauri-headless.sh');
const src = readFileSync(SCRIPT, 'utf8');

describe('EI-11559 — verify-tauri-headless holds the port lock until its sidecar releases the port', () => {
  it('is the right script (guards a vacuous suite)', () => {
    expect(src).toContain('verify-tauri-headless');
    // The whole premise: ports are DERIVED from the display, so a straggler on a
    // reused display collides. If this coupling is gone, revisit the guard.
    // EI-18816386093046558 bounded the derivation into a wrapped 60-slot window
    // (PORT_SLOT then PORT_BASE) instead of the original single-line unbounded
    // formula this regex used to match — same premise (display -> port), new shape.
    expect(src).toMatch(/PORT_SLOT=\$\(\( \(DISPLAY_NUM - 90\) % 60 \)\)/);
    expect(src).toMatch(/PORT_BASE=\$\(\( 33700 \+ PORT_SLOT \* 10 \)\)/);
  });

  it('normal teardown holds the lock: it drains the ports BEFORE releasing the flock', () => {
    const teardown = src.match(/teardown\(\) \{([\s\S]*?)\n\}/)?.[1];
    expect(teardown).toBeTruthy();
    const waitIdx = teardown!.indexOf('wait_owned_ports_free');
    const releaseIdx = teardown!.indexOf('fed_release_port_locks');
    expect(waitIdx).toBeGreaterThan(-1);
    expect(releaseIdx).toBeGreaterThan(-1);
    // The drain must precede the release — that ordering IS the fix.
    expect(waitIdx).toBeLessThan(releaseIdx);
  });

  it('the pre-fix race is gone: teardown never releases the lock immediately after stop.sh', () => {
    const teardown = src.match(/teardown\(\) \{([\s\S]*?)\n\}/)?.[1];
    // The exact bug: `"$WORK/stop.sh" …` directly followed by `fed_release_port_locks`,
    // with no port drain in between — the sidecar straggler outlives the lock.
    expect(teardown).not.toMatch(/"\$WORK\/stop\.sh"[^\n]*\n\s*fed_release_port_locks/);
  });

  it('the drain waits on BOTH derived ports, while they are LISTENING, bounded', () => {
    const fn = src.match(/wait_owned_ports_free\(\) \{([\s\S]*?)\n\}/)?.[1];
    expect(fn).toBeTruthy();
    expect(fn).toMatch(/for port in "\$DEV_PORT" "\$PTY_PORT"/);
    expect(fn).toMatch(/while port_is_listening "\$port" && \[ "\$waited" -lt "\$PORT_STRAGGLER_WAIT" \]/);
    // LISTENING, not TIME_WAIT — a fresh listener only fails EADDRINUSE against an
    // actual LISTEN squatter (ss -l).
    expect(src).toMatch(/port_is_listening\(\) \{ ss -tlnH "sport = :\$1"/);
  });

  it('the drain bound is operator-configurable and defaults sanely (exits early on free)', () => {
    expect(src).toMatch(/PORT_STRAGGLER_WAIT="\$\{VERIFY_TAURI_PORT_STRAGGLER_WAIT:-30\}"/);
  });

  it('--boot-only keeper holds the lock for the DISPLAY lifetime, then drains the port', () => {
    const bootBranch = src.match(/if \[ "\$\{1:-\}" = "--boot-only" \]; then([\s\S]*?)\nfi/)?.[1];
    expect(bootBranch).toBeTruthy();
    // Watch the display (XVFB_PID) — the collision-relevant resource — then drain,
    // so the lock is held from Xvfb-death through port-free.
    expect(bootBranch).toMatch(
      /while kill -0 "\$XVFB_PID" 2>\/dev\/null; do sleep 2; done\s*\n\s*wait_owned_ports_free/,
    );
    // NOT the tauri-dev wrapper: it can exit early on handoff, which would release
    // the lock mid-session (before Xvfb + straggler are torn down) — the hole.
    expect(bootBranch).not.toMatch(/while kill -0 "\$TAURI_PID"/);
  });

  it('stop.sh no longer force-kills the keeper (which released the flock immediately)', () => {
    const stopScript = src.match(/cat > "\$WORK\/stop\.sh" <<STOP([\s\S]*?)\nSTOP/)?.[1];
    expect(stopScript).toBeTruthy();
    // The non-fix: killing the keeper releases the advisory lock at once, while the
    // sidecar still holds the port — exactly what let the straggler poison the next run.
    expect(stopScript).not.toMatch(/kill "\$PORT_LOCK_KEEPER_PID"/);
  });

  it('escape-sidecar cleanup requires this invocation provenance as well as the reused port', () => {
    const stopScript = src.match(/cat > "\$WORK\/stop\.sh" <<STOP([\s\S]*?)\nSTOP/)?.[1];
    expect(stopScript).toBeTruthy();
    const provenanceChecks = stopScript!.match(
      /grep -qxF "PAPERCUSP_TAURI_LAUNCH_PROVENANCE=\$TAURI_LAUNCH_PROVENANCE"/g,
    );
    expect(provenanceChecks).toHaveLength(2);
    expect(stopScript).toContain('OPERATOR_DEV_PORT=$DEV_PORT');
  });
});
