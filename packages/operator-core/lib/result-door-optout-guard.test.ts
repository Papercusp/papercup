/**
 * Guard test for `lint:no-new-result-door-optout`
 * (scripts/check-result-door-optouts.mjs).
 *
 * EI-20244970883634313 asked for two things: the structural collapser in the shared
 * result door, AND a mandatory lint on the opt-out path. The collapser shipped under
 * WI-38402; the lint is the other half, and this is its test.
 *
 * ## Falsifiability is proven WITHOUT mutating the tree
 *
 * The controls below are permanent, deliberately-wrong sources fed to the guard's own
 * exported detector. That is tier 1 of this repo's mutation-probe ladder, and it is the
 * right tier here precisely because the subject is an importable module: a probe that
 * edited a real file to prove the guard bites would race git-sync, which sweeps the whole
 * working tree into a commit every few minutes and would happily commit the mutant.
 *
 * The negative controls carry the weight. A detector for `skipResultDoor:` is trivially
 * easy to write in a form that also matches its own documentation, the type declaration,
 * and the consumers that merely READ the field — and every one of those false positives
 * would land as a red gate on a file whose author did nothing wrong.
 */
import { describe, expect, it } from 'vitest';

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-expect-error -- plain-JS guard script, intentionally untyped
import { findOptOuts, scanTree } from '../../../scripts/check-result-door-optouts.mjs';

describe('lint:no-new-result-door-optout — repo-wide enforcement', () => {
  it('reports no new result-door opt-outs across the tree', () => {
    const { violations } = scanTree();
    expect(
      violations,
      `New skipResultDoor opt-out(s) found:\n${violations
        .map((v: { rel: string; line: number; reason: string }) => `  ${v.rel}:${v.line}  ${v.reason}`)
        .join('\n')}\n\nSee scripts/check-result-door-optouts.mjs for why an opt-out needs a decision.`,
    ).toEqual([]);
  });

  it('has no stale baseline entries', () => {
    // A stale entry is not cosmetic: BASELINE is shrink-only, so a path that no
    // longer declares an opt-out silently PERMITS a future one at that same path.
    const { stale } = scanTree();
    expect(
      stale,
      `Baseline entries that no longer declare an opt-out — remove them from BASELINE ` +
        `in scripts/check-result-door-optouts.mjs:\n${stale.map((f: string) => `  ${f}`).join('\n')}`,
    ).toEqual([]);
  });

  it('measures a non-empty population, so an empty violations list means something', () => {
    // The calibration case. Without it, every assertion above also passes when the
    // detector is broken and matches nothing at all — the vacuous green this repo
    // documents as its most common false verdict.
    const { every, seen } = scanTree();
    expect(every.length).toBeGreaterThanOrEqual(10);
    expect(seen.size).toBeGreaterThanOrEqual(10);
  });
});

describe('detector — positive controls (the guard must BITE)', () => {
  it('detects a single-quoted opt-out', () => {
    const hits = findOptOuts(`export const tool = {\n  name: 'x',\n  skipResultDoor: 'oversize-by-design',\n};\n`);
    expect(hits).toHaveLength(1);
    expect(hits[0].reason).toBe('oversize-by-design');
    expect(hits[0].line).toBe(3);
  });

  it('detects a double-quoted opt-out', () => {
    const hits = findOptOuts(`const t = { skipResultDoor: "programmatic-caller" };`);
    expect(hits).toHaveLength(1);
    expect(hits[0].reason).toBe('programmatic-caller');
  });

  it('detects an opt-out written with unusual spacing', () => {
    const hits = findOptOuts(`const t = { skipResultDoor   :    'oversize-by-design' };`);
    expect(hits).toHaveLength(1);
  });

  it('detects several opt-outs in one file', () => {
    const hits = findOptOuts(
      `const a = { skipResultDoor: 'oversize-by-design' };\nconst b = { skipResultDoor: 'programmatic-caller' };\n`,
    );
    expect(hits.map((h: { reason: string }) => h.reason)).toEqual([
      'oversize-by-design',
      'programmatic-caller',
    ]);
  });

  it('detects a reason outside the known set, rather than silently ignoring it', () => {
    // The guard governs POPULATION, not vocabulary — tsc already enforces the
    // ResultDoorSkipReason union. A guard that only matched the two known reasons
    // would go blind exactly when someone widens the type.
    const hits = findOptOuts(`const t = { skipResultDoor: 'some-future-reason' };`);
    expect(hits).toHaveLength(1);
    expect(hits[0].reason).toBe('some-future-reason');
  });
});

describe('detector — negative controls (the guard must NOT fire)', () => {
  it('ignores the shape inside a line comment', () => {
    // This is not hypothetical. orient-core-result-door-priority.test.ts:102 already
    // documents the shape in prose, and the guard script's own header does too. The
    // model guard for this script (check-no-hand-rolled-module-pin) was red-pinned by
    // exactly this — a rule's documentation reddening its own gate (WI-37717).
    expect(findOptOuts(`// it declares skipResultDoor: 'oversize-by-design' for bulk reads\nconst t = {};`)).toEqual([]);
  });

  it('ignores the shape inside a block comment', () => {
    expect(
      findOptOuts(`/**\n * Tools opt out with skipResultDoor: 'programmatic-caller'.\n */\nconst t = {};`),
    ).toEqual([]);
  });

  it('ignores the TYPE declaration', () => {
    // libs/generic/tooldef/src/types.ts declares the field at 4 sites; none is an opt-out.
    expect(findOptOuts(`interface ToolDefinition {\n  skipResultDoor?: ResultDoorSkipReason;\n}`)).toEqual([]);
  });

  it('ignores a function parameter typed with the reason union', () => {
    // store-identity-suspect.ts:61 has exactly this signature.
    expect(
      findOptOuts(`export function mayAnnotateResultText(skipResultDoor: ResultDoorSkipReason | undefined) {\n  return skipResultDoor !== 'programmatic-caller';\n}`),
    ).toEqual([]);
  });

  it('ignores consumers that READ the field', () => {
    // _mcp-handler.ts reads it to decide whether to run the door. Reading is not opting out.
    expect(
      findOptOuts(`const skip = projected.skipResultDoor ?? nestedResultDoorSkipReason(viewed);\nif (target.skipResultDoor) return raw;`),
    ).toEqual([]);
  });

  it('ignores an unrelated file entirely', () => {
    expect(findOptOuts(`export const answer = 42;`)).toEqual([]);
  });
});
