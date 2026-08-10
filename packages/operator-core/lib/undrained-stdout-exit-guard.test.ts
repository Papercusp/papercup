/**
 * undrained-stdout-exit-guard.test.ts — EI-20055889379250637
 *
 * Proves `scripts/check-undrained-stdout-exit.mjs` DISCRIMINATES. A lint nobody has
 * watched fail is not a guard: it is a script that has only ever agreed with the tree.
 * Every case below therefore asserts a DIFFERENCE — vulnerable flagged, fixed clean —
 * rather than asserting that the current tree happens to pass.
 *
 * ── THE DEFECT BEING GUARDED, AND ITS MEASUREMENT ───────────────────────────
 * Writes to a PIPE are async in Node; `process.exit()` does not drain them, so output
 * is cut at whatever flushed synchronously. Measured on this box, deterministic x3 —
 * `node -e "console.log('x'.repeat(N)); process.exit(0)" | wc -c`:
 *   N=8000 -> 8001 (survives)   N=16384 -> 8192   N=200000 -> 8192
 * §1 below re-runs that measurement as a live control, so the premise of this whole
 * guard is asserted rather than quoted. (The filing that prompted the guard recorded
 * "64 KiB / 65,536"; that was a timing-dependent observation with a slower reader, not
 * a threshold. ~8 KiB is already unsafe.)
 *
 * It matters because it fails ONLY under a pipe — a TTY and a `> file` redirect are
 * both synchronous — so it is invisible to interactive testing, and a truncated
 * MEASUREMENT parses as FEWER FINDINGS, i.e. reads as CLEANER.
 *
 * ── WHY FIXTURES AND NOT TREE MUTATION ──────────────────────────────────────
 * Proving falsifiability by mutating a tracked file is unsafe here: git-sync commits
 * the whole working tree on a schedule, so a probe that holds a file mutated for the
 * length of a suite can have the mutant COMMITTED even when nothing fails and no
 * handler is skipped (CLAUDE.md, "Proving a guard is falsifiable"). Every case below
 * feeds the detector in-memory instead — no tracked file is ever modified.
 */

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// @ts-expect-error — .mjs guard script with no type declarations; the pure detector is
// exported precisely so this test can drive it without spawning a process per case.
import { findOffendersInSource } from '../../../scripts/check-undrained-stdout-exit.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const flagged = (src: string): number => (findOffendersInSource('fixture.mjs', src) as unknown[]).length;

describe('the mechanism this guard exists for (live control)', () => {
  it('truncates a large payload through a PIPE when process.exit() follows, and does not without it', () => {
    const run = (code: string) =>
      Number(
        execFileSync('bash', ['-c', `node -e ${JSON.stringify(code)} | wc -c`], {
          encoding: 'utf8',
          timeout: 30_000,
        }).trim(),
      );

    const N = 200_000;
    const withExit = run(`console.log('x'.repeat(${N})); process.exit(0)`);
    const withoutExit = run(`console.log('x'.repeat(${N}))`);
    const withExitCode = run(`console.log('x'.repeat(${N})); process.exitCode = 0`);

    // The defect: the payload is cut, and to far less than the oft-quoted 64 KiB.
    expect(withExit).toBeLessThan(N);
    expect(withExit).toBeLessThanOrEqual(65_536);
    // The two controls: both remedies deliver the payload IN FULL.
    expect(withoutExit).toBe(N + 1);
    expect(withExitCode).toBe(N + 1);
  });

  it('preserves the exit status when process.exitCode replaces process.exit', () => {
    const status = execFileSync(
      'bash',
      ['-c', `node -e "console.log('x'.repeat(200000)); process.exitCode = 3" > /dev/null; echo $?`],
      { encoding: 'utf8', timeout: 30_000 },
    ).trim();
    expect(status).toBe('3');
  });
});

describe('shapes the guard MUST flag', () => {
  it('a JSON.stringify dump followed by process.exit', () => {
    expect(flagged('console.log(JSON.stringify(census, null, 2));\nprocess.exit(0);\n')).toBe(1);
  });

  it('an accumulated value followed by process.exit', () => {
    expect(flagged('let out = collect();\nconsole.log(out);\nprocess.exit(1);\n')).toBe(1);
  });

  it('a loop of writes followed by process.exit — the TOTAL output is what truncates', () => {
    expect(flagged('for (const line of lines) console.log(line);\nprocess.exit(code);\n')).toBe(1);
  });

  it('stderr, which truncates identically to stdout', () => {
    expect(flagged('console.error(JSON.stringify(findings));\nprocess.exit(1);\n')).toBe(1);
  });

  it('process.stdout.write, not just console.log', () => {
    expect(flagged('process.stdout.write(JSON.stringify(report));\nprocess.exit(0);\n')).toBe(1);
  });

  it('an exit separated from the write by a couple of statements', () => {
    expect(flagged('console.log(JSON.stringify(x));\nconst n = x.length;\nlog(n);\nprocess.exit(0);\n')).toBe(1);
  });
});

describe('shapes the guard MUST NOT flag', () => {
  it('process.exitCode instead of process.exit — the prescribed fix', () => {
    expect(flagged('console.log(JSON.stringify(census, null, 2));\nprocess.exitCode = 0;\n')).toBe(0);
  });

  it('a write with no process.exit at all — Node drains before a natural exit', () => {
    expect(flagged('console.log(JSON.stringify(census, null, 2));\n')).toBe(0);
  });

  it('a synchronously drained write, even with process.exit', () => {
    expect(flagged('writeStdoutSync(JSON.stringify(census, null, 2));\nprocess.exit(0);\n')).toBe(0);
  });

  it('a caught error — bounded, and a diagnostic rather than piped output', () => {
    expect(flagged('try { go(); } catch (e) {\n  console.error(e);\n  process.exit(1);\n}\n')).toBe(0);
  });

  it('a usage message built from literals', () => {
    expect(flagged("console.error('usage: tool <arg>');\nprocess.exit(2);\n")).toBe(0);
  });

  it('a module-level static string constant, including `.trim()`-wrapped help text', () => {
    // scripts/lint-as-committed.mjs:199 is exactly this shape — the initialiser is a
    // CallExpression, not a template, which an earlier cut of the rule mis-flagged.
    expect(flagged('const USAGE = `usage: x`.trim();\nprocess.stdout.write(USAGE);\nprocess.exit(0);\n')).toBe(0);
  });

  it('a formatter call — a message, not an accumulated value', () => {
    expect(flagged('console.error(red(`failed: ${msg}`));\nprocess.exit(1);\n')).toBe(0);
  });

  it('an exit that is NOT in the write’s synchronous path', () => {
    expect(flagged('console.log(JSON.stringify(x));\nprocess.on("SIGINT", () => process.exit(0));\n')).toBe(0);
  });

  it('the pattern appearing only inside a COMMENT', () => {
    // The first cut of this guard used regex masking and reported a doc comment that
    // merely QUOTED the bad pattern. Parsing with the TypeScript AST makes that
    // impossible; this pins it. (Masking bug filed as EI-20059456952698638.)
    expect(flagged('/* console.log(big); process.exit(0) is the bug */\nconst x = 1;\n')).toBe(0);
  });

  it('code following a regex literal that contains a quote character', () => {
    // The precise shape that broke the regex-masking approach: the quote inside the
    // regex opened a phantom string that blanked the rest of the file, so real
    // offenders after it became INVISIBLE. Asserts the detector still sees past it.
    expect(flagged('const re = /^["\'`]([^"\'`]+)["\'`]$/;\nconsole.log(JSON.stringify(x));\nprocess.exit(0);\n')).toBe(1);
  });
});

describe('the tree is currently clean (ratchet)', () => {
  it('runs the guard over the real repository and finds no unbaselined offender', () => {
    // Execs the guard over REPO_ROOT so this counts as ENFORCEMENT, not merely a unit
    // test of its helpers: check-lint-guard-reachability classifies a test that only
    // feeds fixtures as `logic-test` (ADVISORY), which lets the ratchet rot silently.
    const out = execFileSync('node', ['scripts/check-undrained-stdout-exit.mjs', '--json'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: 180_000,
      maxBuffer: 64 * 1024 * 1024,
    });
    const report = JSON.parse(out) as {
      filesScanned: number;
      unbaselined: { file: string; line: number }[];
      staleBaseline: string[];
    };

    // A scan that measured nothing would pass vacuously — assert it really walked the tree.
    expect(report.filesScanned).toBeGreaterThan(1000);
    expect(report.unbaselined).toEqual([]);
    expect(report.staleBaseline).toEqual([]);
  });
});
