/**
 * Pins CLAUDE.md's submodule blob-containment caveat to the code facts it rests on
 * (WI-1255988; follow-up to EI-20881147405154343, whose close shipped prose and
 * correctly drew a `prescribedGuardWarning`).
 *
 * Sibling of `gate-candidate-ref.test.ts` — same P-004 family, same structure, and
 * the FIXTURE CONTROLS are load-bearing for the same reason: once the live assertion
 * goes green it stops being evidence that the detector works at all.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  judgeSubmoduleBlobContainmentCaveat,
  CAVEAT_CLAIM_MARKER,
  CAVEAT_REMEDY_MARKER,
} from './submodule-blob-containment';

// lib/doc-claims → lib → operator-core → packages → <repo root>
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

const git = (args: readonly string[]): string => {
  try {
    return execFileSync('git', args as string[], {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 1 << 26,
    });
  } catch (err) {
    // `git grep` exits 1 on "no matches", which is a real answer, not a failure.
    const e = err as { status?: number; stdout?: string };
    if (e.status === 1 && typeof e.stdout === 'string') return e.stdout;
    throw err;
  }
};

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Paths declared in .gitmodules. */
const declaredSubmodules = (): string[] =>
  git(['config', '-f', '.gitmodules', '--get-regexp', '^submodule\\..*\\.path$'])
    .split('\n')
    .map((l) => l.trim().split(/\s+/)[1] ?? '')
    .filter(Boolean);

/** Of those, the ones that are genuinely mode 160000 at HEAD. One process, not N. */
const gitlinkSubmodules = (declared: readonly string[]): string[] => {
  const staged = new Set(
    git(['ls-files', '--stage'])
      .split('\n')
      .filter((l) => l.startsWith('160000 '))
      .map((l) => l.split('\t')[1] ?? '')
      .filter(Boolean),
  );
  return declared.filter((p) => staged.has(p));
};

/**
 * Superproject `*.test.ts` files that read a path under a submodule AT RUNTIME.
 *
 * Deliberately narrower than "mentions a submodule path": a test that merely imports
 * from a submodule package is not reading across the boundary in the way the caveat
 * describes. Measured 2026-08-30 — the loose definition returns 573 files, this one
 * returns 40 across 4 submodules, and this one contains the caveat's own cited
 * exemplar (`lint-migrations.test.ts`, which resolves `libs/papercusp/libs/db/sql`).
 */
const FS_READ = '(readdirSync|readFileSync|existsSync|statSync|globSync)';

/**
 * Between the read call and the path, use `.*` — NOT `[^\n]*`.
 *
 * grep is line-oriented, so `.*` already cannot cross a newline and the negated class
 * buys nothing. Worse, it is DIALECT-DEPENDENT: GNU `grep -E` reads `[^\n]` as "not a
 * newline", while `git grep -E` reads it literally as a bracket class of `\` and `n`
 * — so it stops matching at the `n` in `join(dirname(...))`. Measured 2026-08-30 on
 * this repo: the two dialects returned 40 vs 4 files for the SAME pattern, and the
 * small number is the one a `git grep`-based guard would silently have adopted as its
 * population. `.*` means the same thing in both.
 */
const SAME_LINE = '.*';

const boundaryReadingTests = (submodules: readonly string[]): string[] => {
  if (submodules.length === 0) return [];
  const alternation = submodules.map(escapeRe).join('|');
  return git([
    'grep',
    '-lE',
    `${FS_READ}${SAME_LINE}(${alternation})`,
    '--',
    '*.test.ts',
  ])
    .split('\n')
    .filter(Boolean);
};

const reachedSubmodules = (submodules: readonly string[]): string[] =>
  submodules.filter((s) => {
    const hits = git(['grep', '-lE', `${FS_READ}${SAME_LINE}${escapeRe(s)}`, '--', '*.test.ts']);
    return hits.trim().length > 0;
  });

/** A fixture doc long enough to clear the min-length refusal, so we test the RULE. */
const doc = (path: string, body: string) => ({
  path,
  text: `${body}\n${'filler line to clear the min-length refusal\n'.repeat(60)}`,
});
const GOOD_DOC_BODY = `> ⚠ **${CAVEAT_CLAIM_MARKER} — NOT that the candidate is.** Diff the gitlinks too: \`git diff --raw <sha> staging | grep '${CAVEAT_REMEDY_MARKER}'\`.`;

const HEALTHY = {
  declaredSubmodules: ['libs/papercusp'],
  gitlinkSubmodules: ['libs/papercusp'],
  boundaryReadingTests: ['packages/operator-core/lib/lint-migrations.test.ts'],
  reachedSubmodules: ['libs/papercusp'],
  docs: [doc('CLAUDE.md', GOOD_DOC_BODY)],
};

describe('CLAUDE.md submodule blob-containment caveat', () => {
  describe('fixture controls (the detector must be able to FAIL)', () => {
    it('accepts the healthy shape — the control that the other fixtures are meaningful', () => {
      const v = judgeSubmoduleBlobContainmentCaveat(HEALTHY);
      expect(v.violations).toEqual([]);
      expect(v.ok).toBe(true);
    });

    it('catches the premise vanishing: no submodule is a gitlink any more', () => {
      const v = judgeSubmoduleBlobContainmentCaveat({
        ...HEALTHY,
        gitlinkSubmodules: [],
      });
      expect(v.ok).toBe(false);
      expect(v.violations.join('\n')).toMatch(/NONE is a real gitlink/);
      // The remedy must be DELETE, not repair — an obsolete caveat is not a broken one.
      expect(v.violations.join('\n')).toMatch(/DELETE the caveat/);
    });

    it('distinguishes "no submodules declared at all" from "declared but not gitlinks"', () => {
      const v = judgeSubmoduleBlobContainmentCaveat({
        ...HEALTHY,
        declaredSubmodules: [],
        gitlinkSubmodules: [],
      });
      expect(v.ok).toBe(false);
      expect(v.violations.join('\n')).toMatch(/No submodules are declared/);
    });

    it('catches the CLASS going empty — no test reads across a boundary', () => {
      const v = judgeSubmoduleBlobContainmentCaveat({
        ...HEALTHY,
        boundaryReadingTests: [],
        reachedSubmodules: [],
      });
      expect(v.ok).toBe(false);
      expect(v.violations.join('\n')).toMatch(/nothing can hit the trap/);
      expect(v.violations.join('\n')).toMatch(/DELETE the caveat/);
    });

    it('catches the claim being dropped from a doc while its premises still hold', () => {
      const v = judgeSubmoduleBlobContainmentCaveat({
        ...HEALTHY,
        docs: [doc('CLAUDE.md', 'some other prose entirely')],
      });
      expect(v.ok).toBe(false);
      expect(v.docsMissingClaim).toEqual(['CLAUDE.md']);
      expect(v.violations.join('\n')).toMatch(/lost rather than retired/);
    });

    it('catches a doc that keeps the WARNING but loses the REMEDY command', () => {
      // The subtly-worse failure: the reader is correctly alarmed and cannot act.
      const v = judgeSubmoduleBlobContainmentCaveat({
        ...HEALTHY,
        docs: [doc('CLAUDE.md', `> ⚠ **${CAVEAT_CLAIM_MARKER} — NOT that the candidate is.**`)],
      });
      expect(v.ok).toBe(false);
      expect(v.docsMissingClaim).toEqual([]);
      expect(v.docsMissingRemedy).toEqual(['CLAUDE.md']);
    });

    it('catches the caveat surviving in ONE projection but not its twin', () => {
      const v = judgeSubmoduleBlobContainmentCaveat({
        ...HEALTHY,
        docs: [doc('CLAUDE.md', GOOD_DOC_BODY), doc('AGENTS.md', 'twin lost the caveat')],
      });
      expect(v.ok).toBe(false);
      expect(v.docsMissingClaim).toEqual(['AGENTS.md']);
    });

    it('REFUSES a short/empty doc read instead of reporting it clean', () => {
      // The false-absence shape: a failed read must never look like a deleted caveat,
      // because those two demand opposite responses.
      expect(() =>
        judgeSubmoduleBlobContainmentCaveat({ ...HEALTHY, docs: [{ path: 'CLAUDE.md', text: '' }] }),
      ).toThrow(/Refusing to judge/);
      expect(() => judgeSubmoduleBlobContainmentCaveat({ ...HEALTHY, docs: [] })).toThrow(
        /Refusing to judge/,
      );
    });
  });

  describe('the live claim', () => {
    const declared = declaredSubmodules();
    const gitlinks = gitlinkSubmodules(declared);
    const boundaryTests = boundaryReadingTests(gitlinks);
    const reached = reachedSubmodules(gitlinks);
    const docs = ['CLAUDE.md', 'AGENTS.md'].map((p) => ({
      path: p,
      text: readFileSync(join(ROOT, p), 'utf8'),
    }));

    it('positive control: the real repo and docs were actually read', () => {
      // Guards against the whole suite passing over an empty probe or a moved doc.
      expect(declared.length).toBeGreaterThan(0);
      expect(docs.every((d) => d.text.length > 10_000)).toBe(true);
      expect(docs.map((d) => d.path)).toEqual(['CLAUDE.md', 'AGENTS.md']);
    });

    // Per WI-41765 / D-008 (gate-candidate-ref.test.ts), the SUBSTANTIVE claim and the
    // detector's own COVERAGE are split. They fail for different reasons and deserve
    // different consequences: the first says the doc is now WRONG and must hold main
    // red; the second says this guard went partially blind, which is worth fixing but
    // is a statement about the instrument, not about the system.
    it('the caveat premises still hold, and both projections still carry it', () => {
      const v = judgeSubmoduleBlobContainmentCaveat({
        declaredSubmodules: declared,
        gitlinkSubmodules: gitlinks,
        boundaryReadingTests: boundaryTests,
        reachedSubmodules: reached,
        docs,
      });
      expect(v.violations).toEqual([]);
      expect(v.ok).toBe(true);
    });

    it('detector coverage: the class is healthy, not scraping its floor (instrument health, not a system claim)', () => {
      // MEASURED 2026-08-30: 38/38 declared submodules are gitlinks; 40 superproject
      // test files read across a boundary, spanning 4 distinct submodules
      // (papercusp-desktop 30, libs/papercusp 7, libs/test-config 2, libs/generic/sse 1).
      //
      // ⚠ WIDEN THE DETECTOR, NEVER LOWER THESE FLOORS. They sit far below the measured
      // population precisely so an ordinary refactor cannot red them; if they start
      // failing, the honest reading is that the FS_READ pattern has stopped recognizing
      // how these tests are written, not that the class genuinely collapsed. Lowering
      // the floor would convert a loud instrument failure into a quiet false-clean.
      expect(gitlinks.length).toBeGreaterThanOrEqual(5);
      expect(boundaryTests.length).toBeGreaterThanOrEqual(10);
      expect(reached.length).toBeGreaterThanOrEqual(2);
    });

    it('the class is defined by a RUNTIME read, not a bare mention', () => {
      // Control for the definition itself: the narrow class must be a strict subset of
      // the loose one, and strictly smaller. If these ever converge, FS_READ has
      // stopped discriminating and the coverage floor above is measuring the wrong set.
      const loose = git([
        'grep',
        '-lE',
        `(${gitlinks.map(escapeRe).join('|')})`,
        '--',
        '*.test.ts',
      ])
        .split('\n')
        .filter(Boolean);
      expect(loose.length).toBeGreaterThan(boundaryTests.length);
      expect(boundaryTests.every((f) => loose.includes(f))).toBe(true);
    });
  });
});
