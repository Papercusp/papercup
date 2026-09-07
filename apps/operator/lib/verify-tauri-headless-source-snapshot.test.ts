/**
 * Recurrence guard for EI-21590235587564636.
 *
 * The verifier source is read lazily by bash. An in-place peer save during the
 * multi-minute Tauri boot can therefore splice a partial line into the running
 * script even though the source was valid at launch. The SPA snapshot guard
 * protects the bundle served by the rig, but it cannot protect this wrapper's
 * own source. Pin the startup snapshot/re-exec contract on the real script.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

describe('EI-22588292228855829 — dependency snapshot stays on the donor filesystem', () => {
  const chooserStart = src.indexOf('select_verifier_work_root() {');
  const chooserEnd = src.indexOf('WORK_ROOT="$(select_verifier_work_root)"', chooserStart);

  function chooseRoot(crossDevice: boolean, fallbackCrossDevice = false) {
    const fixture = mkdtempSync(resolve(tmpdir(), 'verifier-work-root-'));
    const donor = resolve(fixture, 'donor');
    const preferred = resolve(fixture, 'preferred');
    mkdirSync(donor);
    mkdirSync(preferred);
    try {
      expect(chooserStart).toBeGreaterThan(-1);
      expect(chooserEnd).toBeGreaterThan(chooserStart);
      // Exercise the actual shell chooser with deterministic mount identities.
      // No snapshot/build process is launched, and no real mount is required.
      const result = spawnSync('bash', ['-c', [
        'stat() {',
        '  if [ "$4" = "$REPO_DIR" ]; then printf "1\\n";',
        '  elif [ "$4" = "$TMPDIR" ]; then printf "%s\\n" "$TEST_PREFERRED_DEVICE";',
        '  else printf "%s\\n" "$TEST_FALLBACK_DEVICE"; fi',
        '}',
        src.slice(chooserStart, chooserEnd),
        'select_verifier_work_root',
      ].join('\n')], {
        encoding: 'utf8',
        env: {
          ...process.env,
          REPO_DIR: donor,
          TMPDIR: preferred,
          TEST_PREFERRED_DEVICE: crossDevice ? '2' : '1',
          TEST_FALLBACK_DEVICE: fallbackCrossDevice ? '2' : '1',
        },
      });
      return { ...result, donor, preferred };
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  }

  it('retains a requested temporary root on the donor filesystem', () => {
    const result = chooseRoot(false);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(result.preferred);
  });

  it('uses excluded repository-local scratch when /tmp is on another filesystem', () => {
    const result = chooseRoot(true);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(resolve(result.donor, '.papercusp/tmp'));
  });

  it('refuses a fallback that is also mounted on a different filesystem', () => {
    const result = chooseRoot(true, true);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('no verifier work root on the dependency donor filesystem');
  });
});
