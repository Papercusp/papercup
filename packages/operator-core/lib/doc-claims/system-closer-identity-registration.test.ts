/**
 * Every automation identity that terminal-closes a work-item must classify as `system`
 * (design-to-code-coverage-seam-2026-09-02 P-003). Sibling of `same-listener-websocket-sites`
 * / `gate-candidate-ref`, same family and same discipline.
 *
 * WHY A PIN AND NOT A LIST. `completion-audit.ts` carries the instruction "grep the repo for
 * that literal to keep this list exhaustive when a new bypass is added". That instruction had
 * already failed twice by the time anyone checked: `structural-error-verifier` and
 * `tsc-red-cleared-resolve` both close through the ORDINARY gate (a `completionRef`, no
 * `skipCompletionGate`), so neither membership list named them and neither prefix convention
 * covered them. Measured 2026-09-02 over 7 days, the first alone closed 397 work-items, every
 * one of them classified `agent`.
 *
 * That misclassification was invisible while nothing depended on it. P-003 made something
 * depend on it — an `agent`-classified closer now gets its evidence GRADED — so a third
 * un-registered identity would silently start stamping `proposed` on ~400 automation closes a
 * week. This test is the derived-truth rung-2 pin that turns that into a build failure.
 *
 * ── WHAT THIS PROBE OBSERVES, AND WHAT IT DOES NOT ──────────────────────────────────
 * It observes `setIssueState(<expr>, '<terminal state>', '<string literal>')` — the issue
 * family's positional `by`, which is where both drifted identities live and the one call shape
 * that binds an identity to a close unambiguously in source text.
 *
 * It does NOT observe `setWorkItemState`, whose `by` is a field on an options object that may
 * be built anywhere. That gap is stated rather than papered over: a `by:` scan across the tree
 * matches ordinary non-close values (`'human'`, `'validator'`, `'orchestrator'`), so it would
 * need an allowlist — and an allowlist of things-that-are-fine is exactly the hand-maintained
 * artifact this file exists to replace. Measured 2026-09-02, every literal feature-family
 * closer in the tree already carries a `system:` prefix, so the uncovered shape is currently
 * empty rather than merely unchecked.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyTerminalOwner } from '../completion-audit';
import { ANY_FAMILY_TERMINAL_STATES } from '../work-item-dispatch-states';

// lib/doc-claims → lib → operator-core → packages → <repo root>
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const SCAN_DIRS = ['packages', 'apps', 'libs'];
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage', '.turbo']);

export interface LiteralCloseSite {
  file: string;
  state: string;
  by: string;
}

/**
 * Strip comments before matching. The subject of this file is a set of code comments that
 * NAME these identities (the registration doc quotes both call sites), so a comment-blind
 * scanner would report the paragraph documenting the identities as an instance of them.
 * "Comments are not code" is pinned by a fixture below rather than assumed.
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

const TERMINAL_STATES = new Set(ANY_FAMILY_TERMINAL_STATES);

/**
 * Find `setIssueState(<expr>, '<state>', '<literal by>')` sites. Pure and exported so the
 * fixture controls below can run it over text that is NOT the live tree — without that, a
 * green result over a tree that happens to be clean is indistinguishable from a scanner that
 * matches nothing at all.
 */
export function findLiteralByCloseSites(file: string, source: string): LiteralCloseSite[] {
  const re = /setIssueState\(\s*[^,()]+,\s*'([a-z][a-z0-9-]*)'\s*,\s*'([^']+)'/g;
  const out: LiteralCloseSite[] = [];
  for (const m of stripComments(source).matchAll(re)) {
    const [, state, by] = m;
    if (!TERMINAL_STATES.has(state)) continue;
    out.push({ file, state, by });
  }
  return out;
}

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
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
    if (st.isDirectory()) walk(full, out);
    else if (full.endsWith('.ts') && !full.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

function scanTree(): LiteralCloseSite[] {
  const sites: LiteralCloseSite[] = [];
  for (const dir of SCAN_DIRS) {
    for (const file of walk(join(ROOT, dir))) {
      const rel = relative(ROOT, file);
      let src: string;
      try {
        src = readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      if (!src.includes('setIssueState(')) continue;
      sites.push(...findLiteralByCloseSites(rel, src));
    }
  }
  return sites;
}

describe('every hardcoded terminal-close identity is registered as system', () => {
  const sites = scanTree();

  it('finds the known call sites — the scanner is not matching zero', () => {
    // The false-green this rules out: a regex that stopped matching would make every
    // assertion below vacuously true, and a passing suite would then be evidence of
    // nothing. Both named identities are real sites in the tree today.
    const found = new Set(sites.map((s) => s.by));
    expect(found).toContain('structural-error-verifier');
    expect(found).toContain('tsc-red-cleared-resolve');
    expect(sites.length).toBeGreaterThanOrEqual(3);
  });

  it('classifies every one of them as a system closer', () => {
    const misclassified = sites
      .filter((s) => classifyTerminalOwner(s.by) === 'agent')
      .map((s) => `${s.by} (${s.file}, → '${s.state}')`);
    expect(
      misclassified,
      'A terminal close whose `by` is a hardcoded string literal is automation, never a live ' +
        'agent — but classifyTerminalOwner calls these `agent`, so derivedTerminalCompletionAuthority ' +
        'will start GRADING their closes. Register each in KNOWN_SYSTEM_GATED_CLOSER_IDENTITIES ' +
        '(completion-audit.ts) — or in KNOWN_SYSTEM_COMPLETION_BYPASS_IDENTITIES if it passes ' +
        'skipCompletionGate — then re-run.',
    ).toEqual([]);
  });
});

describe('fixture controls — the detector can actually fail', () => {
  it('CATCHES an unregistered literal closer', () => {
    const sites = findLiteralByCloseSites(
      'fixture.ts',
      `await setIssueState(issueId, 'resolved', 'brand-new-sweeper', note);`,
    );
    expect(sites).toEqual([{ file: 'fixture.ts', state: 'resolved', by: 'brand-new-sweeper' }]);
    // The assertion the live test makes would fail on this site — which is what makes the
    // live green mean something.
    expect(classifyTerminalOwner('brand-new-sweeper')).toBe('agent');
  });

  it('does NOT flag a non-terminal state transition', () => {
    // `setIssueState(id, 'blocked', 'improvement-triage')` is not a close and must not be
    // dragged into the system registry — a false positive here would train the next reader
    // to widen the list until it stops meaning anything.
    expect(
      findLiteralByCloseSites('fixture.ts', `setIssueState(id, 'blocked', 'improvement-triage');`),
    ).toEqual([]);
  });

  it('does NOT flag the same call shape written inside a comment', () => {
    expect(
      findLiteralByCloseSites(
        'fixture.ts',
        [
          `// see setIssueState(id, 'resolved', 'documented-only') for the shape`,
          `/* setIssueState(id, 'resolved', 'block-comment-only') */`,
        ].join('\n'),
      ),
    ).toEqual([]);
  });
});
