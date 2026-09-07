/**
 * Recurrence guard for EI-21590235587564636.
 *
 * The verifier source is read lazily by bash. An in-place peer save during the
 * multi-minute Tauri boot can therefore splice a partial line into the running
 * script even though the source was valid at launch. The SPA snapshot guard
 * protects the bundle served by the rig, but it cannot protect this wrapper's
 * own source. Pin the startup snapshot/re-exec contract on the real script.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SCRIPT = resolve(__dirname, '../../../scripts/verify-tauri-headless.sh');
const src = readFileSync(SCRIPT, 'utf8');

const snapshotGuardIdx = src.indexOf('VERIFY_TAURI_SOURCE_SNAPSHOT_PATH=');
const argumentParserIdx = src.indexOf('if [ "${1:-}" = "--help" ]');
const installPreflightIdx = src.indexOf('install_in_flight_preflight || exit $?');
const workAllocationIdx = src.indexOf('WORK="$(mktemp -d');
const sourceReexecIdx = src.indexOf('exec bash "$VERIFY_TAURI_SOURCE_SNAPSHOT_PATH" "$@"');
const assertionExecIdx = src.lastIndexOf('log "running assertion command: $*"');
const operatorSnapshotIdx = src.indexOf('snapshot_operator_source() {');
const operatorSnapshotCallIdx = src.indexOf('snapshot_operator_source || exit $?');
const operatorSnapshotSource = src.slice(operatorSnapshotIdx, operatorSnapshotCallIdx);

describe('EI-21590235587564636 — verifier source is immutable for the run', () => {
  it('captures and syntax-checks the source before parsing arguments or allocating resources', () => {
    expect(snapshotGuardIdx).toBeGreaterThan(-1);
    expect(argumentParserIdx).toBeGreaterThan(snapshotGuardIdx);
    expect(src).toContain('cp -- "$VERIFY_TAURI_SOURCE_PATH" "$VERIFY_TAURI_SOURCE_SNAPSHOT_PATH"');
    expect(src).toContain('bash -n -- "$VERIFY_TAURI_SOURCE_SNAPSHOT_PATH"');
    expect(installPreflightIdx).toBeGreaterThan(snapshotGuardIdx);
    expect(workAllocationIdx).toBeGreaterThan(snapshotGuardIdx);
  });

  it('re-execs the frozen copy before the mutable checkout can reach the long-lived path', () => {
    expect(sourceReexecIdx).toBeGreaterThan(snapshotGuardIdx);
    expect(sourceReexecIdx).toBeLessThan(argumentParserIdx);
    expect(sourceReexecIdx).toBeLessThan(assertionExecIdx);
    expect(src).toContain('export VERIFY_TAURI_SOURCE_SNAPSHOT_PATH VERIFY_TAURI_ORIGINAL_REPO_DIR');
    // A temp snapshot changes BASH_SOURCE[0]; preserve the original repo root
    // so the re-exec still loads the intended desktop sidecar and dependencies.
    expect(src).toContain('VERIFY_TAURI_ORIGINAL_REPO_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)');
  });

  it('cleans the source snapshot on both normal teardown and boot-only handoff', () => {
    expect(src).toContain('cleanup_verifier_source_snapshot');
    const teardownIdx = src.indexOf('teardown() {');
    expect(src.indexOf('cleanup_verifier_source_snapshot', teardownIdx)).toBeGreaterThan(teardownIdx);
    const bootOnlyExitIdx = src.indexOf('cleanup_verifier_source_snapshot\n  exit 0', argumentParserIdx);
    expect(bootOnlyExitIdx).toBeGreaterThan(argumentParserIdx);
  });
});

describe('EI-22586651291409125 — derived indexes stay out of the immutable operator snapshot', () => {
  it('excludes and defensively removes .gitnexus before the isolated sidecar boots', () => {
    expect(operatorSnapshotIdx).toBeGreaterThan(-1);
    expect(operatorSnapshotCallIdx).toBeGreaterThan(operatorSnapshotIdx);
    expect(operatorSnapshotSource).toContain("--exclude='.gitnexus'");
    expect(operatorSnapshotSource).toContain('"$snapshot_root/.gitnexus"');
  });
});

describe('EI-22587788892654404 — a repo-local temp root cannot enter its own snapshot', () => {
  it('excludes and defensively removes local Papercusp state before the isolated sidecar boots', () => {
    expect(operatorSnapshotSource).toContain("--exclude='.papercusp'");
    expect(operatorSnapshotSource).toContain('"$snapshot_root/.papercusp"');
  });
});
