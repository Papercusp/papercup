import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// EI-25279455104672139: the after-copy lock census used to refuse on the first
// overlap. Under fleet load a whole-tree copy takes minutes, so some peer lock
// almost always overlapped. The settle loop waits, re-syncs incrementally and
// re-checks, all within a bounded window.
const repo = resolve(import.meta.dirname, '../../../..');
const source = readFileSync(process.env.VERIFY_TAURI_SOURCE_PATH || join(repo, 'scripts/verify-tauri-headless.sh'), 'utf8');
const settle = source.match(/^settle_operator_source_snapshot\(\) \{[\s\S]*?^\}/m)?.[0];
const substitute = source.match(/^substitute_locked_files_from_committed\(\) \{[\s\S]*?^\}/m)?.[0];

/** Run the REAL settle function with the census, rsync, sleep and log stubbed.
 *  `census` is a space-separated list of exit codes, consumed one per call.
 *  REPO_DIR / SNAP / ROWS in `env` point it at a real fixture repo. */
function runSettle(census: string, env: Record<string, string> = {}) {
  return spawnSync('bash', ['-c', [
    'set -uo pipefail',
    'REPO_DIR="${REPO_DIR:-/fixture/repo}"',
    `CENSUS=(${census}); CALL=0`,
    'verify_operator_source_lock_census() {',
    '  echo "CENSUS $1 $2"',
    '  local rc=${CENSUS[$CALL]:-0}; CALL=$((CALL + 1))',
    '  [ "$rc" -eq 3 ] && VERIFY_SOURCE_LOCK_BLOCKING_ROWS="${ROWS:-libs/a.ts owner=su-peer lock_id=l1 intent=edit}"',
    '  return "$rc"',
    '}',
    'vh_probe_admitted_exec() { echo "RESYNC $*"; return "${RESYNC_RC:-0}"; }',
    'sleep() { echo "SLEEP $1"; }',
    'log() { echo "LOG $*"; }',
    substitute!,
    settle!,
    'settle_operator_source_snapshot "${SNAP:-/fixture/snap}" --exclude=node_modules',
  ].join('\n')], { encoding: 'utf8', timeout: 10_000, env: { PATH: process.env.PATH ?? '', ...env } });
}

/** A real git repo (with a nested repo standing in for a submodule) whose
 *  working tree holds in-flight edits, plus a snapshot copied from that tree. */
function fixtureRepo() {
  const root = mkdtempSync(join(tmpdir(), 'vh-settle-'));
  const repoDir = join(root, 'repo');
  const snap = join(root, 'snap');
  const git = (cwd: string, ...args: string[]) => {
    const r = spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'init.defaultBranch=main', ...args], {
      cwd, encoding: 'utf8', env: { PATH: process.env.PATH ?? '', HOME: root, GIT_CONFIG_NOSYSTEM: '1' },
    });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  };
  mkdirSync(join(repoDir, 'libs/sub'), { recursive: true });
  writeFileSync(join(repoDir, 'libs/a.ts'), 'committed-a\n');
  git(repoDir, 'init', '-q');
  git(repoDir, 'add', 'libs/a.ts');
  git(repoDir, 'commit', '-qm', 'base');
  writeFileSync(join(repoDir, 'libs/sub/b.ts'), 'committed-b\n');
  git(join(repoDir, 'libs/sub'), 'init', '-q');
  git(join(repoDir, 'libs/sub'), 'add', 'b.ts');
  git(join(repoDir, 'libs/sub'), 'commit', '-qm', 'sub');
  // In-flight peer edits, and a brand-new held file with no committed version.
  writeFileSync(join(repoDir, 'libs/a.ts'), 'in-flight-a\n');
  writeFileSync(join(repoDir, 'libs/sub/b.ts'), 'in-flight-b\n');
  writeFileSync(join(repoDir, 'libs/new.ts'), 'in-flight-new\n');
  cpSync(repoDir, snap, { recursive: true, filter: (p) => !p.includes('/.git') });
  return { root, repoDir, snap, env: { REPO_DIR: repoDir, SNAP: snap, HOME: root, GIT_CONFIG_NOSYSTEM: '1' } };
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
    // The wait must be visible on stdout (the live step log), not only stderr.
    expect(r.stdout).toMatch(/^VH_PROGRESS phase=prepare step=operator-source-snapshot settle_pass=1 blocking_locks=1 remaining_sec=\d+ holders=su-peer$/m);
    expect(r.stdout).toContain('RESYNC /fixture/repo -- rsync -a --delete --exclude=node_modules /fixture/repo/ /fixture/snap/');
    expect(r.stdout.match(/^CENSUS/gm)).toHaveLength(2);
  });

  it('passes without waiting when no lock overlaps', () => {
    const r = runSettle('0');
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain('SLEEP');
    expect(r.stdout).not.toContain('RESYNC');
  });

  it('refuses with the held locks and the knob once the window is spent under ON_EXPIRY=fail', () => {
    const r = runSettle('3 3 3', { VERIFY_TAURI_SOURCE_LOCK_SETTLE_SEC: '0', VERIFY_TAURI_SOURCE_LOCK_ON_EXPIRY: 'fail' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('still held after a 0s settle window');
    expect(r.stderr).toContain('libs/a.ts owner=su-peer');
    expect(r.stderr).toContain('VERIFY_TAURI_SOURCE_LOCK_SETTLE_SEC');
    expect(r.stdout).not.toContain('RESYNC');
  });

  // Boot 6 (task 0mwfp5nuh6l972kb4nv) waited a whole 900s window while held
  // peer source files grew 5 -> 7: zero locks never arrives under fleet load.
  it('converges by taking the committed state of peer-held files once the window is spent', () => {
    expect(source).toMatch(/VERIFY_TAURI_SOURCE_LOCK_ON_EXPIRY:-committed/);
    const fx = fixtureRepo();
    const rows = [
      'libs/a.ts owner=su-peer lock_id=l1 intent=edit',
      'libs/sub/b.ts owner=su-peer lock_id=l2 intent=edit',
      'libs/new.ts owner=su-other lock_id=l3 intent=create',
    ].join('\n');
    const r = runSettle('3', { ...fx.env, ROWS: rows, VERIFY_TAURI_SOURCE_LOCK_SETTLE_SEC: '0' });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(readFileSync(join(fx.snap, 'libs/a.ts'), 'utf8')).toBe('committed-a\n');
    // A nested repository (a submodule) answers from its own HEAD.
    expect(readFileSync(join(fx.snap, 'libs/sub/b.ts'), 'utf8')).toBe('committed-b\n');
    // No committed version: the committed state is "absent".
    expect(existsSync(join(fx.snap, 'libs/new.ts'))).toBe(false);
    // The working tree itself is never touched.
    expect(readFileSync(join(fx.repoDir, 'libs/a.ts'), 'utf8')).toBe('in-flight-a\n');
    expect(r.stdout).toMatch(/^VH_SOURCE_LOCK_SUBSTITUTED path=libs\/a\.ts owner=su-peer source=committed$/m);
    expect(r.stdout).toMatch(/^VH_SOURCE_LOCK_SUBSTITUTED path=libs\/new\.ts owner=su-other source=committed state=absent$/m);
    expect(r.stdout).toMatch(/LOG settle window spent after 0 re-sync pass\(es\): 3 peer-held source file\(s\)/);
    expect(r.stdout).not.toContain('SLEEP');
  });

  it('keeps the working-tree copy of a file the caller itself holds', () => {
    const fx = fixtureRepo();
    const r = runSettle('3', { ...fx.env, PAPERCUSP_SID: 'su-peer', VERIFY_TAURI_SOURCE_LOCK_SETTLE_SEC: '0' });
    expect(r.status).toBe(0);
    expect(readFileSync(join(fx.snap, 'libs/a.ts'), 'utf8')).toBe('in-flight-a\n');
    expect(r.stdout).toMatch(/^VH_SOURCE_LOCK_KEPT path=libs\/a\.ts owner=su-peer source=working-tree reason=caller-held$/m);
  });

  it('refuses a held row whose path is not a safe repo-relative source path', () => {
    const fx = fixtureRepo();
    for (const row of ['../etc/passwd owner=su-peer', 'libs/../../x.ts owner=su-peer', 'undefined owner=su-peer']) {
      const r = runSettle('3', { ...fx.env, ROWS: row, VERIFY_TAURI_SOURCE_LOCK_SETTLE_SEC: '0' });
      expect(r.status, row).toBe(1);
      expect(r.stderr).toContain('without a safe repo-relative path');
    }
  });

  it('rejects an unknown expiry policy', () => {
    const r = runSettle('3', { VERIFY_TAURI_SOURCE_LOCK_ON_EXPIRY: 'wait' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("must be 'committed' or 'fail'");
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
