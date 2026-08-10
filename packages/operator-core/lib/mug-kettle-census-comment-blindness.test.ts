/**
 * The mug/kettle surface census must not report findings that live in COMMENTS.
 *
 * WI-37661 (2026-08-10). `scripts/mug-kettle-surface-census.mjs` text-matches tokens, and
 * before this guard it scanned RAW source. D7's `D7_TAB_RE` matches a QUOTED role token —
 * and its backtick alternative, there to catch template literals, also matches ordinary
 * markdown code-quoting in prose. So a JSX comment in `OperatorChatSidebar.tsx` explaining
 * why the kettle glyph was removed (it names the cast glyph for `kettle`/`overwatch`) was
 * reported as a NEW UNGATED entry point "mounts tier tab token(s): kettle", and red-pinned
 * the fleet gate on a comment.
 *
 * This is structural for THIS census rather than bad luck: the plan it enforces
 * (retire-mug-kettle-su-only-2026-08-09) is EXECUTED by writing comments that name the
 * retired roles. The guard was primed to fire on its own plan's documentation, so rewording
 * the one offending comment would have left the trap armed for the next one.
 *
 * Two earlier detectors had already worked AROUND comment-blindness instead of removing it
 * (the SELF_FILE exclusion, and D1_DEFINITION_SITES skipping a "header comment") — evidence
 * the class recurs and gets papered over locally each time.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripCommentsOnly } from '../../../scripts/lib/strip-comments-and-strings.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const CENSUS = join(REPO_ROOT, 'scripts/mug-kettle-surface-census.mjs');

type Finding = { category: string; subject: string; file: string; line: number; detail?: string };

let cached: Finding[] | null = null;
function census(): Finding[] {
  if (!cached) {
    const raw = execFileSync('node', [CENSUS, '--json'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 1e8,
    });
    cached = (JSON.parse(raw).findings ?? []) as Finding[];
  }
  return cached;
}

describe('mug/kettle census — comment blindness (WI-37661)', () => {
  /**
   * THE CALIBRATION, deliberately first: every assertion below is satisfied by a census
   * that reports NOTHING, so without this the guard would pass most loudly at the moment
   * the census went blind. That is the failure direction the fix itself risked — masking
   * comments could just as easily have masked the code.
   */
  it('CONTROL: the census still sees a substantial population of REAL entry points', () => {
    const findings = census();
    expect(findings.length).toBeGreaterThan(100);

    // A code-resident door that must never stop being seen. `role === 'mug'` in
    // dbos/durable-spawn.ts is real branching code, not prose.
    const src = readFileSync(join(REPO_ROOT, 'packages/operator-core/lib/dbos/durable-spawn.ts'), 'utf8');
    expect(stripCommentsOnly(src)).toMatch(/role\s*===\s*'mug'/);
  });

  /**
   * The guard proper. A finding whose line is entirely blank once comments are masked was
   * matched in a comment — the token is not code.
   *
   * Scoped to `line > 1` because several detectors record a finding with index 0 (a
   * whole-FILE classification: "component file named for the retiring tier"), which
   * resolves to line 1 and is not a token position at all. Line 1 is very often `/**`,
   * so including those would fail on correct behaviour.
   */
  it('reports no finding whose token lives in a comment', () => {
    const offenders = census()
      .filter((f) => f.line > 1)
      .filter((f) => {
        const abs = join(REPO_ROOT, f.file);
        if (!existsSync(abs)) return false;
        const masked = stripCommentsOnly(readFileSync(abs, 'utf8')).split('\n');
        const line = masked[f.line - 1];
        return line !== undefined && line.trim() === '';
      })
      .map((f) => `${f.file}:${f.line}  [${f.category}/${f.subject}] ${f.detail ?? ''}`);

    expect(
      offenders,
      'These census findings point at a line that is empty once comments are masked, i.e. the ' +
        'token was matched in a COMMENT. Scan `code(abs)` (comment-masked), not `read(abs)`. ' +
        'Use stripCommentsOnly — NOT stripCommentsAndStrings: these detectors read quoted ' +
        "VALUES ('kettle', role: 'cup'), so stripping string contents would blind the census.",
    ).toEqual([]);
  });

  /**
   * The mechanism, proven both ways on a fixture — so a future reader can see that the
   * masking distinguishes prose from code rather than merely deleting things.
   */
  it('CONTROL: masking removes a comment-resident token and keeps a code-resident one', () => {
    const fixture = [
      "const tab = 'kettle';                       // real code, must survive",
      '/* prose naming the cast glyph for `kettle`/`overwatch` — must NOT survive */',
      "// another mention of 'kettle' in a line comment — must NOT survive",
    ].join('\n');

    const masked = stripCommentsOnly(fixture).split('\n');

    expect(masked[0]).toContain("'kettle'"); // code-resident token survives
    expect(masked[1].trim()).toBe(''); // block comment fully masked
    expect(masked[2].trim()).toBe(''); // line comment fully masked
    expect(masked).toHaveLength(3); // line-preserving: offsets/line numbers stay true
  });
});
