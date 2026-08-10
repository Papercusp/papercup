/**
 * THE STRAND-GUARD FAMILY CONTRACT — a guard that compared nothing must not exit 0.
 *
 * WHY THIS IS ONE TEST OVER THE FAMILY, NOT THREE TESTS IN THREE FILES
 *   Three guards infer their subject from `git diff <base>`, and on this tree git-sync
 *   commits the whole working tree every few minutes. So minutes after an edit the diff
 *   is empty, every one of them examines ZERO files, and "no findings" means "I could not
 *   look" rather than "there is nothing there". Each is least reliable exactly when it is
 *   most needed.
 *
 *   check-required-field-strands learned that over FOUR filings (EI-19377892307939503,
 *   EI-19396116936287206, EI-20095543794921181, EI-20097325488507587). The two guards
 *   PORTED from it inherited its "⚠ NOT CHECKED … This is NOT a clean bill" prose and NOT
 *   its exit status, so each printed that text and then exited 0 (WI-37806). Nothing
 *   failed when they did: the prose looked right, every unit test passed, and the only
 *   witness was an exit code nobody asserted.
 *
 *   A per-guard test would not have caught it, because each guard's tests were written
 *   from its own source and inherited the same blind spot. What catches a bad PORT is a
 *   contract asserted over the SET — so a fourth guard added tomorrow either satisfies it
 *   or fails here.
 *
 * WHY IT SHELLS OUT INSTEAD OF UNIT-TESTING THE PREDICATE
 *   The bug was never in the predicate — it was in a `process.exit(0)` that never consulted
 *   one. Only the real process's real status can witness that, which is the same reason
 *   this class keeps escaping: every cheaper assertion is downstream of the mistake.
 *
 *   The scripts/ tree is copied WHOLESALE rather than by a hand-listed dependency set: a
 *   guard that gains a new local import would otherwise fail to LOAD here, and an
 *   ERR_MODULE_NOT_FOUND exit is not evidence about the exit-status contract. (That is not
 *   hypothetical — it happened to this very change, twice.)
 */
import { describe, it, expect } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(__dirname, '../../../..');

/** Must equal EXIT_NOT_CHECKED in scripts/lib/not-checked.mjs — asserted below. */
const EXIT_NOT_CHECKED = 2;

const GUARDS = [
  'check-required-field-strands.mjs',
  'check-optional-seam-strands.mjs',
  'check-vimock-export-strands.mjs',
];

const FILE_A = 'packages/operator-core/lib/a.ts';
const FILE_B = 'packages/operator-core/lib/b.ts';

/** A throwaway repo whose working tree is IDENTICAL to HEAD, so every guard examines zero files. */
function makeCleanRepo(): string {
  const tmp = mkdtempSync(join(tmpdir(), 'strand-guard-'));
  cpSync(resolve(ROOT, 'scripts'), join(tmp, 'scripts'), { recursive: true });
  symlinkSync(resolve(ROOT, 'node_modules'), join(tmp, 'node_modules'));
  mkdirSync(join(tmp, 'packages/operator-core/lib'), { recursive: true });
  writeFileSync(join(tmp, FILE_A), 'export interface A { id: string }\n');
  // A second committed file exists solely so a PARTIAL declared run is expressible — one
  // named file identical to base, another genuinely changed. Both must exist AT HEAD or the
  // guards skip them outright (no base version to diff against) and the run is vacuous for
  // an entirely different reason than the one under test.
  writeFileSync(join(tmp, FILE_B), 'export interface B { id: string }\n');
  const git = (...args: string[]) => execFileSync('git', args, { cwd: tmp, encoding: 'utf8' });
  git('init', '-q', '.');
  git('config', 'user.email', 't@t.t');
  git('config', 'user.name', 't');
  git('add', '-A');
  git('commit', '-qm', 'base');
  return tmp;
}

function run(tmp: string, guard: string, extraArgs: string[] = []) {
  const r = spawnSync('node', [join('scripts', guard), '--base', 'HEAD', ...extraArgs], {
    cwd: tmp,
    encoding: 'utf8',
  });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  // A guard that failed to LOAD tells us nothing about the contract, and its non-zero exit
  // would otherwise masquerade as the very refusal we are asserting.
  expect(out, `${guard} failed to execute`).not.toContain('ERR_MODULE_NOT_FOUND');
  return { status: r.status, out, headline: headlineOf(out) };
}

/**
 * The FIRST non-empty line — the only part of the output a reader reliably acts on.
 *
 * Asserting mere CONTAINMENT of "NOT CHECKED" is not enough, and that is not a hypothetical
 * refinement: check-vimock-export-strands printed a ✓ headline, buried the "⚠ NOT CHECKED …
 * proves NOTHING about them" block four lines below it, and exited 2 (WI-37819). A
 * `toContain('NOT CHECKED')` assertion passes that output while a human reads it as a pass.
 * The invalidation has to BE the verdict, not a caveat appended to a green one.
 */
function headlineOf(out: string): string {
  return out.split('\n').find((l) => l.trim().length > 0)?.trim() ?? '';
}

describe('strand-guard family — "examined nothing" must never exit 0', () => {
  it.each(GUARDS)('%s refuses to report success when it compared nothing', (guard) => {
    const tmp = makeCleanRepo();
    try {
      const { status, out, headline } = run(tmp, guard);
      // The pairing IS the contract: the prose and the exit status must agree. Asserting
      // only the text is what let this ship — the text was already right in both ports.
      expect(out).toContain('NOT CHECKED');
      expect(headline).toContain('NOT CHECKED');
      expect(headline).not.toContain('✓');
      expect(status).toBe(EXIT_NOT_CHECKED);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 120_000);

  /**
   * The other direction, and it is load-bearing: an over-eager NOT-CHECKED would make every
   * guard useless in the opposite way — refusing runs that did real work. Without this leg,
   * `process.exit(2)` unconditionally would pass the test above.
   */
  it.each(GUARDS)('%s still exits 0 for a run that genuinely compared something', (guard) => {
    const tmp = makeCleanRepo();
    try {
      writeFileSync(join(tmp, FILE_A), 'export interface A { id: string }\nexport const NOTE = 1;\n');
      const { status, out, headline } = run(tmp, guard);
      expect(out).not.toContain('NOT CHECKED');
      expect(headline).toContain('✓');
      expect(status).toBe(0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 120_000);
});

/**
 * THE PER-FILE FORM OF THE SAME ROOT CAUSE (EI-20103725040309933 / WI-37819).
 *
 * `--files=` was added to fix ATTRIBUTION — WHICH files a run examined — after an inferred
 * `git diff` set turned out to be every agent's uncommitted edits rather than yours. It does
 * not fix VACUITY. "Examined" only ever meant "a before/after pair was diffed", never that
 * the two DIFFERED, and on this tree git-sync commits the working tree every few minutes, so
 * a file you name is frequently byte-identical to base by the time the guard runs. The
 * comparison executes, finds nothing to compare, and reports a clean bill that is vacuously
 * true of a file it never actually diffed against its pre-edit state.
 *
 * This is the case a per-guard test keeps missing, because each guard's tests are written
 * from its own source: measured 2026-08-10, one guard exited 0 with a ✓ headline, another
 * exited 2 with a ✓ headline, and the third was correct — three different answers to one
 * question. Asserting it over the SET is what makes them converge.
 */
describe('strand-guard family — a DECLARED file identical to base proves nothing', () => {
  it.each(GUARDS)('%s refuses to report success when every named file is byte-identical', (guard) => {
    const tmp = makeCleanRepo();
    try {
      const { status, headline } = run(tmp, guard, [`--files=${FILE_A}`]);
      expect(headline).toContain('NOT CHECKED');
      expect(headline).not.toContain('✓');
      expect(status).toBe(EXIT_NOT_CHECKED);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 120_000);

  /**
   * The falsifier, and it is what stops the fix above from being "always refuse when
   * --files= is passed" — which would satisfy every other leg here while making the flag
   * useless. A PARTIAL run verified what it could and stays a PASS; its text names the
   * unverified remainder rather than voiding the whole run.
   */
  it.each(GUARDS)('%s still passes when a named file genuinely differs', (guard) => {
    const tmp = makeCleanRepo();
    try {
      // A COMMENT, deliberately: this leg is about a non-empty DIFF, and every other edit
      // worth writing trips one of the three detectors. `export const NOTE = 1` — the
      // obvious choice, and what this test first used — is exactly what
      // check-vimock-export-strands exists to flag, so it took the FINDINGS path and never
      // reached the no-findings verdict under test. The leg still went green on its first
      // two assertions, which is the trap: a scenario that never reaches the code you are
      // pinning still passes, and reads as coverage you do not have.
      writeFileSync(join(tmp, FILE_B), 'export interface B { id: string }\n// a genuine textual change\n');
      const { status, headline, out } = run(tmp, guard, [`--files=${FILE_A},${FILE_B}`]);
      expect(headline).toContain('✓');
      expect(status).toBe(0);
      // The pass is not silent about what it could not verify: FILE_A was named and is
      // identical, so the run must still say so somewhere below the headline.
      expect(out).toContain(FILE_A);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 120_000);
});

describe('strand-guard family — the shared verdict is actually shared', () => {
  it('every guard imports the shared not-checked module rather than re-deriving it', async () => {
    const mod = await import(`file://${resolve(ROOT, 'scripts/lib/not-checked.mjs')}`);
    expect(mod.EXIT_NOT_CHECKED).toBe(EXIT_NOT_CHECKED);
    // provedNothing is the single predicate both the headline and the exit status read.
    expect(mod.provedNothing({ examinedFiles: [] })).toBe(true);
    expect(mod.provedNothing({ examinedFiles: ['a.ts'] })).toBe(false);
    expect(mod.provedNothing({ examinedFiles: ['a.ts'], identicalFiles: ['a.ts'], declared: true })).toBe(true);
    // A PARTIAL run verified what it could and must stay a pass.
    expect(
      mod.provedNothing({ examinedFiles: ['a.ts', 'b.ts'], identicalFiles: ['b.ts'], declared: true }),
    ).toBe(false);
  });
});
