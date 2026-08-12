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
