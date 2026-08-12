/**
 * WI-4975: a background subshell inherits its parent's EXIT trap. The
 * --boot-only port-lock keeper must clear teardown before waiting, otherwise
 * a normal wrapper exit destroys the isolated app it just handed to the user.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SCRIPT = resolve(__dirname, '../../../scripts/verify-tauri-headless.sh');
const src = readFileSync(SCRIPT, 'utf8');

describe('WI-4975 — verify-tauri-headless --boot-only keeps the isolated app alive', () => {
  it('detaches the display and window manager from the launcher terminal', () => {
    expect(src).toMatch(/start_verify_process "\$\{VERIFY_SCOPE_BASE\}-xvfb"/);
    expect(src).toMatch(/start_verify_process "\$\{VERIFY_SCOPE_BASE\}-openbox"/);
  });

  it('escapes every long-lived verifier process into a sibling user scope when available', () => {
    expect(src).toContain('systemd-run --user --scope --quiet --collect');
    expect(src).toContain('--slice="$VERIFY_SCOPE_SLICE"');
    expect(src).toContain('VERIFY_SCOPE_SLICE="papercusp-agent-session.slice"');
    expect(src).toMatch(/TAURI_SCOPE_UNIT="\$\{VERIFY_SCOPE_BASE\}-tauri-\$\{BOOT_ATTEMPTS\}"/);
    expect(src).toContain('systemd-run --user --scope --quiet --collect --unit="${VERIFY_SCOPE_BASE}-probe"');
  });

  it('leaves a provenance-aware liveness check for boot-only callers', () => {
    expect(src).toContain('VERIFY_TAURI_LIVENESS_CHECK');
    expect(src).toContain('verifier bridge PID \\$PID is gone');
    expect(src).toContain('PID may have been reused; refusing to drive another bridge');
    expect(src).toContain('PAPERCUSP_TAURI_LAUNCH_PROVENANCE=\\$EXPECTED_PROVENANCE');
    expect(src).toContain('before every tauri-agent-tools eval/check/click/type/capture');
  });

  it('clears teardown traps inside the background keeper before it can exit', () => {
    const branch = src.match(/if \[ "\$\{1:-\}" = "--boot-only" \]; then([\s\S]*?)\nfi/)?.[1];
    expect(branch).toBeTruthy();
    // The trap-clear is the FIRST statement inside the keeper subshell, before its
    // wait — so a normal wrapper exit can never tear down the isolated app. EI-11559
    // switched the keeper to watch the DISPLAY (XVFB_PID) rather than the tauri-dev
    // wrapper (TAURI_PID, which can exit early on handoff); the WI-4975 property is
    // unchanged.
    expect(branch).toMatch(/\(\s*trap - EXIT INT TERM\s*\n\s*while kill -0 "\$XVFB_PID"[^;]*; do sleep 2; done/);
  });

  it('does not start the keeper before clearing only the parent trap', () => {
    expect(src).not.toMatch(
      /\(\s*while kill -0 "\$XVFB_PID"[\s\S]*?\) &\s*\n\s*PORT_LOCK_KEEPER_PID=\$!\s*\n\s*trap - EXIT INT TERM/,
    );
  });
});
