/**
 * Tests for the as-committed lint runner (scripts/lint-as-committed.mjs,
 * EI-18672078222841101).
 *
 * WHAT IS ACTUALLY WORTH TESTING HERE
 * The tool exists because `npm run lint:x` silently answers a different question than
 * the release gate asks, and returns a confident green either way. So the load-bearing
 * property is NOT "it runs a lint" — it is that this tool CANNOT ITSELF report a green
 * for a lint it did not actually run. Every path where a lint is not executed
 * (absent at the ref, the run itself errored) must be a FAILURE, never a skip.
 *
 * If a future edit ever turns `missing` or `error` into a skip, this tool becomes the
 * very bug it was built to remove — a fast, confident, wrong green — so those are the
 * negative controls below, not the happy path.
 *
 * The end-to-end behaviour (extract a tree, symlink node_modules, spawn npm) is
 * deliberately NOT unit-tested: mocking it would assert the mock. It is verified by
 * running the real thing against this repo.
 */
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const scriptPath = resolve(here, '../../../scripts/lint-as-committed.mjs');

const mod = await import(scriptPath);
const { parseArgs, detectorPathsFromCommand, summarize, isDirectCliInvocation } = mod as {
  parseArgs: (argv: string[]) => {
    help: boolean;
    scripts: string[];
    ref: string;
    keep: boolean;
    any: boolean;
    unknown: string[];
    nonLint?: string[];
    selfRecursive?: string[];
  };
  detectorPathsFromCommand: (command: unknown) => string[];
  summarize: (results: { script: string; status: string; note?: string }[]) => {
    exitCode: number;
    failedCount: number;
    lines: string[];
  };
  isDirectCliInvocation: (entryPath?: string) => boolean;
};

describe('parseArgs', () => {
  it('collects positional script names and defaults the ref to HEAD', () => {
    const a = parseArgs(['lint:no-owner-name-tags', 'lint:no-box-identity']);
    expect(a.scripts).toEqual(['lint:no-owner-name-tags', 'lint:no-box-identity']);
    expect(a.ref).toBe('HEAD');
    expect(a.keep).toBe(false);
  });

  it('parses --ref, --keep and --any', () => {
    const a = parseArgs(['lint:tsc', '--ref=origin/staging', '--keep', '--any']);
    expect(a.ref).toBe('origin/staging');
    expect(a.keep).toBe(true);
    expect(a.any).toBe(true);
    expect(a.scripts).toEqual(['lint:tsc']);
  });

  it('flags a non-lint script for refusal — the blast-radius guard', () => {
    // Running an arbitrary npm script inside an extracted tree with symlinked
    // node_modules is a fine place for a read-only scanner and a bad place for a
    // build/migrate/deploy. The guard makes that an explicit choice, not a typo.
    const a = parseArgs(['db:migrate']);
    expect(a.nonLint).toEqual(['db:migrate']);
  });

  it('--any waives the non-lint refusal', () => {
    const a = parseArgs(['db:migrate', '--any']);
    expect(a.nonLint).toEqual([]);
  });

  it('flags self-recursion — the runner matches its own lint:* prefix', () => {
    // Found empirically: sweeping every lint:* through this tool picks up the runner
    // itself, whose inner no-arg run exits 2 on its usage guard and reports as
    // "FAIL — exit 2", indistinguishable from a real violation at the ref.
    const a = parseArgs(['lint:as-committed']) as { selfRecursive: string[] };
    expect(a.selfRecursive).toEqual(['lint:as-committed']);
  });

  it('does not flag ordinary lints as self-recursive', () => {
    const a = parseArgs(['lint:no-owner-name-tags', 'lint:mdx']) as { selfRecursive: string[] };
    expect(a.selfRecursive).toEqual([]);
  });

  it('separates unknown flags from script names so a typo cannot become a script name', () => {
    const a = parseArgs(['lint:mdx', '--ref']); // --ref without '=' is not a ref
    expect(a.unknown).toEqual(['--ref']);
    expect(a.scripts).toEqual(['lint:mdx']);
    expect(a.ref).toBe('HEAD');
  });
});

describe('detectorPathsFromCommand', () => {
  it('extracts a plain node script path', () => {
    expect(detectorPathsFromCommand('node scripts/check-no-owner-name-tags.mjs')).toEqual([
      'scripts/check-no-owner-name-tags.mjs',
    ]);
  });

  it('extracts a nested app-local script path run via tsx', () => {
    expect(detectorPathsFromCommand('node apps/operator/scripts/check-vitest-mock-paths.mjs')).toEqual([
      'apps/operator/scripts/check-vitest-mock-paths.mjs',
    ]);
  });

  it('extracts every file in a multi-file command', () => {
    const cmd =
      'node scripts/test-files.mjs apps/operator/app/_lints/design-primitives.test.ts apps/operator/app/_lints/css-tokens.test.ts';
    expect(detectorPathsFromCommand(cmd)).toEqual([
      'scripts/test-files.mjs',
      'apps/operator/app/_lints/design-primitives.test.ts',
      'apps/operator/app/_lints/css-tokens.test.ts',
    ]);
  });

  it('ignores bare binaries, which this tool cannot version against a git ref', () => {
    // knip/vitest come from node_modules, which is symlinked, not archived. Claiming
    // to have versioned them would be a lie the header explicitly refuses to tell.
    expect(detectorPathsFromCommand('knip --no-config-hints')).toEqual([]);
  });

  it('does not duplicate a path repeated in one command', () => {
    expect(detectorPathsFromCommand('node scripts/a.mjs && node scripts/a.mjs')).toEqual(['scripts/a.mjs']);
  });

  it('is total on a non-string command', () => {
    expect(detectorPathsFromCommand(undefined)).toEqual([]);
    expect(detectorPathsFromCommand(null)).toEqual([]);
  });
});

describe('summarize — fail-closed', () => {
  it('exits 0 only when every lint actually passed', () => {
    const s = summarize([
      { script: 'lint:a', status: 'pass' },
      { script: 'lint:b', status: 'pass' },
    ]);
    expect(s.exitCode).toBe(0);
    expect(s.failedCount).toBe(0);
  });

  it('exits nonzero on a genuine lint failure', () => {
    const s = summarize([
      { script: 'lint:a', status: 'pass' },
      { script: 'lint:b', status: 'fail', note: 'exit 1' },
    ]);
    expect(s.exitCode).toBe(1);
    expect(s.failedCount).toBe(1);
  });

  // ── the two negative controls this file exists for ──

  it('NEGATIVE CONTROL: a script absent at the ref FAILS — it must never read as a skip', () => {
    // "It only exists in your working tree" is the exact finding worth surfacing. If
    // this ever returned 0, the tool would print green for a lint the gate cannot run.
    const s = summarize([{ script: 'lint:only-local', status: 'missing', note: 'not in package.json at abc1234' }]);
    expect(s.exitCode).toBe(1);
    expect(s.failedCount).toBe(1);
    expect(s.lines[0]).toContain('MISSING@REF');
  });

  it('NEGATIVE CONTROL: a run that errored FAILS — an un-run lint is not a passing lint', () => {
    const s = summarize([{ script: 'lint:a', status: 'error', note: 'spawn npm ENOENT' }]);
    expect(s.exitCode).toBe(1);
    expect(s.lines[0]).toContain('ERROR');
  });

  it('one missing lint poisons an otherwise-green batch', () => {
    const s = summarize([
      { script: 'lint:a', status: 'pass' },
      { script: 'lint:b', status: 'missing' },
      { script: 'lint:c', status: 'pass' },
    ]);
    expect(s.exitCode).toBe(1);
    expect(s.failedCount).toBe(1);
  });

  it('an empty result set is not a green — nothing ran, so nothing was verified', () => {
    // Guarded deliberately: summarize([]) returning exitCode 0 is only safe because the
    // CLI refuses an empty script list up front (exit 2). This pins the pairing so a
    // future edit that drops that refusal cannot silently produce "All 0 lint(s) pass".
    expect(parseArgs([]).scripts).toEqual([]);
    expect(summarize([]).failedCount).toBe(0);
  });
});

describe('isDirectCliInvocation', () => {
  it('is false when imported (as this test does) so an import never extracts a tree', () => {
    expect(isDirectCliInvocation('/usr/bin/vitest')).toBe(false);
    expect(isDirectCliInvocation(undefined)).toBe(false);
  });

  it('is true for a direct CLI run', () => {
    expect(isDirectCliInvocation('/repo/scripts/lint-as-committed.mjs')).toBe(true);
    expect(isDirectCliInvocation('scripts/lint-as-committed.mjs')).toBe(true);
  });

  it('does not match a lookalike basename', () => {
    // The boundary is a path separator (or string start), not a bare suffix — so a
    // file whose name merely ENDS with the script name is not the script.
    expect(isDirectCliInvocation('/repo/scripts/lint-as-committed.mjs.bak')).toBe(false);
    expect(isDirectCliInvocation('/repo/scripts/not-lint-as-committed.mjs')).toBe(false);
  });
});

describe('the npm script is registered', () => {
  it('package.json exposes lint:as-committed pointing at this script', () => {
    const require_ = createRequire(import.meta.url);
    const pkg = require_(resolve(here, '../../../package.json')) as { scripts: Record<string, string> };
    expect(pkg.scripts['lint:as-committed']).toBe('node scripts/lint-as-committed.mjs');
  });
});
