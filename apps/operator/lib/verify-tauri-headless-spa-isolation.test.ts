/**
 * verify-tauri-headless-spa-isolation.test.ts — the RECURRENCE GUARD for EI-10364.
 *
 * The bug: scripts/verify-tauri-headless.sh boots an "isolated" desktop instance
 * (own X display, own devUrl/pty ports, own operator sidecar *process*) — but at
 * the SPA/module layer it was NOT isolated. Its launch env pinned /api + content
 * to the isolated sidecar (PAPERCUSP_DEV_API_TARGET) yet never set
 * PAPERCUSP_SPA_DIST, so host-spa.ts's resolveSpaDistRoot() fell through to the
 * SHARED apps/operator-vite/dist/ — the very bundle the fleet's `vite build
 * --watch` continuously rewrites and empties. The "isolated" webview therefore
 * 404'd its lazy chunks mid-run ("Importing a module script failed", EI-10360)
 * and flip-flopped between stale and fresh modules, so a verification run was a
 * coin-flip and could even report a broken thing as fixed.
 *
 * The fix: freeze a per-run PRIVATE snapshot of the shared dist into $WORK/spa
 * (the shared watcher can't touch it) and point the isolated sidecar at it via
 * PAPERCUSP_SPA_DIST. So this suite pins, on the REAL script, the invariants that
 * make the SPA layer genuinely isolated — and, crucially, the NEGATIVE invariant
 * that catches both the original bug (no pin at all) and the naive non-fix
 * (pinning PAPERCUSP_SPA_DIST straight at the shared dist, which isolates
 * nothing). A `readFileSync` text guard is the right shape here: the script boots
 * a real Tauri/Xvfb stack, so its module-server wiring can only be asserted at
 * the wiring site, not by running it (same rationale as tty-title-target.test.ts).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SCRIPT = resolve(__dirname, '../../../scripts/verify-tauri-headless.sh');
const src = readFileSync(SCRIPT, 'utf8');
const DESKTOP_MAIN = resolve(__dirname, '../../../papercusp-desktop/src-tauri/src/main.rs');
const ENV_SWITCH = resolve(__dirname, '../../../papercusp-desktop/src-tauri/src/env_switch.rs');
const desktopMain = readFileSync(DESKTOP_MAIN, 'utf8');
const envSwitch = readFileSync(ENV_SWITCH, 'utf8');

describe('EI-10364 — verify-tauri-headless isolates the SPA module server', () => {
  it('is the right script (guards a vacuous suite)', () => {
    expect(src).toContain('verify-tauri-headless');
    // The two-part isolation is coherent only if content is ALSO pinned to the
    // isolated sidecar; a bare SPA snapshot with content pointed elsewhere would
    // still load the shared modules.
    expect(src).toContain('PAPERCUSP_DEV_API_TARGET="$DEV_PORT"');
  });

  it('pins the isolated sidecar at its OWN SPA snapshot (PAPERCUSP_SPA_DIST)', () => {
    // The pin must reach the launched instance's env. Without it the sidecar's
    // resolveSpaDistRoot() falls through to the shared apps/operator-vite/dist/.
    expect(src).toContain('PAPERCUSP_SPA_DIST');
    expect(src).toMatch(/SPA_ENV_LINE=.*PAPERCUSP_SPA_DIST=/);
  });

  it('freezes the snapshot into a PER-RUN private dir, sourced from the shared dist', () => {
    // Private, per-run (under the mktemp $WORK) — not a shared/global path.
    expect(src).toMatch(/SPA_DIST="\$WORK\/spa"/);
    // Sourced by copying the shared build output, so the snapshot is fresh at boot…
    expect(src).toContain('apps/operator-vite/dist');
    expect(src).toMatch(/cp -a "\$SHARED_SPA_DIST\/\." "\$SPA_DIST\/"/);
  });

  it('NEVER pins PAPERCUSP_SPA_DIST straight at the shared dist (the bug + the naive non-fix)', () => {
    // The value the sidecar serves must be the private snapshot ($SPA_DIST), never
    // the shared apps/operator-vite/dist/ that the fleet watcher overwrites. Both
    // the original bug (no pin ⇒ shared-dist fallback) and the naive "fix" (pin →
    // shared dist) leave the SPA layer un-isolated; this catches both.
    expect(src).not.toMatch(/PAPERCUSP_SPA_DIST=["']?\$\{?SHARED_SPA_DIST/);
    expect(src).not.toMatch(/PAPERCUSP_SPA_DIST=["']?[^"'\s]*apps\/operator-vite\/dist/);
    // `\b` anchors this to a STANDALONE `SPA_DIST=` assignment. Without it, the
    // pattern also matches a SUBSTRING of the legitimate freshness-check line
    // `SHARED_SPA_DIST="$SHARED_SPA_DIST"` (EI-17134) — SHARED_SPA_DIST ends in
    // SPA_DIST — a false positive that has nothing to do with what the sidecar
    // serves. The boundary still catches the real naive non-fix (a bare
    // `SPA_DIST="$SHARED_SPA_DIST"` pinning the private snapshot at the shared dist).
    expect(src).not.toMatch(/\bSPA_DIST="\$SHARED_SPA_DIST"/);
    // The pin must resolve to the frozen snapshot variable.
    expect(src).toMatch(/SPA_ENV_LINE="PAPERCUSP_SPA_DIST=\\"\$SPA_DIST\\""/);
  });

  it('degrades safely when no build exists: no snapshot ⇒ no pin (SPA_DIST stays empty)', () => {
    // If operator-vite was never built there is nothing to freeze; the pin line
    // must disappear entirely rather than point at a bogus/empty dir.
    expect(src).toMatch(/SPA_DIST=""/);
    expect(src).toMatch(/\[ -n "\$SPA_DIST" \] && SPA_ENV_LINE=/);
  });
});

describe('EI-22626134896342971 — explicit dev target is selected before endpoint IPC starts', () => {
  it('primes the custom /api port before constructing the dev IPC supervisor', () => {
    const devIpcSection = desktopMain.indexOf('// DEV endpoint-IPC:');
    const primeTarget = desktopMain.indexOf('env_switch::prime_explicit_api_target();', devIpcSection);
    const constructClient = desktopMain.indexOf('IpcClientHandle::new', devIpcSection);

    expect(devIpcSection).toBeGreaterThan(-1);
    expect(primeTarget).toBeGreaterThan(devIpcSection);
    expect(constructClient).toBeGreaterThan(primeTarget);
  });

  it('maps and stores the validated override before the supervisor can read it', () => {
    expect(envSwitch).toMatch(/pub\(crate\) fn prime_explicit_api_target\(\)/);
    expect(envSwitch).toMatch(/startup_api_port\(Some\(target_port\), current\)/);
    expect(envSwitch).toMatch(/SELECTED_API_PORT\.store\(api_port, Ordering::Relaxed\)/);
  });
});
