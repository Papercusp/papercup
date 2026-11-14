/**
 * mutation-probe.sh write containment: a split-directory file that vanishes
 * between enumeration and copy must not fail the containment positive control
 * (EI-28789389055399317).
 *
 * The generated contain-setup.sh lists each split directory's entries, then
 * copies the files in batches. git-sync creates and deletes
 * `.git/papercusp-git-sync-candidate-*.index.manifest` on every tick, so an
 * entry can be listed and gone a moment later. A bare batch `cp` then failed
 * with ENOENT and the probe reported UNCONTAINED for a reason unrelated to the
 * guard. `contain_copy_files` retries a failed batch file by file, skipping
 * vanished sources but still failing on a file that exists and cannot be read.
 *
 * The helper lives inside the script's quoted SHALLOW heredoc, so it is
 * extracted from the real script text and executed — never re-implemented here.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const SCRIPT = process.env.MUTATION_PROBE_SCRIPT ?? resolve(__dirname, '../../../scripts/mutation-probe.sh');
const source = readFileSync(SCRIPT, 'utf8');

function extractHelper(): string | null {
  const match = source.match(/^contain_copy_files\(\) \{\n[\s\S]*?^\}\n/m);
  return match ? match[0] : null;
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mp-contain-copy-'));
});

afterEach(() => {
  try {
    chmodSync(join(dir, 'src', 'locked'), 0o600);
  } catch {
    // only present in the unreadable-file case
  }
  rmSync(dir, { recursive: true, force: true });
});

function runHelper(dest: string, files: string[]) {
  const helper = extractHelper();
  expect(helper, 'contain_copy_files() must exist in mutation-probe.sh').toBeTruthy();
  const harness = join(dir, 'harness.sh');
  writeFileSync(harness, `set -u\n${helper}\ncontain_copy_files "$@"\n`);
  return spawnSync('bash', [harness, dest, ...files], { encoding: 'utf8' });
}

describe('mutation-probe.sh — containment split-directory copy (EI-28789389055399317)', () => {
  it('every split-directory batch copy goes through contain_copy_files, never a bare cp', () => {
    expect(source).not.toMatch(/cp -Pp -- "\$\{files\[@\]\}" "\$s\/"/);
    const callSites = source.match(/contain_copy_files "\$s" "\$\{files\[@\]\}" \|\| contain_abort/g) ?? [];
    expect(callSites.length).toBe(2);
  });

  it('skips a source that vanished after enumeration and still copies the rest', () => {
    const src = join(dir, 'src');
    const dest = join(dir, 'dest');
    mkdirSync(src);
    mkdirSync(dest);
    writeFileSync(join(src, 'HEAD'), 'ref: refs/heads/staging\n');
    writeFileSync(join(src, 'config'), '[core]\n');
    // Listed by the enumeration, deleted by git-sync before the copy ran.
    const vanished = join(src, 'papercusp-git-sync-candidate-1-abc.index.manifest');

    const r = runHelper(dest, [join(src, 'HEAD'), vanished, join(src, 'config')]);

    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(join(dest, 'HEAD'), 'utf8')).toBe('ref: refs/heads/staging\n');
    expect(readFileSync(join(dest, 'config'), 'utf8')).toBe('[core]\n');
    expect(existsSync(join(dest, 'papercusp-git-sync-candidate-1-abc.index.manifest'))).toBe(false);
  });

  it.skipIf(process.getuid?.() === 0)('still fails when a file that exists cannot be copied', () => {
    const src = join(dir, 'src');
    const dest = join(dir, 'dest');
    mkdirSync(src);
    mkdirSync(dest);
    writeFileSync(join(src, 'ok'), 'ok\n');
    writeFileSync(join(src, 'locked'), 'secret\n');
    chmodSync(join(src, 'locked'), 0o000);

    const r = runHelper(dest, [join(src, 'ok'), join(src, 'locked')]);

    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/locked/);
  });
});
