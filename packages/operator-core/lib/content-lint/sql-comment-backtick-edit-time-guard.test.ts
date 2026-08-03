/**
 * Edit-time guard for the SQL-comment-backtick class (EI-19457273276133433).
 *
 * WHY THIS EXISTS. Every pre-existing path that runs this detector — CI, the
 * git-sync content guard, green-checkpoint — fires at COMMIT time or later. But
 * `:3170` bundles the WORKING TREE, so a merely-SAVED backtick breaks the build
 * and crash-loops the whole fleet's staging host immediately. On 2026-08-03 that
 * took `papercup-staging-api` down 6× until systemd gave up, and it was at least
 * the 4th recurrence of this class.
 *
 * MEASURED, AND THE POINT OF THE WHOLE FILE: the offending bytes of that incident
 * are NOT REACHABLE FROM GIT HISTORY. The commit before the fix is clean — the
 * defect never got committed at all. So no commit-time guard could ever have seen
 * it, and no test built from git history can reproduce it. The fixture below is
 * reconstructed from the esbuild error the failing unit actually logged.
 *
 * ── The equivalence pin (read before "simplifying" this file) ───────────────
 * The predicate lives in ONE place, `scripts/lib/sql-comment-backtick-scan.mjs`,
 * precisely so the plain-`node` PreToolUse hook (which cannot import a `.ts`) and
 * the TypeScript ContentDetector run identical logic. The first test below pins
 * those two together on a shared fixture matrix. That pin is load-bearing: the
 * sibling smart-quotes rule in that same hook is a hand-port documented as "kept
 * in sync in spirit", which is exactly the drift this prevents. If you change the
 * heuristic, change the `.mjs` — never re-implement it in a consumer (D-003).
 */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { findSqlCommentBacktick, sqlCommentBacktickScopeMatches } from './sql-comment-backtick';
import {
  findSqlCommentBacktick as findViaMjs,
  sqlCommentBacktickScopeMatches as scopeViaMjs,
} from '../../../../scripts/lib/sql-comment-backtick-scan.mjs';

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const HOOK = path.join(REPO_ROOT, 'apps/operator/scripts/hooks/cc/pretooluse-content-lint.mjs');

// Built by char code so this test file never itself carries the pattern, and so the
// fixture is unambiguous to a human reader.
const BT = String.fromCharCode(96);

const withComment = (commentLine: string): string =>
  [
    'const rows = await sql' + BT,
    '    SELECT name, last_error FROM harness_shared.routines',
    '     WHERE active = true',
    commentLine,
    '     ORDER BY name ASC',
    '     LIMIT 200' + BT + ';',
  ].join('\n');

/** The real 2026-08-03 shape, reconstructed from the esbuild error text. */
const DEFECTIVE = withComment(
  '     -- Oldest error first, so the longest-standing failure is never crowded out; ' + BT + 'name' + BT,
);
/** The prescribed fix: same meaning, straight quotes. */
const REPHRASED = withComment(
  "     -- Oldest error first, so the longest-standing failure is never crowded out; the 'name' column",
);
/** A single backtick legitimately TERMINATING a one-line template — must not trip the >=2 rule. */
const SINGLE_BACKTICK = 'const q = ' + BT + 'SELECT 1 -- trailing comment' + BT + ';';
/** No SQL at all: the file-level scope gate should reject it before any line scan. */
const NO_SQL = 'export const n = 1;\n// -- not sql, just ' + BT + 'prose' + BT + ' in a JS comment\n';

const SUBJECT = 'packages/operator-core/lib/harness/improvements/watchdog.ts';

describe('sql-comment-backtick: one implementation, two consumers', () => {
  it('the .mjs scanner and the TS detector agree on every fixture (anti-drift pin)', () => {
    const fixtures: Array<[string, string]> = [
      ['defective', DEFECTIVE],
      ['rephrased', REPHRASED],
      ['single-backtick', SINGLE_BACKTICK],
      ['no-sql', NO_SQL],
    ];
    for (const [label, text] of fixtures) {
      const ts = findSqlCommentBacktick(SUBJECT, text);
      const mjs = findViaMjs(SUBJECT, text);
      expect(mjs, `${label}: .mjs and .ts must agree`).toEqual(ts);
    }
    for (const p of [SUBJECT, 'a/b.test.ts', 'x/dist/y.mjs', 'z.d.ts', 'q.tsx']) {
      expect(scopeViaMjs(p), `scope must agree for ${p}`).toBe(sqlCommentBacktickScopeMatches(p));
    }
  });

  it('detects the real incident shape, and is quiet on the controls', () => {
    const hit = findViaMjs(SUBJECT, DEFECTIVE);
    expect(hit).not.toBeNull();
    expect(hit!.backticks).toBeGreaterThanOrEqual(2);
    expect(hit!.line).toBe(4);

    expect(findViaMjs(SUBJECT, REPHRASED)).toBeNull();
    expect(findViaMjs(SUBJECT, SINGLE_BACKTICK)).toBeNull();
    expect(findViaMjs(SUBJECT, NO_SQL)).toBeNull();
  });
});

describe('the PreToolUse hook BLOCKS the edit (the guard that was missing)', () => {
  const runHook = (filePath: string, content: string) => {
    const r = spawnSync('node', [HOOK], {
      input: JSON.stringify({ tool_name: 'Write', tool_input: { file_path: filePath, content } }),
      encoding: 'utf8',
      timeout: 20_000,
    });
    let decision = 'allow';
    try {
      decision = JSON.parse(r.stdout.trim() || '{}')?.hookSpecificOutput?.permissionDecision ?? 'allow';
    } catch {
      /* advisory text, or nothing: both mean allow */
    }
    return { decision, stdout: r.stdout };
  };

  const abs = (rel: string) => path.join(REPO_ROOT, rel);

  it('DENIES a write carrying the pattern', () => {
    const { decision, stdout } = runHook(abs(SUBJECT), DEFECTIVE);
    expect(decision).toBe('deny');
    // The reason must explain WHY it blocks rather than reports, or the next author
    // reads it as pedantry and works around it.
    expect(stdout).toContain('3170');
  });

  it('ALLOWS the rephrased fix, so the prescribed remedy is actually reachable', () => {
    expect(runHook(abs(SUBJECT), REPHRASED).decision).toBe('allow');
  });

  it('ALLOWS a legitimate single terminating backtick', () => {
    expect(runHook(abs(SUBJECT), SINGLE_BACKTICK).decision).toBe('allow');
  });

  it('ALLOWS test files — they carry deliberate fixtures of this exact bug', () => {
    expect(runHook(abs('packages/operator-core/lib/content-lint/ts-parse.test.ts'), DEFECTIVE).decision).toBe(
      'allow',
    );
  });
});
