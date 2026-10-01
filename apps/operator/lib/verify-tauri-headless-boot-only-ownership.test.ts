/**
 * EI-20226754912676562 — the --boot-only handoff must not be a shared-log
 * export block.
 *
 * Two concurrent callers can redirect stdout to the same path.  Printing raw
 * `export VERIFY_TAURI_*` lines there lets a tail/source workflow import a
 * peer's live bridge PID, port, display, and stop script.  The recurrence
 * guard pins the safer contract: a private per-run env file plus an ownership
 * check against both the current caller and the target process.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SCRIPT = resolve(__dirname, '../../../scripts/verify-tauri-headless.sh');
const src = readFileSync(SCRIPT, 'utf8');
const bootOnlyBranch = src.match(
  /if \[ "\$\{1:-\}" = "--boot-only" \]; then([\s\S]*?)\nfi/,
)?.[1];

describe('EI-20226754912676562 — --boot-only handoff is per-run and owner-verified', () => {
  it('writes a private per-run env file before returning control', () => {
    expect(bootOnlyBranch).toBeTruthy();
    expect(src).toContain('BOOT_ONLY_ENV="$WORK/env.sh"');
    expect(bootOnlyBranch).toContain('write_boot_only_env_script');
    expect(src).toContain('chmod 600 "$BOOT_ONLY_ENV"');
  });

  it('prints a source command for the unique env file, not raw exports to a shared log', () => {
    expect(bootOnlyBranch).toBeTruthy();
    expect(bootOnlyBranch).toContain('printf \'source %q\\n\' "$BOOT_ONLY_ENV"');
    expect(bootOnlyBranch).not.toContain('export VERIFY_TAURI_PID=$VERIFY_TAURI_PID');
    expect(bootOnlyBranch).not.toContain('export VERIFY_TAURI_STOP=$WORK/stop.sh');
  });

  it('re-checks both caller identity and target-process provenance when sourced', () => {
    expect(src).toContain('PAPERCUSP_SID=${PAPERCUSP_SID:-}');
    expect(src).toContain('/proc/$VERIFY_TAURI_PID/environ');
    expect(src).toContain('PAPERCUSP_TAURI_LAUNCH_PROVENANCE=$VERIFY_TAURI_LAUNCH_PROVENANCE');
    expect(src).toContain('VERIFY_TAURI_ENV_FILE points at a verifier owned by another session');
    expect(src).toContain('verify_tauri_assert_owned');
  });
});

describe('WI-10004544 — Xvfb teardown is bound to the originating run', () => {
  const startDisplayServer = src.match(
    /start_display_server\(\) \{([\s\S]*?)^\}/m,
  )?.[1];
  const xvfbStopWriter = src.match(
    /^write_xvfb_stop_script\(\) \{[\s\S]*?^\}/m,
  )?.[0];
  const stopWriter = src.match(
    /^write_stop_script\(\) \{[\s\S]*?^\}/m,
  )?.[0];
  const retryStart = src.indexOf('if [ "$DISPLAY_LOST" = 1 ]; then');
  const retryEnd = src.indexOf('      display_lock_release', retryStart);
  const retryTeardown = retryStart >= 0 && retryEnd > retryStart
    ? src.slice(retryStart, retryEnd)
    : '';

  it('starts Xvfb with a unique run provenance and display marker', () => {
    expect(startDisplayServer).toBeTruthy();
    expect(startDisplayServer).toContain('PAPERCUSP_TAURI_LAUNCH_PROVENANCE');
    expect(startDisplayServer).toContain('PAPERCUSP_VERIFY_XVFB_DISPLAY');
  });

  it('rechecks both markers before TERM and fallback KILL', () => {
    expect(xvfbStopWriter).toBeTruthy();
    expect(xvfbStopWriter).toContain(
      'PAPERCUSP_TAURI_LAUNCH_PROVENANCE=$EXPECTED_PROVENANCE',
    );
    expect(xvfbStopWriter).toContain(
      'PAPERCUSP_VERIFY_XVFB_DISPLAY=$EXPECTED_DISPLAY',
    );
    expect(xvfbStopWriter).toContain('kill -TERM "$xvfb_pid"');
    expect(xvfbStopWriter).toMatch(
      /xvfb_is_owned "\$xvfb_pid"[\s\S]*?kill -KILL "\$xvfb_pid"/,
    );
    expect(xvfbStopWriter).not.toMatch(/pkill\s+-9\s+-f\s+"Xvfb/);
  });

  it('uses the owned helper for final and retry teardown without unlinking shared display files', () => {
    expect(stopWriter).toBeTruthy();
    expect(stopWriter).toContain('"$WORK/stop-xvfb.sh"');
    expect(stopWriter).not.toMatch(/pkill\s+-9\s+-f\s+"Xvfb/);
    expect(stopWriter).not.toContain('rm -f "/tmp/.X11-unix/X$DISPLAY_NUM"');
    expect(stopWriter).not.toContain('"/tmp/.X$DISPLAY_NUM-lock"');

    expect(retryTeardown).toContain('write_xvfb_stop_script');
    expect(retryTeardown).toContain('"$WORK/stop-xvfb.sh"');
    expect(retryTeardown).not.toMatch(/pkill\s+-9\s+-f\s+"Xvfb/);
    expect(retryTeardown).not.toContain('"/tmp/.X$DISPLAY_NUM-lock"');
  });
});
