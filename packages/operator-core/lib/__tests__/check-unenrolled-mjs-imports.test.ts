/**
 * Guard test for `scripts/check-unenrolled-mjs-imports.mjs` (EI-19346163916263067).
 *
 * The guard exists because `operator-core` and `apps/operator` are `allowJs: false`
 * + strict, so importing a plain `.mjs` from TypeScript needs EITHER enrolment in
 * `tsconfig.declarations.json` (generated `.d.mts`) OR a `@ts-ignore` /
 * `@ts-expect-error`. Doing neither is `TS7016`, and nothing else in the repo can
 * see it: vitest never typechecks, and the per-file tsc baseline cannot absorb an
 * error in a file it has never recorded — which is exactly why it REDS the fleet
 * gate rather than being tolerated.
 *
 * WHY THE POSITIVE CONTROLS MATTER MORE THAN THE TREE ASSERTION. "the tree is
 * clean" passes just as happily if the detector is broken and finds nothing at
 * all, so on its own it is a vacuous green. Every negative case below is paired
 * with a synthetic offender differing by one line, so a detector that stopped
 * detecting fails here instead of going quiet.
 *
 * The multi-line case is a regression test for a real bug in the first cut of this
 * guard: it anchored on the `import` keyword and walked upwards, which sails past
 * a directive sitting immediately above the `} from '...'` line — and that is
 * precisely where tsc REQUIRES it for a multi-line import. It reported three
 * correctly-suppressed imports as offenders.
 *
 * THIS FILE'S OWN IMPORT OF THE GUARD SCRIPT BELOW MUST STAY SINGLE-LINE, for the
 * same reason: `directiveAbove()` (the detector this file tests) only scans 3
 * non-blank comment lines above an anchor before giving up, so any explanatory
 * prose inserted BETWEEN the `@ts-ignore` and the import statement pushes the
 * directive out of that window — the detector would then flag this very file
 * (caught live 2026-08-02 fixing EI-18817201237512691's unrelated red: a first
 * attempt added a 3-line explanation between the directive and the import and
 * broke this file's own suppression). Keep any explanation up here in the
 * docstring, never between the directive and the import it suppresses.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — pure JS guard script, no .d.ts; imported for its detector only.
import { BASELINE, baselineKey, isSuppressed, offendersIn, scan, findMjsSpecifiers } from '../../../../scripts/check-unenrolled-mjs-imports.mjs';

type Offender = { file: string; line: number; spec: string; target: string };

/** A throwaway tree with one real `.mjs` so `existsSync` resolves. */
function withFixture(run: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'unenrolled-mjs-'));
  try {
    mkdirSync(join(root, 'scripts'), { recursive: true });
    writeFileSync(join(root, 'scripts', 'helper.mjs'), 'export const x = 1;\n');
    writeFileSync(join(root, 'tsconfig.declarations.json'), '{"files":[]}\n');
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const find = (root: string, text: string, enrolled = new Set<string>()): Offender[] =>
  offendersIn('a.ts', text, enrolled, root) as Offender[];

describe('check-unenrolled-mjs-imports', () => {
  it('flags a bare .mjs import — the positive control the negatives below depend on', () => {
    withFixture((root) => {
      const found = find(root, `import { x } from './scripts/helper.mjs';\n`);
      expect(found).toHaveLength(1);
      expect(found[0]!.target).toBe('scripts/helper.mjs');
      expect(found[0]!.line).toBe(1);
    });
  });

  it('scans a non-git root instead of treating an empty git listing as clean', () => {
    withFixture((root) => {
      writeFileSync(join(root, 'a.ts'), "import { x } from './scripts/helper.mjs';\n");
      expect(scan(root)).toEqual([
        {
          file: 'a.ts',
          line: 1,
          spec: './scripts/helper.mjs',
          target: 'scripts/helper.mjs',
        },
      ]);
    });
  });

  it('does not flag a single-line import suppressed with @ts-ignore', () => {
    withFixture((root) => {
      expect(
        find(root, `// @ts-ignore — pure JS script\nimport { x } from './scripts/helper.mjs';\n`),
      ).toHaveLength(0);
    });
  });

  it('does not flag an import whose directive is separated from it by EXPLANATORY COMMENT LINES', () => {
    // Comment lines are TRIVIA to tsc: it walks back over blank/comment-only lines
    // looking for a preceding directive, so suppression survives any number of them.
    //
    // The guard used to scan with a 3-non-blank-line budget that counted comment
    // lines against it, so a directive carrying more than three lines of
    // explanation read as "unsuppressed". That is a false positive on code tsc
    // compiles clean, and it red-pinned the whole fleet gate on
    // no-module-scope-flag-subscribe-guard.test.ts — whose header carries exactly
    // this shape (eslint pragma + @ts-ignore + 5 explanatory lines +
    // prettier-ignore). Verified against a real tsc run over this exact shape plus
    // a no-directive control: control → TS7016, this shape → clean.
    withFixture((root) => {
      expect(
        find(
          root,
          [
            '// eslint-disable-next-line @typescript-eslint/ban-ts-comment',
            '// @ts-ignore — pure JS guard script, no .d.ts.',
            '// ⚠ Keep this import on ONE line. The TS7016 is reported at the MODULE',
            '// SPECIFIER, so wrapping it into a multi-line named-import list moves the',
            '// specifier out from under the directive and the file regresses by exactly',
            '// one type error. Prettier leaves it alone at this width; if it ever grows',
            '// past the print width, move the directive rather than reflowing it.',
            '// prettier-ignore',
            "import { x } from './scripts/helper.mjs';",
            '',
          ].join('\n'),
        ),
      ).toHaveLength(0);
    });
  });

  it('does not flag a MULTI-LINE import whose directive sits above the `} from` line', () => {
    // The shape that broke the first implementation. tsc lands the diagnostic on
    // the `from` line here, so the directive is INSIDE the braces — below the
    // `import` keyword, not above it.
    withFixture((root) => {
      const text = ['import {', '  x,', '  // @ts-expect-error', "} from './scripts/helper.mjs';", ''].join('\n');
      expect(find(root, text)).toHaveLength(0);
    });
  });

  it('still flags a multi-line import with NO directive (the control for the case above)', () => {
    withFixture((root) => {
      const text = ['import {', '  x,', "} from './scripts/helper.mjs';", ''].join('\n');
      expect(find(root, text)).toHaveLength(1);
    });
  });

  it('flags a MULTI-LINE import whose directive sits above the `import` keyword — that placement does NOT suppress TS7016 (EI-19389216343173748)', () => {
    // Verified empirically against tsc: a directive here suppresses nothing (the
    // diagnostic lands on the `from` line, not the `import` line) and additionally
    // reds as an unused-directive error. A guard that treats this as suppressed
    // gives exactly the false assurance the incident was filed over.
    withFixture((root) => {
      const text = [
        '// @ts-expect-error — WRONG placement for a multi-line import',
        'import {',
        '  x,',
        "} from './scripts/helper.mjs';",
        '',
      ].join('\n');
      expect(find(root, text)).toHaveLength(1);
    });
  });

  it('tolerates the eslint pragma the @ts-ignore convention is always paired with', () => {
    withFixture((root) => {
      const text = [
        '// eslint-disable-next-line @typescript-eslint/ban-ts-comment',
        '// @ts-ignore — pure JS guard script, no .d.ts',
        "import { x } from './scripts/helper.mjs';",
        '',
      ].join('\n');
      expect(find(root, text)).toHaveLength(0);
    });
  });

  it('does not flag a module enrolled for declaration generation', () => {
    withFixture((root) => {
      const enrolled = new Set([join(root, 'scripts', 'helper.mjs')]);
      expect(find(root, `import { x } from './scripts/helper.mjs';\n`, enrolled)).toHaveLength(0);
    });
  });

  it('does not flag a specifier that resolves to nothing — that is TS2307, a different bug', () => {
    withFixture((root) => {
      expect(find(root, `import { x } from './scripts/does-not-exist.mjs';\n`)).toHaveLength(0);
    });
  });

  it('finds both static and dynamic specifiers', () => {
    const specs = (findMjsSpecifiers(
      [`import { a } from './x.mjs';`, `const b = await import('./y.mjs');`, `const c = './not-an-import.mjs';`].join(
        '\n',
      ),
    ) as { spec: string }[]).map((s) => s.spec);
    expect(specs).toContain('./x.mjs');
    expect(specs).toContain('./y.mjs');
    // A bare string that merely ends in .mjs is not an import.
    expect(specs).not.toContain('./not-an-import.mjs');
  });

  it('isSuppressed does not reach past an unrelated statement to borrow a directive', () => {
    const lines = [
      '// @ts-ignore',
      'const unrelated = 1;',
      '',
      '',
      "import { x } from './scripts/helper.mjs';",
    ];
    expect(isSuppressed(lines, 4)).toBe(false);
  });

  it('THE RATCHET: the live tree has no un-baselined offender', () => {
    const offenders = (scan() as Offender[]).filter((o) => !BASELINE.has(baselineKey(o)));
    expect(
      offenders.map((o) => `${o.file}:${o.line} -> ${o.target}`),
      'a .mjs is imported from TS with neither a declaration nor a @ts-ignore — this is TS7016 at the green gate',
    ).toEqual([]);
  });

  it('THE RATCHET: no BASELINE entry has gone stale', () => {
    // Baselined imports that no longer offend must be deleted, or the baseline
    // rots into a permanent allowlist and stops shrinking.
    const live = new Set((scan() as Offender[]).map(baselineKey));
    const stale = [...(BASELINE as Set<string>)].filter((k) => !live.has(k));
    expect(stale, 'these are fixed — delete them from BASELINE in the guard script').toEqual([]);
  });
});
