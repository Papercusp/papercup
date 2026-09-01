/**
 * sql-comment-backtick-scan.mjs — the SQL-comment-backtick line scanner.
 *
 * ⚠ THIS FILE IS THE ONE IMPLEMENTATION. It is plain `.mjs` on purpose, so that
 * BOTH consumers can run the identical predicate:
 *
 *   1. TypeScript — `packages/operator-core/lib/content-lint/sql-comment-backtick.ts`
 *      wraps it as the registry `ContentDetector` (git-sync content guard,
 *      green-checkpoint, `scripts/check-sql-comment-backtick.mjs` tree sweep).
 *   2. PLAIN NODE — the PreToolUse edit-time hook
 *      `apps/operator/scripts/hooks/cc/pretooluse-content-lint.mjs`, which runs
 *      under bare `node` (no tsx) and therefore cannot import a `.ts` at all.
 *
 * That second consumer is why this extraction exists (EI-19457273276133433).
 * Every path that ran this detector previously fired at COMMIT time or later —
 * CI, the git-sync content guard, green-checkpoint. But `:3170` bundles the
 * WORKING TREE, so a merely-SAVED backtick crash-loops the whole fleet's staging
 * host before any commit-time guard can possibly fire. On 2026-08-03 that took
 * `papercup-staging-api` down 6× until systemd gave up. It was at least the 4th
 * recurrence of this class.
 *
 * Mirrors the established `scripts/lib/identity-leak-patterns.mjs` seam: a pure
 * predicate in `scripts/lib/`, enrolled in `tsconfig.declarations.json` so a
 * committed sibling `.d.mts` keeps the TS side fully typed (required — see
 * `scripts/check-unenrolled-mjs-imports.mjs`; operator-core is allowJs:false +
 * strict). Do NOT re-implement the heuristic in either consumer: two sources of
 * truth for "is this file broken" is what D-003 exists to prevent, and the
 * smart-quotes rule in that same hook is already a hand-port "kept in sync in
 * spirit" — the drift shape this seam avoids.
 *
 * ── What it detects ────────────────────────────────────────────────────────
 * A markdown-style backtick-quoted identifier inside a `--` SQL comment that
 * lives inside a template literal ENDS the template early. Two failure modes:
 *
 *  1. SILENT (the dangerous one) — inside a postgres-js tagged template the
 *     trailing text can still parse as valid TS, so the file compiles and RUNS
 *     with the query truncated mid-comment. On 2026-07-05 this amputated the
 *     entire WHERE clause from the mig-504 LWW upserts. A TS parse check CANNOT
 *     see this: the file parses fine.
 *  2. LOUD — in a plain (non-tagged) DDL-fixture template it is a hard TS1005
 *     cascade whose message lands tens of lines from the cause.
 *
 * ── Why a line scanner and not an AST walk ────────────────────────────────
 * Not because "the file does not parse" — measured, the SILENT case parses
 * cleanly and the LOUD case error-recovers into real template nodes. The actual
 * reason is worse: THE AST FAITHFULLY ENCODES THE MIS-PARSE. By the time you
 * have nodes, the stray backtick has already been consumed as the template's
 * TERMINATOR, so it is no longer *inside* any template. An AST walk asking "is
 * there a backtick inside a SQL comment inside this template?" correctly answers
 * NO on a file that is broken exactly that way. A line scanner reads the bytes
 * the AUTHOR wrote, before the parser reinterprets them.
 *
 * ── The >=2 backtick rule (measured, not guessed) ─────────────────────────
 * The authoring mistake is always a markdown-quoted PAIR, so a real offender
 * carries at least TWO unescaped backticks after the marker. Requiring two
 * removes the one systematic false positive: the backtick that legitimately
 * TERMINATES a single-line template. Measured over all 26,376 tracked files on
 * 2026-08-03 — the one-backtick rule produced 7 hits, ALL false positives; the
 * >=2 rule produces ZERO false positives while still catching all three real
 * incidents.
 */

/**
 * @typedef {Object} SqlCommentBacktickHit
 * @property {number} line 1-based line number of the offending line.
 * @property {number} col 1-based column of the FIRST backtick inside the comment — the one that ends the template.
 * @property {string} text The offending source line, trimmed and capped at 140 chars.
 * @property {number} backticks Unescaped backticks found inside the comment (always >= 2).
 */

const USES_SQL_TAG = /(?<![`\w])sql\s*(?:<[^`]{0,200}>)?\s*`/;

const HAS_RAW_DDL = /\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:TABLE|VIEW|(?:UNIQUE\s+)?INDEX)\b/;

const SQL_COMMENT_MARKER = /(?:^|\s)--\s/;

// Bundled Node entrypoints retain a shebang before esbuild's generated marker.
// Keep this in sync with the TypeScript detector so generated output is routed
// back to its generator instead of quarantined for an uneditable prose hit.
const GENERATED_FILE_HEADER = /^(?:#![^\n]*\n)?(?:\/\/|\/\*)[^\n]*(?:\bgenerated (?:by|from)\b|\bdo not edit\b|@generated\b)/i;

/**
 * Does this path fall in scope for the detector?
 * @param {string} f repo-relative (or absolute) file path
 * @returns {boolean}
 */
export const sqlCommentBacktickScopeMatches = (f) =>
  /\.(ts|tsx|mjs)$/.test(f) &&
  !/\.(test|spec)\.(ts|tsx|mjs)$/.test(f) &&
  !f.endsWith('.d.ts') &&
  // Minified sidecar BUILD OUTPUT: a single 42MB line-wrapped bundle where a
  // backtick lands next to a marker by coincidence and there is no authored
  // comment to rephrase. Same exclusion, same reason, as check-no-raw-setinterval.mjs.
  !f.includes('/env-sidecars/') &&
  !f.includes('/node_modules/') &&
  !f.includes('/dist/') &&
  !f.startsWith('_retired/') &&
  !f.includes('/_retired/');

/**
 * @param {string} line
 * @param {number} fromIndex
 * @returns {number}
 */
function countUnescapedBackticks(line, fromIndex) {
  let n = 0;
  for (let i = fromIndex; i < line.length; i++) {
    if (line[i] === '`' && line[i - 1] !== '\\') n++;
  }
  return n;
}

/**
 * @param {string} line
 * @param {number} fromIndex
 * @returns {number}
 */
function firstUnescapedBacktick(line, fromIndex) {
  for (let i = fromIndex; i < line.length; i++) {
    if (line[i] === '`' && line[i - 1] !== '\\') return i;
  }
  return -1;
}

/**
 * Find the first backtick-quoted identifier inside a SQL comment, if any.
 * @param {string} fileName
 * @param {string} text
 * @returns {SqlCommentBacktickHit | null}
 */
export function findSqlCommentBacktick(fileName, text) {
  if (GENERATED_FILE_HEADER.test(text)) return null;
  if (!USES_SQL_TAG.test(text) && !HAS_RAW_DDL.test(text)) return null;

  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = SQL_COMMENT_MARKER.exec(line);
    if (!m) continue;

    // A `//`-style JS comment line is prose, not SQL — its marker and backticks
    // are just discussion (this file itself is full of them).
    const trimmed = line.trimStart();
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;

    const dashIdx = m.index + m[0].indexOf('--');
    const slash = line.indexOf('//');
    if (slash !== -1 && slash < dashIdx) continue;

    const backticks = countUnescapedBackticks(line, dashIdx);
    if (backticks < 2) continue;

    const col = firstUnescapedBacktick(line, dashIdx);
    return {
      line: i + 1,
      col: col + 1,
      text: line.trim().slice(0, 140),
      backticks,
    };
  }
  return null;
}
