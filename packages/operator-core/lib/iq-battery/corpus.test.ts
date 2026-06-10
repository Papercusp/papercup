/**
 * Corpus shape guards (audit P-014 / EI-162).
 *
 * The `fix-injected-bug` variant has NO injection step — a case must be
 * self-contained: the buggy code ships inside the prompt, and groundTruth
 * points at that snippet. These guards keep the corpus honest so a bee is
 * never again briefed to "fix" a bug at a repo location that does not exist
 * (three independent bees burned turns confirming `rankItems` was fiction).
 */

import { describe, expect, it } from 'vitest';

import {
  AllCases,
  FixInjectedBugCases,
  getCasesByVariant,
  RubricSchema,
  TaskVariant,
} from './corpus';

describe('corpus seed data', () => {
  it('ships 20 cases, 5 per variant', () => {
    expect(AllCases.length).toBe(20);
    for (const variant of TaskVariant.options) {
      expect(getCasesByVariant(variant).length).toBe(5);
    }
  });

  it('every rubric parses and its dimension weights sum to 1', () => {
    for (const c of AllCases) {
      const rubric = RubricSchema.parse(c.rubric);
      const total = rubric.dimensions.reduce((s, d) => s + d.weight, 0);
      expect(total, `rubric weights of '${c.title}'`).toBeCloseTo(1, 5);
    }
  });
});

describe('fix-injected-bug cases are self-contained (EI-162)', () => {
  it('every prompt carries the buggy code as a fenced snippet', () => {
    for (const c of FixInjectedBugCases) {
      expect(c.prompt, `'${c.title}' must embed its buggy code`).toMatch(/```ts\n[\s\S]+```/);
    }
  });

  it('groundTruth.bugLocation references the prompt snippet, never a repo path', () => {
    for (const c of FixInjectedBugCases) {
      const loc = c.groundTruth.bugLocation;
      expect(loc, `'${c.title}' bugLocation`).toMatch(/^snippet:/);
      // The regression that motivated this file: locations like
      // 'packages/operator-core/lib/work-items.ts:rankItems' pointing at
      // symbols that exist nowhere in the tree.
      expect(loc).not.toMatch(/^packages\//);
      expect(loc).not.toMatch(/\.ts:/);
    }
  });

  it('the symbol named in bugLocation appears in its own prompt snippet', () => {
    for (const c of FixInjectedBugCases) {
      const symbol = c.groundTruth.bugLocation.replace(/^snippet:/, '').split('.').pop()!;
      expect(c.prompt, `'${c.title}' prompt must define ${symbol}`).toContain(symbol);
    }
  });
});
