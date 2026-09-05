/**
 * GUARD: `harness_shared.session_turns.text` is INSERT-ONLY.
 *
 * turn-chunk-sync.ts detects work with `chunked_at IS NULL` (migration 1117)
 * instead of re-hashing every chunk-eligible turn's text on every tick. That
 * retired ~5.5s/tick of pure sha256 (measured 2026-09-05: the same query costs
 * 6859ms with the sha and 1338ms without), but it BUYS that with an invariant:
 *
 *   a turn's text never changes after insert, so a turn marked chunked never
 *   needs re-chunking.
 *
 * If some future writer starts UPDATEing `text`, the marker goes stale silently:
 * the turn keeps its old chunks, `chunked_at` stays set, and it is never
 * re-selected. Nothing throws, nothing is logged, and stale chunks serve search
 * results indefinitely — the class of bug that is expensive to find later and
 * free to prevent here, so it is asserted rather than trusted.
 *
 * Verified against live data when the invariant was adopted: of 203,474
 * chunk-eligible turns carrying chunks, the number whose stored turn_sha
 * disagreed with sha256(current text) was ZERO.
 *
 * If you are here because this test failed, you have three honest options — do
 * NOT simply delete the assertion:
 *   1. Don't update `text`; insert a new turn row instead.
 *   2. Set `chunked_at = NULL` in the SAME statement that changes `text`, so the
 *      turn is re-chunked — then the statement is correct and the guard's
 *      `resetsChunkedAt` check below will accept it.
 *   3. Abandon the marker and return to sha-based detection — but read
 *      EI-19456024312507672 first for what that costs at current scale.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/** repo root: .../packages/operator-core/lib/search -> up 4 */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const SCAN_ROOTS = ['packages', 'libs', 'apps'];
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage', 'target']);

function* walk(dir: string): Generator<string> {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) yield* walk(full);
    else if (entry.endsWith('.ts') || entry.endsWith('.sql')) yield full;
  }
}

interface UpdateSite {
  file: string;
  /** The statement text from `UPDATE ... session_turns` to its terminator. */
  statement: string;
  setsText: boolean;
  resetsChunkedAt: boolean;
}

/**
 * Find every UPDATE against session_turns and decide whether it writes `text`.
 *
 * Deliberately substring-based rather than a SQL parse: these statements are
 * embedded in template literals and `sql.unsafe` strings, so there is no parser
 * that sees them all, and a scan that silently matched nothing would be the
 * false-negative this guard exists to prevent. The positive control below is
 * what makes an empty result a FAILURE rather than a pass.
 */
function findUpdateSites(): UpdateSite[] {
  const sites: UpdateSite[] = [];
  const selfPath = fileURLToPath(import.meta.url);
  for (const root of SCAN_ROOTS) {
    for (const file of walk(join(REPO_ROOT, root))) {
      if (file === selfPath) continue; // this file quotes the pattern in prose
      let src: string;
      try {
        src = readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      if (!src.includes('session_turns')) continue;
      const re = /UPDATE\s+harness_shared\.session_turns\b/gi;
      let m: RegExpExecArray | null;
      while ((m = re.exec(src)) !== null) {
        // The SET clause runs until the statement's WHERE; that window is what
        // decides whether `text` is assigned. Bounded so a whole file is never
        // swept up by a missing terminator.
        const window = src.slice(m.index, m.index + 1200);
        const setClause = window.split(/\bWHERE\b/i)[0] ?? window;
        const setsText = /\btext\s*=/i.test(setClause);
        const resetsChunkedAt = /\bchunked_at\s*=\s*NULL\b/i.test(setClause);
        sites.push({
          file: relative(REPO_ROOT, file),
          statement: setClause.replace(/\s+/g, ' ').slice(0, 240),
          setsText,
          resetsChunkedAt,
        });
      }
    }
  }
  return sites;
}

describe('session_turns.text is insert-only (turn-chunk-sync chunked_at invariant)', () => {
  const sites = findUpdateSites();

  it('POSITIVE CONTROL: the scan actually finds the known UPDATE sites', () => {
    // Without this, a broken scanner (wrong root, changed schema prefix, bad
    // regex) returns [] and every assertion below passes vacuously — an
    // instrument reporting "no violations" because it measured nothing.
    expect(
      sites.length,
      'scanner found ZERO UPDATE statements against harness_shared.session_turns; ' +
        'the scanner is broken, not the codebase — fix it before trusting a green run here',
    ).toBeGreaterThan(0);

    // The two known, legitimate writers at the time this guard was written.
    const setClauses = sites.map((s) => s.statement).join('\n');
    expect(setClauses).toMatch(/owner\s*=/i);
    expect(setClauses).toMatch(/turn_origin\s*=/i);
  });

  it('no UPDATE assigns session_turns.text without also clearing chunked_at', () => {
    const offenders = sites.filter((s) => s.setsText && !s.resetsChunkedAt);
    expect(
      offenders.map((o) => `${o.file}: ${o.statement}`),
      'An UPDATE writes session_turns.text without resetting chunked_at. That silently ' +
        'strands the turn with stale chunks forever (see this file\'s header for the three ' +
        'honest fixes). Do not delete this assertion.',
    ).toEqual([]);
  });

  it('the ingest upsert does not overwrite text on conflict', () => {
    const ingest = readFileSync(
      join(REPO_ROOT, 'packages/operator-core/lib/search/session-ingest.ts'),
      'utf8',
    );
    const idx = ingest.indexOf('INSERT INTO harness_shared.session_turns');
    expect(idx, 'session-ingest.ts no longer contains the session_turns INSERT').toBeGreaterThan(-1);

    const stmt = ingest.slice(idx, idx + 900);
    // ON CONFLICT DO NOTHING is what makes re-ingest non-mutating. A DO UPDATE
    // that touched text would break the invariant just as surely as a bare
    // UPDATE, and would not be caught by the scan above.
    expect(stmt).toMatch(/ON\s+CONFLICT\s+DO\s+NOTHING/i);
    expect(stmt).not.toMatch(/DO\s+UPDATE[\s\S]*\btext\s*=/i);
  });
});
