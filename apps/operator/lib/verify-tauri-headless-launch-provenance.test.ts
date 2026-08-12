/**
 * verify-tauri-headless-launch-provenance.test.ts — the RECURRENCE GUARD for
 * EI-20200818150345989.
 *
 * The bug: `tauri-agent-tools probe` exposes healthy bridge PIDs without saying
 * whether a bridge belongs to an agent rig or the owner's live desktop. A peer
 * nearly drove the owner's DISPLAY=:0 window after inferring that an existing
 * bridge was a cheap reusable test rig. The failure was silent and the only
 * protection was another agent noticing the mistake.
 *
 * The fix: verify-tauri-headless.sh requires the tracked caller's PAPERCUSP_SID,
 * stamps it plus a dedicated launch-provenance marker into the child process,
 * matches both values from the target process's own /proc/<pid>/environ, and only
 * then exports VERIFY_TAURI_PID. This text guard pins the handoff wiring without
 * booting a full Tauri/Xvfb stack in the unit suite.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SCRIPT = resolve(__dirname, '../../../scripts/verify-tauri-headless.sh');
const src = readFileSync(SCRIPT, 'utf8');
const bridgeBlock = src.match(
  /BRIDGE_PID=""[\s\S]*?export VERIFY_TAURI_PID="\$BRIDGE_PID"/,
)?.[0];

describe('EI-20200818150345989 — verifier bridge handoff carries launch provenance', () => {
  it('guards the intended script and requires a tracked caller identity', () => {
    expect(src).toContain('verify-tauri-headless');
    expect(src).toContain('TAURI_OWNER_SID="${PAPERCUSP_SID:-}"');
    expect(src).toContain('refusing to launch an unattributed Tauri verifier');
  });

  it('stamps both the existing session identity and a dedicated provenance marker', () => {
    expect(src).toContain('PAPERCUSP_SID="$TAURI_OWNER_SID"');
    expect(src).toContain(
      'PAPERCUSP_TAURI_LAUNCH_PROVENANCE="$TAURI_LAUNCH_PROVENANCE"',
    );
  });

  it('requires display, operator port, SID, and provenance from the target process environment', () => {
    expect(bridgeBlock).toBeTruthy();
    expect(bridgeBlock).toContain('DISPLAY=:$DISPLAY_NUM');
    expect(bridgeBlock).toContain('OPERATOR_DEV_PORT=$DEV_PORT');
    expect(bridgeBlock).toContain('PAPERCUSP_SID=$TAURI_OWNER_SID');
    expect(bridgeBlock).toContain(
      'PAPERCUSP_TAURI_LAUNCH_PROVENANCE=$TAURI_LAUNCH_PROVENANCE',
    );
    expect(bridgeBlock).toContain('/proc/$p/environ');
  });

  it('re-checks provenance immediately before exposing the PID', () => {
    expect(bridgeBlock).toContain('BRIDGE_ENVIRON=');
    expect(bridgeBlock).toContain('/proc/$BRIDGE_PID/environ');
    expect(bridgeBlock).toContain('lost the expected launch provenance');
    expect(bridgeBlock).toContain('export VERIFY_TAURI_PID="$BRIDGE_PID"');
  });

  it('exports the verified identity to assertion and --boot-only callers', () => {
    const bridgeExportIdx = src.indexOf(
      'export VERIFY_TAURI_OWNER_SID="$TAURI_OWNER_SID"',
    );
    const bootOnlyIdx = src.indexOf('if [ "${1:-}" = "--boot-only" ]; then');
    const bootOnlyExportIdx = src.indexOf(
      'export VERIFY_TAURI_OWNER_SID=$VERIFY_TAURI_OWNER_SID',
    );
    expect(bridgeExportIdx).toBeGreaterThan(-1);
    expect(bridgeExportIdx).toBeLessThan(bootOnlyIdx);
    expect(bootOnlyExportIdx).toBeGreaterThan(bootOnlyIdx);
    expect(src).toContain(
      'export VERIFY_TAURI_LAUNCH_PROVENANCE=$VERIFY_TAURI_LAUNCH_PROVENANCE',
    );
  });
});
