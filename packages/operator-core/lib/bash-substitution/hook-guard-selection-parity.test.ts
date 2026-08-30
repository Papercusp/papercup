/**
 * The two hook pre-filter guards must SHARE their fixture selection.
 *
 * D-005 duplicates the pre-filter itself, once per hook path, because each hook
 * must run it with no imports. That duplication is deliberate and confined to
 * the HOOKS. Their TESTS are free to share code — and until EI-18699117901393768
 * they did not: the same selection block sat inline and byte-identical in both
 * guard files, so adding a pair whose verdict changed what the guard covers
 * required the same edit twice with nothing pointing at the second site. The
 * reporter fixed the OMP one, saw it green, and found the cc mirror only by
 * choosing to run a different suite — where it failed for the reason just fixed.
 *
 * `selectEnforceableFixtures` removed that duplication. This guard stops it
 * coming back: re-inlining the selection in either file turns this red.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// bash-substitution → lib → operator-core → packages → repo root (four).
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

const HOOK_GUARD_TESTS = [
  'apps/operator/scripts/hooks/omp/__tests__/coord-hook.test.ts',
  'apps/operator/scripts/hooks/cc/__tests__/bash-resource-gate.test.ts',
];

/**
 * A re-inlined selection reads the verdict off the pair, so `expectedVerdict !==`
 * appearing in a guard file means the selection was hand-rolled again instead of
 * imported.
 *
 * Keying on `not-a-substitute` instead would be wrong: both files legitimately
 * NAME that verdict in prose explaining why those pairs are excluded, so such a
 * detector would fire on a correct file. The calibration case below pins that
 * distinction, because a detector that cannot be shown to separate the two is
 * not yet known to work.
 */
const reInlinesSelection = (source: string): boolean => /expectedVerdict\s*!==/.test(source);

describe('hook pre-filter guards share one fixture selection (EI-18699117901393768)', () => {
  it('the detector separates a re-inlined selection from prose that merely names the verdict', () => {
    expect(
      reInlinesSelection(
        `const enforceable = new Set(BASH_GATE_PAIRS.filter((p) => p.expectedVerdict !== 'not-a-substitute'));`,
      ),
      'a genuinely re-inlined selection must be caught',
    ).toBe(true);

    expect(
      reInlinesSelection('// A `not-a-substitute` pair is dropped unconditionally per D-007.'),
      'prose naming the verdict must NOT be flagged',
    ).toBe(false);
  });

  it.each(HOOK_GUARD_TESTS)('%s imports the shared selection and does not re-inline it', (rel) => {
    // readFileSync throws if the path moved, so this guard fails loudly rather
    // than silently passing over a file it can no longer find.
    const source = readFileSync(resolve(REPO_ROOT, rel), 'utf8');

    expect(source, 'guard must import the shared selection').toContain(
      'selectEnforceableFixtures',
    );
    expect(
      reInlinesSelection(source),
      'fixture selection was re-inlined here — import selectEnforceableFixtures from bash-substitution/corpus instead, so the two hook guards cannot drift',
    ).toBe(false);
  });
});
