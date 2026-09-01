/**
 * posttooluse-tsc-verdict-stale-nudge — the recurrence guard for the
 * stale-tsc-verdict CLASS (EI-19421388108187854).
 *
 * WHY THIS FILE EXISTS, given the hook already ships a `--self-test`.
 * A hook-only guard is classified ADVISORY by check-lint-guard-reachability,
 * and its stated reason is that such a guard ROTS: nothing on a blocking path
 * runs it, so it accrues drift silently. Spawning `--self-test` from a
 * *.test.ts is what moves those cases onto the affected-suite leg the gate
 * actually runs. (Same rationale, verbatim in spirit, as
 * posttooluse-registry-census-drift-nudge.test.ts.)
 *
 * That spawn is only worth anything because the self-test can FAIL — a check
 * that cannot fail is not a check. Case 2 proves it by inverting one assertion
 * in a COPY under tmp. It is a copy, never the tracked file, because this repo
 * is swept by git-sync every few minutes: an in-tree mutation can be COMMITTED
 * by the sweep even when nothing goes wrong and no handler fails, which is why
 * CLAUDE.md's mutation-probe guidance puts copy-out ahead of in-tree mutation.
 *
 * Cases 3-5 drive the REAL path — a real temp repo, a real marker file, real
 * stdin — rather than the injected-IO path the self-test uses, because the
 * whole failure mode this hook addresses is one where reading the code gives a
 * confident wrong answer about what actually fires.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOK = resolve(HERE, '..', 'posttooluse-tsc-verdict-stale-nudge.mjs');

/** Run the hook with a PostToolUse payload; returns its stdout (empty === silent). */
function runHook(filePath: string, cwd: string): string {
  return execFileSync(process.execPath, [HOOK], {
    input: JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: filePath } }),
    encoding: 'utf-8',
    cwd,
  });
}

describe('posttooluse-tsc-verdict-stale-nudge', () => {
  let repo: string;
  let srcFile: string;

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), 'tsc-stale-nudge-'));
    // A repo root is "a dir holding both .git and package.json" — build a real one.
    mkdirSync(join(repo, '.git'), { recursive: true });
    writeFileSync(join(repo, 'package.json'), '{"name":"fixture"}\n');
    mkdirSync(join(repo, 'src'), { recursive: true });
    srcFile = join(repo, 'src', 'a.test.ts');
    writeFileSync(srcFile, 'export const a = 1;\n');
    mkdirSync(join(repo, '.papercusp', 'scratch'), { recursive: true });
  });

  afterAll(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  const writeMarker = (atMs: number, files: string[] | null) =>
    writeFileSync(
      join(repo, '.papercusp', 'scratch', 'lint-tsc-last-run.json'),
      JSON.stringify({ label: 'operator-core', at: new Date(atMs).toISOString(), atMs, scope: 'files', files }),
    );
  const clearLedger = () =>
    rmSync(join(repo, '.papercusp', 'scratch', 'lint-tsc-stale-nudge.json'), { force: true });

  it('1. --self-test passes', () => {
    const out = execFileSync(process.execPath, [HOOK, '--self-test'], { encoding: 'utf-8' });
    expect(out).toContain('all cases passed');
  });

  it('2. the self-test can FAIL (falsifiable) — proven on a COPY, never the tracked file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tsc-stale-mutant-'));
    try {
      // Keep the BASENAME: direct-invocation detection is path-based, and a
      // renamed copy that runs nothing would exit 0 and read exactly like a pass.
      const mutant = join(dir, 'posttooluse-tsc-verdict-stale-nudge.mjs');
      copyFileSync(HOOK, mutant);
      const src = readFileSync(mutant, 'utf-8');
      // Invert the core assertion: claim it fires when no verdict is standing.
      const mutated = src.replace(
        "staleVerdictNudge({ ...base, readMarker: () => null }) === null,",
        "staleVerdictNudge({ ...base, readMarker: () => null }) !== null,",
      );
      expect(mutated).not.toBe(src); // the mutation must actually apply
      writeFileSync(mutant, mutated);

      let exitCode = 0;
      try {
        execFileSync(process.execPath, [mutant, '--self-test'], { encoding: 'utf-8', stdio: 'pipe' });
      } catch (err) {
        exitCode = (err as { status?: number }).status ?? 0;
      }
      expect(exitCode).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('3. FIRES on a TS file edited after a standing verdict, naming the union re-run set', () => {
    clearLedger();
    writeMarker(Date.now() - 60_000, ['src/other.ts']);
    const out = runHook(srcFile, repo);
    expect(out).toContain('STALE TYPECHECK VERDICT');
    // The re-run command must name BOTH the previously-covered file and the new
    // one — naming only the new file would bank the same partial verdict again.
    expect(out).toContain('--files=src/other.ts,src/a.test.ts');
  });

  it('4. fires at most ONCE per file per verdict', () => {
    clearLedger();
    writeMarker(Date.now() - 60_000, ['src/other.ts']);
    expect(runHook(srcFile, repo)).toContain('STALE TYPECHECK VERDICT');
    expect(runHook(srcFile, repo)).toBe('');
  });

  it('5. SILENT when no verdict is standing (the common case must not nag)', () => {
    clearLedger();
    rmSync(join(repo, '.papercusp', 'scratch', 'lint-tsc-last-run.json'), { force: true });
    expect(runHook(srcFile, repo)).toBe('');
  });

  it('6. SILENT on a non-typechecked file', () => {
    clearLedger();
    writeMarker(Date.now() - 60_000, ['src/other.ts']);
    const md = join(repo, 'src', 'notes.md');
    writeFileSync(md, '# notes\n');
    expect(runHook(md, repo)).toBe('');
  });

  it('7. SILENT when the standing verdict is older than the live window', () => {
    clearLedger();
    writeMarker(Date.now() - 13 * 60 * 60 * 1000, ['src/other.ts']);
    expect(runHook(srcFile, repo)).toBe('');
  });
});
