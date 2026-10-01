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

/**
 * The wiring predicates are pure functions of the source TEXT so each can be proven falsifiable with an
 * in-memory mutant (the "module/logic you import" tier of CLAUDE.md's falsifiability table): nothing
 * here ever mutates the shared tree, and the real file must pass while each mutant must be caught.
 */
const FAILED_EMISSION = 'errSync(resultLine("failed"));';

/** 1-based lines of a failing `AFFECTED_TESTS_RESULT` emission NOT immediately preceded by the annotation. */
function unannotatedFailedEmissions(text: string): { count: number; unannotated: number[] } {
  const lines = text.split('\n');
  const sites = lines.flatMap((line, index) => (line.trim() === FAILED_EMISSION ? [index] : []));
  return {
    count: sites.length,
    unannotated: sites.filter((index) => lines[index - 1]?.trim() !== 'emitMutationProbeWindow();').map((i) => i + 1),
  };
}

/** How many pre/post-run reads + stderr prints the router carries (both must be present). */
function routerWindowWiring(text: string): { reads: number; prints: number } {
  return {
    reads: text.match(/readMutationProbeWindow\(REPO_ROOT\)/g)?.length ?? 0,
    prints: text.match(/console\.error\(formatMutationProbeWindow\(probeWindow(?:Before|After), REPO_ROOT\)\)/g)?.length ?? 0,
  };
}

describe('every failing verdict path on the raw runners carries the annotation (EI-18750303030034478)', () => {
  const affected = readFileSync(join(REPO, 'scripts/affected-tests.mjs'), 'utf8');
  const router = readFileSync(join(REPO, 'scripts/test-files.mjs'), 'utf8');

  it('affected-tests.mjs emits the window immediately before EACH failing `AFFECTED_TESTS_RESULT` line', () => {
    const real = unannotatedFailedEmissions(affected);
    // The two real failure exits (undetermined-only, and failed>0): a vacuous scan of zero sites must
    // not read as "all annotated".
    expect(real.count).toBeGreaterThanOrEqual(2);
    expect(real.unannotated).toEqual([]);
  });

  it('CONTROL: the predicate catches an annotation removed from a real failure site', () => {
    const mutant = affected.replace('  emitMutationProbeWindow();\n  errSync(resultLine("failed"));', '  errSync(resultLine("failed"));');
    expect(mutant).not.toBe(affected); // a no-op mutation would make any guard look weak
    expect(unannotatedFailedEmissions(mutant).unannotated).toHaveLength(1);
  });

  it('CONTROL: the predicate catches a NEW failing verdict path added without the annotation', () => {
    const mutant = `${affected}\n  ${FAILED_EMISSION}\n`;
    expect(unannotatedFailedEmissions(mutant).unannotated).toHaveLength(1);
  });

  it('test-files.mjs reads the window both before and after the run, and prints each to stderr', () => {
    expect(routerWindowWiring(router)).toEqual({ reads: 2, prints: 2 });
  });

  it('CONTROL: the router predicate catches a dropped pre-run or post-run read', () => {
    const dropped = router.replace('const probeWindowAfter = readMutationProbeWindow(REPO_ROOT);', 'const probeWindowAfter = null;');
    expect(dropped).not.toBe(router);
    expect(routerWindowWiring(dropped)).not.toEqual({ reads: 2, prints: 2 });
  });
});
