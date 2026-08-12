/**
 * Recurrence guard for EI-20237827969985420.
 *
 * A verifier killed during its boot poll must never report a clean exit or
 * run teardown twice. The real script boots a Tauri/Xvfb/sidecar stack, so a
 * source-level guard is the reliable CI shape: it pins the signal mapping,
 * the single EXIT cleanup owner, and the trap reset that prevents recursion.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SCRIPT = resolve(__dirname, '../../../scripts/verify-tauri-headless.sh');
const src = readFileSync(SCRIPT, 'utf8');
const signalCode = src.match(/signal_exit_code\(\) \{([\s\S]*?)\n\}/)?.[1] ?? '';
const signalHandler = src.match(/handle_signal\(\) \{([\s\S]*?)\n\}/)?.[1] ?? '';
const teardown = src.match(/teardown\(\) \{([\s\S]*?)\n\}/)?.[1] ?? '';

describe('EI-20237827969985420 — signal termination is a failed verifier run', () => {
  it('guards the intended script rather than a vacuous fixture', () => {
    expect(src).toContain('verify-tauri-headless');
    expect(src).toContain('SIGNAL_EXIT_CODE=0');
  });

  it('maps every trappable termination signal to a nonzero shell status', () => {
    expect(signalCode).toMatch(/HUP\)\s*printf '129\\n'/);
    expect(signalCode).toMatch(/INT\)\s*printf '130\\n'/);
    expect(signalCode).toMatch(/TERM\)\s*printf '143\\n'/);
    expect(signalCode).toMatch(/\*\)\s*printf '1\\n'/);
  });

  it('uses one EXIT trap for cleanup and separate signal traps for disposition', () => {
    expect(src).toMatch(/trap teardown EXIT\s*trap 'handle_signal INT' INT\s*trap 'handle_signal TERM' TERM\s*trap 'handle_signal HUP' HUP/);
    expect(src).not.toContain('trap teardown EXIT INT TERM');
  });

  it('preserves the signal status instead of trusting the last successful poll command', () => {
    expect(teardown).toContain('local ec=$?');
    expect(teardown).toContain('[ "$SIGNAL_EXIT_CODE" -ne 0 ] && ec="$SIGNAL_EXIT_CODE"');
    expect(signalHandler).toContain('SIGNAL_EXIT_CODE="$(signal_exit_code "$1")"');
    expect(signalHandler).toMatch(/trap - INT TERM HUP[\s\S]*exit "\$SIGNAL_EXIT_CODE"/);
  });

  it('disarms all traps before cleanup so a signal cannot recurse through EXIT', () => {
    const disarm = teardown.indexOf('trap - EXIT INT TERM HUP');
    const cleanup = teardown.indexOf('write_stop_script');
    expect(disarm).toBeGreaterThan(-1);
    expect(cleanup).toBeGreaterThan(disarm);
  });
});
