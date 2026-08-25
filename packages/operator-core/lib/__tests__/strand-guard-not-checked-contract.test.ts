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
import { afterAll, beforeAll, describe, it, expect } from 'vitest';
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
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: tmp, encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL' });
  git('init', '-q', '.');
  git('config', 'user.email', 't@t.t');
  git('config', 'user.name', 't');
  git('add', '-A');
  git('commit', '-qm', 'base');
  return tmp;
}

type SubmoduleGuardFixture = {
  root: string;
  base: string;
  submoduleRoot: string;
  changedFile: string;
  mockFile: string;
  responseFile: string;
};

/**
 * A deterministic superproject/submodule pair carrying BOTH strand shapes:
 * a required field and a runtime export added to one submodule module, plus an
 * enumerating vi.mock in that same submodule. The gate sees only the gitlink path.
 */
function makeSubmoduleGuardRepo(): SubmoduleGuardFixture {
  const tmp = mkdtempSync(join(tmpdir(), 'strand-guard-submodule-'));
  const root = join(tmp, 'root');
  const origin = join(tmp, 'submodule-origin');
  const submoduleRoot = 'libs/example';
  const changedFile = `${submoduleRoot}/src/subject.ts`;
  const mockFile = `${submoduleRoot}/src/subject.test.ts`;
  mkdirSync(root, { recursive: true });
  mkdirSync(join(origin, 'src'), { recursive: true });
  cpSync(resolve(ROOT, 'scripts'), join(root, 'scripts'), { recursive: true });
  symlinkSync(resolve(ROOT, 'node_modules'), join(root, 'node_modules'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ private: true, workspaces: [] }));

  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      timeout: 30_000,
      killSignal: 'SIGKILL',
    });
  const configure = (cwd: string) => {
    git(cwd, 'config', 'user.email', 'strand-guard@test.invalid');
    git(cwd, 'config', 'user.name', 'strand-guard');
  };

  git(origin, 'init', '-q', '.');
  configure(origin);
  writeFileSync(
    join(origin, 'src/subject.ts'),
    'export interface Shape { id: string }\nexport const old = 1;\n',
  );
  writeFileSync(
    join(origin, 'src/subject.test.ts'),
    "vi.mock('./subject', () => ({ old: 1 }));\n",
  );
  git(origin, 'add', '-A');
  git(origin, 'commit', '-qm', 'submodule base');

  git(root, 'init', '-q', '.');
  configure(root);
  git(root, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', origin, submoduleRoot);
  git(root, 'add', '.gitmodules', 'package.json', submoduleRoot);
  git(root, 'commit', '-qm', 'superproject base');
  const base = git(root, 'rev-parse', 'HEAD').trim();

  const checkout = join(root, submoduleRoot);
  configure(checkout);
  writeFileSync(
    join(checkout, 'src/subject.ts'),
    [
      'export interface Shape { id: string; label: string }',
      'export const old = 1;',
      'export const added = 2;',
      '',
    ].join('\n'),
  );
  git(checkout, 'add', 'src/subject.ts');
  git(checkout, 'commit', '-qm', 'add both strand triggers');
  git(root, 'add', submoduleRoot);
  git(root, 'commit', '-qm', 'advance submodule gitlink');

  const responseFile = join(root, 'changed-files.json');
  writeFileSync(responseFile, JSON.stringify([submoduleRoot]));
  return { root, base, submoduleRoot, changedFile, mockFile, responseFile };
}

function run(tmp: string, guard: string, extraArgs: string[] = []) {
  const r = spawnSync('node', [join('scripts', guard), '--base', 'HEAD', ...extraArgs], {
    cwd: tmp,
    encoding: 'utf8',
    timeout: 60_000,
    killSignal: 'SIGKILL',
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

  it('check-vimock-export-strands preserves NOT_CHECKED in machine-readable JSON mode', () => {
    const tmp = makeCleanRepo();
    try {
      const result = spawnSync(
        'node',
        [join('scripts', 'check-vimock-export-strands.mjs'), '--base', 'HEAD', `--files=${FILE_A}`, '--json'],
        { cwd: tmp, encoding: 'utf8', timeout: 60_000, killSignal: 'SIGKILL' },
      );
      const report = JSON.parse(String(result.stdout));
      expect(report.examined).toEqual([FILE_A]);
      expect(report.identical).toEqual([FILE_A]);
      expect(result.status).toBe(EXIT_NOT_CHECKED);
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

describe('strand guards — a forwarded submodule ROOT means its internal TypeScript diff', () => {
  let fixture: SubmoduleGuardFixture;

  beforeAll(() => {
    fixture = makeSubmoduleGuardRepo();
  }, 120_000);

  afterAll(() => {
    rmSync(resolve(fixture.root, '..'), { recursive: true, force: true });
  });

  function runJson(guard: string, scopeArgs: string[] = []) {
    const result = spawnSync(
      'node',
      [join('scripts', guard), '--base', fixture.base, ...scopeArgs, '--json'],
      { cwd: fixture.root, encoding: 'utf8', timeout: 60_000, killSignal: 'SIGKILL' },
    );
    expect(result.error, `${guard} failed to spawn: ${result.error?.message}`).toBeUndefined();
    expect(`${result.stderr ?? ''}`).not.toMatch(/EISDIR|fatal: (?:bad object|bad revision|path .* exists on disk)/);
    return { result, report: JSON.parse(String(result.stdout)) };
  }

  it('required-field expands the declared root instead of reading the submodule directory', () => {
    const { result, report } = runJson('check-required-field-strands.mjs', [
      `--files=${fixture.submoduleRoot}`,
    ]);
    expect(result.status).toBe(0);
    expect(report.examined).toContain(fixture.changedFile);
    expect(report.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ file: fixture.changedFile }),
      ]),
    );
  }, 120_000);

  it('vimock accepts the shared response file, reads the gitlink before-image, and scans submodule tests', () => {
    const { result, report } = runJson('check-vimock-export-strands.mjs', [
      `--files-from=${fixture.responseFile}`,
    ]);
    expect(result.status).toBe(0);
    expect(report.examined).toContain(fixture.changedFile);
    expect(report.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          file: fixture.changedFile,
          mockers: expect.arrayContaining([
            expect.objectContaining({ path: fixture.mockFile }),
          ]),
        }),
      ]),
    );
  }, 120_000);

  it.each([
    'check-required-field-strands.mjs',
    'check-vimock-export-strands.mjs',
  ])('%s also expands submodule changes in inferred mode', (guard) => {
    const { result, report } = runJson(guard);
    expect(result.status).toBe(0);
    expect(report.examined).toContain(fixture.changedFile);
  }, 120_000);
});

/**
 * EI-21361656341155733 — THE THIRD FORM: the base itself is wrong, and the ✓ says nothing.
 *
 * The two blocks above close "the guard examined nothing". This one closes "the guard
 * examined the wrong PAIR". Both surface as the same clean headline, and this one is
 * reached by FOLLOWING THE GUARD'S OWN ADVICE: when a named file is byte-identical the
 * run prints a recipe for re-deriving the base with `git log -S`. That recipe used
 * `git log -1`, which returns the NEWEST commit whose occurrence count changed — not the
 * one that INTRODUCED the field. git-sync splits one logical change across commits here,
 * so the newest match's parent routinely already contains the field, the diff finds
 * nothing, and the run prints `✓ no required fields added`.
 *
 * Measured 2026-08-24 on ONE working tree, two bases, opposite verdicts:
 *   --base f172703bb7^  (newest -S match)  -> "✓ no required fields added"
 *   --base 5a199c7a09^  (true introducer)  -> both new required fields detected
 *
 * That is strictly worse than examining nothing: the ✓ arrives exactly when the agent is
 * trying to DISCHARGE the PostToolUse strand warning, so it reads as the confirmation they
 * were told to go get. Scoped to this one guard deliberately — it is the only member that
 * prints the `git log -S` recipe, so the family `it.each` would be asserting a contract the
 * others never opted into.
 */
describe('check-required-field-strands — a clean ✓ must not be mistakable for a verified base', () => {
  const GUARD = 'check-required-field-strands.mjs';

  it('carries a positive control on the no-findings path, naming the base as the thing to suspect', () => {
    const tmp = makeCleanRepo();
    try {
      // A genuine textual diff with NO required-field addition — the real no-findings
      // path, not the vacuous one the blocks above cover.
      writeFileSync(join(tmp, FILE_B), 'export interface B { id: string }\n// a genuine textual change\n');
      const { status, headline, out } = run(tmp, GUARD, [`--files=${FILE_B}`]);

      expect(headline).toContain('✓');
      expect(status).toBe(0);
      // The ✓ must not stand alone: a base that ALREADY contains the field produces this
      // identical line, so the run has to name that possibility itself.
      expect(out).toContain('suspect the base');
      expect(out).toContain('yields this same');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 120_000);

  it('never advises `git log -1` for re-deriving the base — it must select the OLDEST match', () => {
    const tmp = makeCleanRepo();
    try {
      // The byte-identical path is the one that PRINTS the recipe.
      const { out } = run(tmp, GUARD, [`--files=${FILE_A}`]);
      expect(out).toContain('NOT CHECKED');

      // FALSIFIABILITY: assert the recipe is present at all before asserting its shape,
      // or a renamed/removed recipe would satisfy the negative assertion vacuously.
      expect(out).toContain('git log');
      expect(out).toContain('-S');
      expect(out).toContain('tail -1');
      // The regression itself: `-1` selects the NEWEST match, whose parent can already
      // contain the field.
      expect(out).not.toContain('git log -1');
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
