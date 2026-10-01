/**
 * EI-18750303030034478 — a failing raw `test:file` / `test:affected` run names an ACTIVE in-tree
 * mutation-probe window, so a red read from a peer's deliberately-broken file is not mistaken for a
 * regression in the caller's own change.
 *
 * Every test builds its marker under a private scratch `tmpDir`. NEVER write a marker into the real
 * `/tmp/papercusp-mutation-probe-<uid>-<hash>` of this checkout: the next real `--in-tree` probe
 * would read it as an orphaned snapshot and try to RESTORE the subject from it.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  formatMutationProbeWindow,
  mutationProbeAdmissionDir,
  readMutationProbeWindow,
} from '../../../scripts/lib/mutation-probe-window.mjs';

const REPO = resolve(__dirname, '../../..');

describe('mutation-probe window marker (EI-18750303030034478)', () => {
  let scratch: string;
  let checkout: string;

  beforeEach(() => {
    scratch = realpathSync(mkdtempSync(join(tmpdir(), 'mp-window-')));
    checkout = join(scratch, 'checkout');
    mkdirSync(checkout);
  });
  afterEach(() => rmSync(scratch, { recursive: true, force: true }));

  const opts = () => ({ uid: 4242, tmpDir: scratch });
  const publish = (fields: string[]) => {
    const dir = mutationProbeAdmissionDir(checkout, opts());
    mkdirSync(dir, { recursive: true });
    // The writer terminates EVERY field with NUL: printf '%s\0%s\0%s\0%s\0'.
    writeFileSync(join(dir, 'original.manifest'), fields.map((f) => `${f}\0`).join(''), 'latin1');
  };
  const deadPid = () => {
    const child = spawnSync(process.execPath, ['-e', '']);
    return child.pid as number;
  };

  it('reads no marker as "no window" (null), never an error', () => {
    expect(readMutationProbeWindow(checkout, opts())).toBeNull();
    expect(formatMutationProbeWindow(null, checkout)).toBe('');
  });

  it('reports an ACTIVE window when the owner pid is alive, with the subject repo-relative', () => {
    publish([checkout, join(checkout, 'pkg/src/cpu-task-worker.ts'), join(scratch, 'x.orig'), String(process.pid)]);
    const window = readMutationProbeWindow(checkout, opts());
    expect(window).toMatchObject({ state: 'active', ownerPid: process.pid });
    const line = formatMutationProbeWindow(window, checkout);
    expect(line).toMatch(/^TEST_FILE_MUTATION_PROBE_WINDOW state=active subject=pkg\/src\/cpu-task-worker\.ts /);
    expect(line).toContain(`ownerPid=${process.pid}`);
    expect(line).toContain('re-run in isolation');
  });

  it('reports an ORPHANED window when the owner died mid-window (the mutant may still be in the file)', () => {
    publish([checkout, join(checkout, 'a.ts'), join(scratch, 'a.orig'), String(deadPid())]);
    const window = readMutationProbeWindow(checkout, opts());
    expect(window?.state).toBe('orphaned');
    expect(formatMutationProbeWindow(window, checkout)).toContain('may STILL be mutated');
  });

  it.each([
    ['three fields', ['a', 'b', 'c']],
    ['five fields', ['a', 'b', 'c', '1', 'e']],
    ['a non-numeric pid', ['a', 'b', 'c', 'pid']],
    ['a zero pid', ['a', 'b', 'c', '0']],
    ['an empty subject', ['a', '', 'c', '1']],
  ])('reports an UNREADABLE window (not "none", not a throw) for %s', (_name, fields) => {
    publish(fields);
    const window = readMutationProbeWindow(checkout, opts());
    expect(window).toMatchObject({ state: 'unreadable', subject: null, ownerPid: null });
    expect(formatMutationProbeWindow(window, checkout)).toContain('could not be parsed');
  });

  it('reports a marker missing its trailing NUL as unreadable (a truncated write is not a window we can name)', () => {
    const dir = mutationProbeAdmissionDir(checkout, opts());
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'original.manifest'), `a\0b\0c\0${process.pid}`, 'latin1');
    expect(readMutationProbeWindow(checkout, opts())?.state).toBe('unreadable');
  });

  it('never throws for a checkout that cannot be resolved', () => {
    expect(readMutationProbeWindow(join(scratch, 'does-not-exist'), opts())).toBeNull();
  });
});

describe('the marker contract is pinned to scripts/mutation-probe.sh (EI-18750303030034478)', () => {
  const script = readFileSync(join(REPO, 'scripts/mutation-probe.sh'), 'utf8');

  it('mirrors the admission-directory literal the script hard-codes', () => {
    expect(script).toContain('ADMISSION_KEY="$(printf \'%s\' "$ADMISSION_ROOT" | sha256sum | cut -d\' \' -f1)"');
    expect(script).toContain('ADMISSION_DIR="/tmp/papercusp-mutation-probe-$(id -u)-$ADMISSION_KEY"');
    expect(script).toContain('PROBE_MANIFEST="$ADMISSION_DIR/original.manifest"');
  });

  it('mirrors the four-field NUL-terminated manifest the script publishes', () => {
    expect(script).toContain('printf \'%s\\0%s\\0%s\\0%s\\0\' "$ADMISSION_ROOT" "$FILE" "$BASE" "$$" >"$PROBE_MANIFEST"');
  });

  it('derives the same directory name as the shell does for the same root (sha256sum is the oracle)', () => {
    const root = realpathSync(REPO);
    const shell = spawnSync('bash', ['-c', `printf '%s' "$1" | sha256sum | cut -d' ' -f1`, '_', root], {
      encoding: 'utf8',
    });
    expect(shell.status).toBe(0);
    const key = shell.stdout.trim();
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(mutationProbeAdmissionDir(REPO, { uid: 1000 })).toBe(`/tmp/papercusp-mutation-probe-1000-${key}`);
  });
});

describe('every failing verdict path on the raw runners carries the annotation (EI-18750303030034478)', () => {
  it('affected-tests.mjs emits the window immediately before EACH `AFFECTED_TESTS_RESULT status=failed` line', () => {
    const text = readFileSync(join(REPO, 'scripts/affected-tests.mjs'), 'utf8');
    const lines = text.split('\n');
    const failedEmissions = lines
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => line.trim() === 'errSync(resultLine("failed"));');
    // The two real failure exits (undetermined-only, and failed>0). A THIRD one added later without
    // the annotation must fail here rather than silently re-open the unattributable-red class.
    expect(failedEmissions.length).toBeGreaterThanOrEqual(2);
    for (const { index } of failedEmissions) {
      expect(lines[index - 1].trim(), `line ${index + 1}`).toBe('emitMutationProbeWindow();');
    }
  });

  it('test-files.mjs reads the window both before and after the run, and prints it to stderr', () => {
    const text = readFileSync(join(REPO, 'scripts/test-files.mjs'), 'utf8');
    expect(text.match(/readMutationProbeWindow\(REPO_ROOT\)/g)?.length).toBe(2);
    expect(text.match(/console\.error\(formatMutationProbeWindow\(probeWindow(Before|After), REPO_ROOT\)\)/g)?.length).toBe(2);
  });
});
