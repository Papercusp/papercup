import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// EI-25279455104672139: the after-copy lock census used to refuse on the first
// overlap. Under fleet load a whole-tree copy takes minutes, so some peer lock
// almost always overlapped. The settle loop waits, re-syncs incrementally and
// re-checks, all within a bounded window.
const repo = resolve(import.meta.dirname, '../../../..');
const source = readFileSync(process.env.VERIFY_TAURI_SOURCE_PATH || join(repo, 'scripts/verify-tauri-headless.sh'), 'utf8');
const settle = source.match(/^settle_operator_source_snapshot\(\) \{[\s\S]*?^\}/m)?.[0];

/** Run the REAL settle function with the census, rsync, sleep and log stubbed.
 *  `census` is a space-separated list of exit codes, consumed one per call. */
function runSettle(census: string, env: Record<string, string> = {}) {
  return spawnSync('bash', ['-c', [
    'set -uo pipefail',
    'REPO_DIR=/fixture/repo',
    `CENSUS=(${census}); CALL=0`,
    'verify_operator_source_lock_census() {',
    '  echo "CENSUS $1 $2"',
    '  local rc=${CENSUS[$CALL]:-0}; CALL=$((CALL + 1))',
    '  [ "$rc" -eq 3 ] && VERIFY_SOURCE_LOCK_BLOCKING_ROWS="libs/a.ts owner=su-peer lock_id=l1 intent=edit"',
    '  return "$rc"',
    '}',
    'vh_probe_admitted_exec() { echo "RESYNC $*"; return "${RESYNC_RC:-0}"; }',
    'sleep() { echo "SLEEP $1"; }',
    'log() { echo "LOG $*"; }',
    settle!,
    'settle_operator_source_snapshot /fixture/snap --exclude=node_modules',
  ].join('\n')], { encoding: 'utf8', timeout: 10_000, env: { PATH: process.env.PATH ?? '', ...env } });
}

describe('verify-tauri-headless source snapshot lock settle', () => {
  it('is wired after the copy in place of the fail-fast census', () => {
    expect(settle, 'settle_operator_source_snapshot must exist').toBeTruthy();
    expect(source).toMatch(/settle_operator_source_snapshot "\$snapshot_root" "\$\{source_filters\[@\]\}" \|\| return 1/);
    expect(source).not.toMatch(/verify_operator_source_lock_census "after copy" \|\| return 1/);
  });

  // Boot 5 (task 0mwfp081qbufpzp6h0i) then failed in ~95s on the BEFORE-copy census:
  // the same always-some-lock condition, one phase earlier. An overlap there is
  // advisory because the after-copy settle loop owns consistency.
  const precopy = source.match(/^ {2}local precopy_census_rc=0\n[\s\S]*?^ {2}fi$/m)?.[0];
  function runPrecopy(rc: number) {
    return spawnSync('bash', ['-c', [
      'set -uo pipefail',
      'verify_operator_source_lock_census() {',
      '  echo "CENSUS $1 $2"',
      `  [ ${rc} -eq 3 ] && VERIFY_SOURCE_LOCK_BLOCKING_ROWS="libs/a.ts owner=su-peer lock_id=l1 intent=edit"`,
      `  return ${rc}`,
      '}',
      'log() { echo "LOG $*"; }',
      `f() {\n${precopy!}\n  echo PROCEED\n}`,
      'f',
    ].join('\n')], { encoding: 'utf8', timeout: 10_000, env: { PATH: process.env.PATH ?? '' } });
  }

  it('treats a before-copy lock overlap as advisory and proceeds to the copy', () => {
    expect(precopy, 'the advisory before-copy census block must exist').toBeTruthy();
    expect(source).not.toMatch(/verify_operator_source_lock_census "before copy" \|\| return 1/);
    const r = runPrecopy(3);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('CENSUS before copy settle');
    expect(r.stdout).toMatch(/LOG source snapshot: 1 active source-file lock\(s\) before copy; copying anyway/);
    expect(r.stdout).toContain('PROCEED');
  });

  it('proceeds silently with no overlap but still refuses when the census cannot run', () => {
    expect(runPrecopy(0).stdout).toContain('PROCEED');
    const broken = runPrecopy(1);
    expect(broken.status).toBe(1);
    expect(broken.stdout).not.toContain('PROCEED');
  });

  it('waits, re-syncs changed files and passes once the overlapping lock releases', () => {
    const r = runSettle('3 0');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('CENSUS after copy settle');
    expect(r.stdout).toContain('SLEEP 30');
    expect(r.stdout).toContain('RESYNC /fixture/repo -- rsync -a --delete --exclude=node_modules /fixture/repo/ /fixture/snap/');
    expect(r.stdout.match(/^CENSUS/gm)).toHaveLength(2);
  });

  it('passes without waiting when no lock overlaps', () => {
    const r = runSettle('0');
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain('SLEEP');
    expect(r.stdout).not.toContain('RESYNC');
  });

  it('refuses with the held locks and the knob once the settle window is spent', () => {
    const r = runSettle('3 3 3', { VERIFY_TAURI_SOURCE_LOCK_SETTLE_SEC: '0' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('still held after a 0s settle window');
    expect(r.stderr).toContain('libs/a.ts owner=su-peer');
    expect(r.stderr).toContain('VERIFY_TAURI_SOURCE_LOCK_SETTLE_SEC');
    expect(r.stdout).not.toContain('RESYNC');
  });

  it('fails immediately on an incomplete census instead of waiting', () => {
    const r = runSettle('1');
    expect(r.status).toBe(1);
    expect(r.stdout).not.toContain('SLEEP');
  });

  it('tolerates vanished files (rsync 24) but refuses other re-sync failures', () => {
    expect(runSettle('3 0', { RESYNC_RC: '24' }).status).toBe(0);
    const bad = runSettle('3 0', { RESYNC_RC: '23' });
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain('rsync exit 23');
  });

  it('rejects a non-numeric settle window', () => {
    const r = runSettle('3', { VERIFY_TAURI_SOURCE_LOCK_SETTLE_SEC: 'soon' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('must be a non-negative integer');
  });
});
