/**
 * testing-guard-script.test.ts — EI-20692923474318761
 *
 * Proves `runGuardScript` surfaces what the shape it replaces loses. The property under
 * test is not "it runs a script" — it is "a FAILING run still carries the script's own
 * report", which is the thing whose absence cost 8 undiagnosable reds over 6h.
 *
 * ── HOW FALSIFIABILITY IS PROVED HERE ───────────────────────────────────────
 * The subject is a module this file imports, so per CLAUDE.md ("Proving a guard is
 * falsifiable") the correct proof is a deliberately-wrong implementation kept
 * PERMANENTLY as a control — never a mutation of the shared tree. `execFileSync` is
 * that control: it is the exact call this helper replaces, it is exercised on the same
 * payload, and it demonstrably fails the property. If a future edit made
 * `runGuardScript` behave like it, the first describe below goes red.
 *
 * No fixture files are written: every case drives `node -e`, so no tracked file is
 * touched and there is nothing for the git-sync sweep to commit.
 */
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

import { runGuardScript } from './testing-guard-script';

const CWD = process.cwd();

/**
 * The real shape of every guard script in this repo: print the findings, and only THEN
 * take a non-zero exit. The report therefore exists on a red exactly as on a green —
 * whether the caller still HAS it is the question.
 */
const REPORTING_GUARD =
  "console.log(JSON.stringify({ unbaselined: [{ file: 'scripts/x.mjs', line: 60 }] })); process.exitCode = 1;";

describe('a failing guard keeps its report (the regression this helper exists for)', () => {
  it('returns the report on stdout alongside the non-zero status', () => {
    const run = runGuardScript('node', ['-e', REPORTING_GUARD], { cwd: CWD });

    expect(run.status).toBe(1);
    const report = JSON.parse(run.stdout) as { unbaselined: { file: string; line: number }[] };
    expect(report.unbaselined).toEqual([{ file: 'scripts/x.mjs', line: 60 }]);
    // …and `output` is directly usable as an assertion message, without the caller
    // having to know that the report went to stdout rather than stderr.
    expect(run.output).toContain('scripts/x.mjs');
  });

  it('CONTROL: execFileSync loses it — the thrown MESSAGE, which is all a runner shows, names only the command', () => {
    let thrown: unknown;
    try {
      execFileSync('node', ['-e', REPORTING_GUARD], { cwd: CWD, encoding: 'utf8' });
    } catch (error) {
      thrown = error;
    }

    // Calibration: if a non-zero exit ever stopped throwing, this control would pass
    // vacuously and prove nothing about the helper.
    expect(thrown, 'a non-zero exit must throw, or this control is vacuous').toBeDefined();

    const message = (thrown as Error).message;
    const attachedStdout = String((thrown as { stdout?: string }).stdout ?? '');

    expect(message).toContain('Command failed');
    expect(message).not.toContain('scripts/x.mjs');
    // The data is on the error OBJECT — but nothing renders it, and the offender is
    // absent from the one string a test runner reports. That gap is the whole defect:
    // recovering one already-computed line costs a hand-run of the guard.
    expect(attachedStdout).toContain('scripts/x.mjs');
  });
});

describe('the failures that leave status null are explained rather than silent', () => {
  it('a missing interpreter reports the spawn error', () => {
    const run = runGuardScript('definitely-not-a-real-binary-pc', [], { cwd: CWD });

    expect(run.status).toBeNull();
    expect(run.output).toContain('spawn failed');
  });

  it('a timeout reports the signal AND the budget, not a bare null', () => {
    const run = runGuardScript('node', ['-e', 'setTimeout(() => {}, 30000)'], {
      cwd: CWD,
      timeoutMs: 500,
    });

    expect(run.status).toBeNull();
    expect(run.output).toContain('killed by signal');
    // The budget is named because "it timed out" and "the budget was too small for a
    // 14k-file walk" are different bugs with the same symptom.
    expect(run.output).toContain('500ms');
  });
});

describe('output composition', () => {
  it('leads with the invocation and carries BOTH streams', () => {
    const run = runGuardScript('node', ['-e', "console.log('on-out'); console.error('on-err')"], {
      cwd: CWD,
    });

    expect(run.status).toBe(0);
    expect(run.output.startsWith('$ node -e ')).toBe(true);
    expect(run.output).toContain('on-out');
    expect(run.output).toContain('on-err');
    expect(run.stdout).toContain('on-out');
    expect(run.stderr).toContain('on-err');
  });

  it('a clean run reports status 0 and no warning note', () => {
    const run = runGuardScript('node', ['-e', "console.log('clean')"], { cwd: CWD });

    expect(run.status).toBe(0);
    expect(run.output).not.toContain('⚠');
  });
});
