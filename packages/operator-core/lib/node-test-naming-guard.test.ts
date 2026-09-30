/**
 * Recurrence guard for the node:test / vitest framework-collision footgun (EI-10878).
 *
 * A handful of `@papercusp/cli` test files are `node:test` suites (run via the
 * package's own `node --test`, NOT vitest). Named as plain `*.test.ts`, ANY
 * vitest discovery path that reaches them — a broad `**\/*.test.ts` glob, an
 * agent's bare `vitest run <file>` from the repo root, or the green-checkpoint's
 * per-file ISOLATION re-run (`vitest run <file>`) — imports them under vitest's
 * collector. Vitest doesn't recognize the `describe`/`it` registered via
 * `node:test`, so it reports "No test suite found in file …" and exits non-zero,
 * which the red-test watchdog recorded as a repeatedly-failing test even though
 * the suite is green under its own `node --test`. (A package-local
 * `vitest.config.ts` with `include: []` only neutralizes the package's OWN
 * vitest invocation — CWD = the package — NOT a root-level `vitest run <file>`,
 * which resolves the root CWD's config, so it never actually closed the hole.)
 *
 * The naming contract: a `node:test` file MUST NOT use the `.test.<ext>` suffix
 * that vitest globs. Name it `*.node-test.<ext>` instead (`node --test` still
 * discovers it via the package's own test glob). This meta-test lives in the
 * gated unit suite and scans the whole monorepo, failing with an actionable
 * rename message if any `node:test` suite reappears under a vitest-globbed name —
 * turning a silent watchdog red back into an actionable unit failure.
 */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// packages/operator-core/lib → up 3 = monorepo root.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

// Pruned during descent (NOT just filtered) so the walk never enters node_modules
// et al. — a `readdirSync(root, { recursive: true })` would descend into them first.
const IGNORE_DIRS = new Set(['node_modules', 'dist', '.next', '.git', 'coverage', '.vitest-tmp', '_retired']);

// Matches ONLY the suffixes the operator/papercusp vitest sweep actually globs —
// `defineVitestConfig`'s unit include is exactly `**\/*.test.ts` + `**\/*.test.tsx`
// (libs/test-config/src/vitest-config.ts). `.test.js` / `.test.mjs` node:test files
// (desktop tests, pot-eval fixtures, scratch demos) are NEVER collected by that
// sweep, so they are outside the EI-10878 collision class and must NOT be flagged.
// A `*.node-test.ts` file has a `-` (not a `.`) before `test`, so it does not match.
const VITEST_GLOBBED_TEST_FILE = /\.test\.tsx?$/;

// The node:test import that makes vitest report "No test suite found". Anchored
// to a real import/require STATEMENT at line start (multiline) so a string
// literal that merely mentions `node:test` — e.g. a fixture in THIS guard file —
// is not itself flagged.
const IMPORTS_NODE_TEST =
  /^\s*(?:import\b[^\n]*?\bfrom\s*['"]node:test['"]|(?:const|let|var)\b[^\n]*?=\s*require\(\s*['"]node:test['"]\s*\))/m;

function collectVitestGlobbedTestFiles(dir: string, out: string[] = []): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out; // unreadable dir (e.g. a dangling submodule) — skip, never fail the walk
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!IGNORE_DIRS.has(entry.name)) collectVitestGlobbedTestFiles(join(dir, entry.name), out);
    } else if (entry.isFile() && VITEST_GLOBBED_TEST_FILE.test(entry.name)) {
      out.push(join(dir, entry.name));
    }
  }
  return out;
}

/**
 * Is `absPath` ignored by the git repository that owns it? The contract is about
 * the REPOSITORY: a gitignored file (an agent's `.papercusp/scratch/` demo) never
 * reaches a clean checkout, git-sync never commits it, and it must not red-pin
 * this guard in the shared tree (WI-10004152: `.papercusp/scratch/ivo-tsc/
 * ivo-tictactoe.test.ts` did exactly that in a tip pre-flight). Untracked but
 * NOT ignored files still count — git-sync will commit them.
 *
 * `git -C <nearest existing ancestor>` so the innermost repository answers (a
 * submodule path is judged by the submodule's own ignore rules) and a path whose
 * directory does not exist yet can still be asked about. Anything other than a
 * definite "ignored" (exit 0) — including a git error — keeps the file in scope:
 * fail toward flagging, never toward silence.
 */
export function isGitIgnored(absPath: string): boolean {
  let cwd = dirname(absPath);
  while (!existsSync(cwd) && dirname(cwd) !== cwd) cwd = dirname(cwd);
  const res = spawnSync('git', ['-C', cwd, 'check-ignore', '-q', relative(cwd, absPath)], { stdio: 'ignore' });
  return res.status === 0;
}

/** The subset of `files` that are `node:test` suites misnamed as vitest-globbed
 *  `*.test.<ext>` (they import `node:test`), sorted. Pure — takes explicit
 *  contents so it is unit-testable without touching the filesystem. */
export function findMisnamedNodeTests(files: readonly { path: string; content: string }[]): string[] {
  return files
    .filter((f) => VITEST_GLOBBED_TEST_FILE.test(f.path) && IMPORTS_NODE_TEST.test(f.content))
    .map((f) => f.path)
    .sort();
}

describe('findMisnamedNodeTests', () => {
  it('flags a node:test file named *.test.ts but NOT a vitest file or a *.node-test.ts', () => {
    const flagged = findMisnamedNodeTests([
      { path: 'a/foo.test.ts', content: "import { describe, it } from 'node:test';" },
      { path: 'a/bar.test.ts', content: "import { describe, it } from 'vitest';" },
      { path: 'a/baz.node-test.ts', content: "import { describe, it } from 'node:test';" },
      { path: 'a/qux.test.tsx', content: "const t = require('node:test');" },
    ]);
    expect(flagged).toEqual(['a/foo.test.ts', 'a/qux.test.tsx']);
  });

  it('returns [] when nothing is misnamed', () => {
    expect(
      findMisnamedNodeTests([
        { path: 'x.test.ts', content: "import { describe, it } from 'vitest';" },
        { path: 'y.node-test.ts', content: "import { describe, it } from 'node:test';" },
      ]),
    ).toEqual([]);
  });
});

describe('isGitIgnored', () => {
  // Both directions, so the filter below can neither pass vacuously (everything
  // "ignored") nor stop filtering (nothing ignored). Pattern-based: the probe
  // paths need not exist.
  it('treats a .papercusp/scratch path as ignored and a tracked source path as not', () => {
    expect(isGitIgnored(join(REPO_ROOT, '.papercusp', 'scratch', 'naming-guard-probe', 'x.test.ts'))).toBe(true);
    expect(isGitIgnored(fileURLToPath(import.meta.url))).toBe(false);
    expect(isGitIgnored(join(REPO_ROOT, 'packages', 'operator-core', 'lib', 'not-yet-written.test.ts'))).toBe(false);
  });
});

describe('node:test naming contract (vitest collision guard, EI-10878)', () => {
  it('has NO node:test suite named as a vitest-globbed *.test.<ext> anywhere in the repo', () => {
    const files = collectVitestGlobbedTestFiles(REPO_ROOT).map((abs) => ({
      path: relative(REPO_ROOT, abs),
      content: (() => {
        try {
          return readFileSync(abs, 'utf8');
        } catch {
          return '';
        }
      })(),
    }));
    // check-ignore runs only on the (usually empty) flagged set, never the walk.
    const misnamed = findMisnamedNodeTests(files).filter((p) => !isGitIgnored(join(REPO_ROOT, p)));
    expect(
      misnamed,
      misnamed.length
        ? 'A `node:test` suite named `*.test.<ext>` is globbed by vitest, which reports "No test suite ' +
            'found in file …" and exits non-zero — the red-test watchdog then records it as a ' +
            'repeatedly-failing test even though it is green under its own `node --test` (EI-10878). ' +
            'Rename each to `*.node-test.<ext>` (and update the package test glob):\n  ' +
            misnamed.join('\n  ')
        : '',
    ).toEqual([]);
  });
});
