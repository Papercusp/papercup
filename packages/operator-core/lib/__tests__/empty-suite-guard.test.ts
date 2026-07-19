/**
 * empty-suite-guard.test.ts — EI-11132 regression guard.
 *
 * `scripts/affected-tests.mjs` runs each affected workspace's `test` /
 * `test:integration` script verbatim. Several workspaces bake
 * `--passWithNoTests` into that script (tolerating a genuinely test-less
 * package) — but the same flag makes vitest exit 0 when its include glob
 * stops matching ANY real test file, silently reporting the workspace green
 * having verified nothing (the "worst outcome for a release check").
 *
 * `scripts/lib/empty-suite-guard.mjs` computes, per run, whether the
 * workspace's own filesystem genuinely contains matching test files — if so,
 * the caller should disable `--passWithNoTests` for that run so a
 * stopped-matching glob fails loudly instead of silently passing. These
 * tests exercise the REAL helper against real temp-dir fixtures (no mocked
 * fs), split out so it's testable without importing (and thereby executing)
 * affected-tests.mjs's side-effecting top-level CLI flow.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import {
  scriptUsesPassWithNoTests,
  hasMatchingTestFilesOnDisk,
  emptySuiteGuardArgs,
  // The .mjs helper has no declaration file; the diagnostic lands on the
  // `from` line of this multi-line import, so the directive must be the
  // LAST comment line immediately above it.
  // @ts-expect-error
} from '../../../../scripts/lib/empty-suite-guard.mjs';

const tmpDirs: string[] = [];
function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'esg-'));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

describe('scriptUsesPassWithNoTests', () => {
  it('detects the flag in a real script string', () => {
    expect(scriptUsesPassWithNoTests('vitest run --passWithNoTests')).toBe(true);
  });

  it('is false for a script without the flag', () => {
    expect(scriptUsesPassWithNoTests('vitest run')).toBe(false);
  });

  it('is false for undefined/empty script text', () => {
    expect(scriptUsesPassWithNoTests(undefined)).toBe(false);
    expect(scriptUsesPassWithNoTests('')).toBe(false);
  });
});

describe('hasMatchingTestFilesOnDisk', () => {
  it('finds a plain *.test.ts file for the unit `test` script', () => {
    const dir = makeTmpDir();
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'foo.test.ts'), '// fixture');
    expect(hasMatchingTestFilesOnDisk(dir, 'test')).toBe(true);
  });

  it('finds a *.spec.ts file too', () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, 'bar.spec.ts'), '// fixture');
    expect(hasMatchingTestFilesOnDisk(dir, 'test')).toBe(true);
  });

  it('an empty workspace (no test files) is false', () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, 'index.ts'), '// not a test');
    expect(hasMatchingTestFilesOnDisk(dir, 'test')).toBe(false);
  });

  it('excludes node_modules from the probe', () => {
    const dir = makeTmpDir();
    mkdirSync(join(dir, 'node_modules', 'some-dep'), { recursive: true });
    writeFileSync(join(dir, 'node_modules', 'some-dep', 'x.test.ts'), '// fixture');
    expect(hasMatchingTestFilesOnDisk(dir, 'test')).toBe(false);
  });

  it('the `test` (unit) probe EXCLUDES *.integration.test.* files — a workspace with ONLY integration tests must not look like it has unit tests', () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, 'only.integration.test.ts'), '// fixture');
    expect(hasMatchingTestFilesOnDisk(dir, 'test')).toBe(false);
  });

  it('the `test` (unit) probe EXCLUDES *.browser.test.* files', () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, 'only.browser.test.ts'), '// fixture');
    expect(hasMatchingTestFilesOnDisk(dir, 'test')).toBe(false);
  });

  it('a `test:integration` script probe ONLY matches *.integration.test.* — a plain unit test file does not count', () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, 'plain.test.ts'), '// fixture');
    expect(hasMatchingTestFilesOnDisk(dir, 'test:integration')).toBe(false);
  });

  it('a `test:integration` script probe DOES match a real *.integration.test.ts file', () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, 'real.integration.test.ts'), '// fixture');
    expect(hasMatchingTestFilesOnDisk(dir, 'test:integration')).toBe(true);
  });

  it('a nonexistent directory degrades to false rather than throwing', () => {
    expect(() => hasMatchingTestFilesOnDisk('/no/such/dir/at/all', 'test')).not.toThrow();
    expect(hasMatchingTestFilesOnDisk('/no/such/dir/at/all', 'test')).toBe(false);
  });
});

describe('emptySuiteGuardArgs — the composed per-run decision', () => {
  it('no guard args when the script does not use --passWithNoTests, even with test files present', () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, 'foo.test.ts'), '// fixture');
    expect(emptySuiteGuardArgs({ scriptText: 'vitest run', wsAbsDir: dir, script: 'test' })).toEqual([]);
  });

  it('no guard args when passWithNoTests IS used but the workspace genuinely has no test files (today\'s lenient case, preserved)', () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, 'index.ts'), '// not a test');
    expect(
      emptySuiteGuardArgs({ scriptText: 'vitest run --passWithNoTests', wsAbsDir: dir, script: 'test' }),
    ).toEqual([]);
  });

  it('appends --no-passWithNoTests when the script uses the flag AND real test files exist on disk', () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, 'foo.test.ts'), '// fixture');
    expect(
      emptySuiteGuardArgs({ scriptText: 'vitest run --passWithNoTests', wsAbsDir: dir, script: 'test' }),
    ).toEqual(['--no-passWithNoTests']);
  });

  it('the integration variant only fires off a real *.integration.test.* file', () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, 'foo.test.ts'), '// unit-only fixture — should NOT count for :integration');
    expect(
      emptySuiteGuardArgs({
        scriptText: 'vitest run --config vitest.integration.config.ts --passWithNoTests',
        wsAbsDir: dir,
        script: 'test:integration',
      }),
    ).toEqual([]);

    writeFileSync(join(dir, 'foo.integration.test.ts'), '// fixture');
    expect(
      emptySuiteGuardArgs({
        scriptText: 'vitest run --config vitest.integration.config.ts --passWithNoTests',
        wsAbsDir: dir,
        script: 'test:integration',
      }),
    ).toEqual(['--no-passWithNoTests']);
  });
});

/**
 * The mechanism this whole fix depends on: appending `--no-passWithNoTests`
 * AFTER a script's own baked-in `--passWithNoTests` must actually override
 * it in the REAL installed vitest CLI (a raw cac/mri negation flag — see
 * node_modules/cac/dist/index.js's mri2, "last occurrence wins"). This is
 * the empirical end-to-end guard: if a future vitest/cac upgrade changes
 * that parsing behavior, THIS test catches it directly against the real
 * binary, not just against our own wrapper logic above.
 */
describe('the --no-passWithNoTests override against the REAL installed vitest binary (EI-11132)', () => {
  const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
  const VITEST_BIN = resolve(REPO_ROOT, 'node_modules/.bin/vitest');

  function runVitest(fixtureDir: string, extraArgs: string[]) {
    return spawnSync(VITEST_BIN, ['run', '--root', fixtureDir, '--passWithNoTests', ...extraArgs], {
      encoding: 'utf8',
      timeout: 30_000,
    });
  }

  it.skipIf(!existsSync(VITEST_BIN))(
    'a zero-match workspace exits 0 under --passWithNoTests alone, and 1 once --no-passWithNoTests is appended after it',
    () => {
      const dir = mkdtempSync(join(tmpdir(), 'esg-real-vitest-'));
      try {
        writeFileSync(join(dir, 'vitest.config.mjs'), "export default { test: { include: ['**/*.test.ts'] } };\n");
        // No test files at all — the "glob stopped matching" scenario.
        const lenient = runVitest(dir, []);
        expect(lenient.status, `expected exit 0 (lenient): ${lenient.stdout}${lenient.stderr}`).toBe(0);

        const guarded = runVitest(dir, ['--no-passWithNoTests']);
        expect(guarded.status, `expected exit 1 (guarded): ${guarded.stdout}${guarded.stderr}`).not.toBe(0);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
