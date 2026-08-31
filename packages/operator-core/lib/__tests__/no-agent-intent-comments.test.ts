/**
 * Tests for the agent-intent-comment guard (scripts/check-no-agent-intent-comments.mjs
 * + scripts/lib/agent-intent-comment-patterns.mjs, EI-19324979765038953).
 *
 * WHAT IS ACTUALLY WORTH TESTING HERE
 * A guard against "comment names an agent + a pending action" is trivially easy to
 * write in a form that is USELESS in both directions, and both failures are silent:
 *
 *   - Too NARROW and it reports a confident green over a tree that still contains the
 *     exact incident shape. The first draft of this rule did precisely that: it
 *     required `is|will` immediately before a verb from a fixed list, found ZERO hits,
 *     and would have shipped as "baseline empty ✓" while eight real instances sat in
 *     the tree — including `su-0e44e) will switch the claim ...`, whose promise had
 *     already gone stale (the flag it names LANDED; the comment still says it is being
 *     added).
 *   - Too BROAD and it fires on the 688 comment lines across 390 files that cite an
 *     agent id as sound history — at which point someone switches the rule off, which
 *     is worse than never having written it.
 *
 * So the load-bearing assertions are the NEGATIVE CONTROLS. Every one below is a
 * VERBATIM line from this repo that a plausible implementation of this rule flags and
 * must not: they are the five false positives the census actually produced, each
 * traced to a specific regex defect, kept here permanently so a future "simplification"
 * of the matcher cannot quietly reintroduce them.
 *
 * The fixtures are deliberately real rather than invented. An invented fixture proves
 * the matcher matches what its author already had in mind; these prove it against the
 * corpus that broke it.
 */
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../../..');
const scriptPath = resolve(repoRoot, 'scripts/check-no-agent-intent-comments.mjs');
const patternsPath = resolve(repoRoot, 'scripts/lib/agent-intent-comment-patterns.mjs');

const { findAgentIntentComments, isSkippedPath } = (await import(patternsPath)) as {
  findAgentIntentComments: (text: string) => { line: number; id: string; text: string }[];
  isSkippedPath: (file: string) => boolean;
};

const fires = (text: string) => findAgentIntentComments(text).length > 0;

describe('agent-intent comment detector — positive controls', () => {
  it('flags the incident comment that froze the gate', () => {
    // The original, verbatim: a dead sync-resolver entry survived for hours because
    // this read as "owned and in flight" to every later reader.
    expect(
      fires('// su-37bf2 is DELETING this entry under P-025 ... so that deletion,\n'),
    ).toBe(true);
  });

  it('flags a FUTURE promise attributed to a session', () => {
    expect(fires('// su-0e44e) will switch the claim from the inline `NOT EXISTS` predicate')).toBe(
      true,
    );
  });

  it('flags present-tense ownership, bare and parenthesised', () => {
    expect(fires(' * Port (P-019 / BRIEF 2, su-1226c owns the impl): spin a harness')).toBe(true);
    expect(fires(' *   - su-ed300 owns the CRYPTO FOUNDATION = the real implementation')).toBe(true);
    expect(fires(' * (su-584a8 owns it), so we fall back to the stable per-session ownerId')).toBe(
      true,
    );
  });

  it('flags the progressive form in every comment syntax this tree uses', () => {
    expect(fires('// su-abcde is removing the shim')).toBe(true);
    expect(fires(' * su-abcde is removing the shim')).toBe(true);
    expect(fires('# su-abcde is removing the shim')).toBe(true);
  });
});

describe('agent-intent comment detector — negative controls (the expensive half)', () => {
  it('does NOT flag past-tense attribution where the id is the object of `by`', () => {
    // REAL, table-registry.ts:280. The trailing infinitive is the PURPOSE of a
    // COMPLETED act, not a pending one. A proximity-only matcher flags this.
    expect(
      fires('  // [Registry entry added by su-16e4c to green the capture-coverage /'),
    ).toBe(false);
  });

  it('does NOT flag a claim the author already framed as of-its-time', () => {
    // REAL, peer-dial-registry.ts:12 — the exact discipline the fix hint teaches.
    // A rule that fires on its own remedy trains people to ignore it.
    expect(
      fires(" * (P-201, su-164d8's lane, mid-fix at the time this was written) is a stable"),
    ).toBe(false);
  });

  it('does NOT flag a dated observation', () => {
    // REAL, shape from the corpus: a date hands the reader the age of the claim,
    // which is the whole defect being policed.
    expect(
      fires(' * su-1f7ee244, 2026-08-08): a session registered in auto mode, bound to'),
    ).toBe(false);
  });

  it('does NOT read the possessive `\'s` as a verb', () => {
    // REAL, hive-members.integration.test.ts:6. With a loose `s?` in the connector the
    // engine split "su-02ae39's wiring" into `'` + `s wiring` and matched the
    // possessive itself as the predicate.
    expect(
      fires(" * register-all (write side) is su-02ae39's wiring; this proves the read side +"),
    ).toBe(false);
  });

  it('does NOT read the adjective "own" as the verb "owns"', () => {
    // REAL, constant-conditional.test.ts:67 and loop.test.ts:1238. `owns?` matched the
    // bare adjective, turning two plain history notes into findings.
    expect(
      fires("// su-3a5df's own advice after the incident: gate on a named const, never a"),
    ).toBe(false);
    expect(
      fires('// THE DEFECT. These are the real numbers measured on su-7854d874\'s own loop'),
    ).toBe(false);
  });

  it('does NOT flag prose ABOUT an id rather than a claim BY one', () => {
    // REAL, owner-facing-text.ts:9. Bare `is` made any sentence containing an id a hit.
    expect(
      fires(' * su-12b70e95-84ce-4ea0-b546-8a692cdc949c" is exactly what an operator needs.'),
    ).toBe(false);
  });

  it('does NOT flag a JSDoc documenting the FORMAT of such a string', () => {
    // REAL, coupled-topics.ts:89. A rule that cannot let a doc spell its own subject
    // is unusable — same precedent as PLACEHOLDER_NAMES in identity-leak-patterns.
    expect(
      fires('/** Human-readable signal, e.g. "su-abc12 is working WI-6386, tagged gate-dx". */'),
    ).toBe(false);
  });

  it('does NOT flag ordinary prose or CODE that merely mentions a session id', () => {
    expect(fires('const ownerId = "su-3b0568df";')).toBe(false);
    expect(fires('// filed by su-4ca244e4 after the incident')).toBe(false);
    expect(fires('// su-0efdd444 held WI-4445 open, then vanished')).toBe(false);
  });

  it('skips its own two definition files, which must spell the forbidden shape', () => {
    expect(isSkippedPath('scripts/lib/agent-intent-comment-patterns.mjs')).toBe(true);
    expect(isSkippedPath('scripts/check-no-agent-intent-comments.mjs')).toBe(true);
    expect(isSkippedPath('packages/operator-core/lib/__tests__/no-agent-intent-comments.test.ts')).toBe(
      true,
    );
    expect(isSkippedPath('packages/operator-core/lib/scout/types.ts')).toBe(false);
  });
});

describe('the guard over the REAL tree', () => {
  // This is also what makes the rule BLOCKING: check-lint-guard-reachability.mjs
  // classifies a `lint:*` script executed over the real tree by a *.test.ts as
  // reachable at `test` tier. Without this it would be an unwired guard, which that
  // meta-guard exists to fail — and which rots into false positives unnoticed.
  it('has an EMPTY baseline: the whole tree is clean', () => {
    const run = spawnSync(process.execPath, [scriptPath], {
      cwd: repoRoot,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      timeout: 120_000,
      killSignal: 'SIGKILL',
    });
    expect(run.stderr ?? '').not.toMatch(/Error|Cannot find/i);
    expect(`${run.stdout}${run.stderr}`).toMatch(/0 findings/);
    expect(run.status).toBe(0);
  });

  it('scans a non-trivial number of files (a green over zero files is not a green)', () => {
    const run = spawnSync(process.execPath, [scriptPath, '--census'], {
      cwd: repoRoot,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      timeout: 120_000,
      killSignal: 'SIGKILL',
    });
    const scanned = Number(/scanned (\d+) files/.exec(run.stdout ?? '')?.[1] ?? 0);
    expect(scanned).toBeGreaterThan(5000);
  });
});
