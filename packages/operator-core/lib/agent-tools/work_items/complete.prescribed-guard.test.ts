/**
 * EI-20288629053504794 — prescribed recurrence-guard/test detector.
 *
 * This suite pins the obligation detector in both directions and verifies the
 * warning is wired into work_items:complete. A source-only wiring check is
 * intentional: a perfect pure predicate that is never called is still absent
 * from the product.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import * as nodePath from 'node:path';

import { prescribedRecurrenceGuardCoverageGap } from './complete';

const item = {
  title: 'Completion integrity',
  summary: 'Proposed durable fix: add a recurrence guard asserting no refusal string survives.',
};

describe('prescribedRecurrenceGuardCoverageGap', () => {
  it('fires when the item prescribes a guard and completion only reports ordinary tests', () => {
    const result = prescribedRecurrenceGuardCoverageGap(item, {
      summary: 'focused suite passed',
      testsRun: 'complete.test.ts',
      testResult: '55/55 passed',
      filesChanged: ['packages/operator-core/lib/complete.ts'],
    });

    expect(result?.prescriptions).toHaveLength(1);
    expect(result?.prescriptions[0]).toContain('add a recurrence guard');
  });

  it('stays silent when completion points to the guard and its focused test', () => {
    expect(
      prescribedRecurrenceGuardCoverageGap(item, {
        summary: 'Added the recurrence guard and regression test.',
        addedTests: true,
        filesChanged: ['packages/operator-core/lib/complete.prescribed-guard.test.ts'],
        testsRun: 'focused recurrence guard suite',
        testResult: '6/6 passed',
      }),
    ).toBeUndefined();
  });

  it('accepts an explicit waiver with a reason', () => {
    expect(
      prescribedRecurrenceGuardCoverageGap(item, {
        summary: 'Waived the recurrence guard because an existing assertion covers it.',
        testsRun: 'existing assertion suite',
        testResult: 'green',
      }),
    ).toBeUndefined();
  });

  it('does not warn for an item with no prescribed guard or added-test obligation', () => {
    expect(
      prescribedRecurrenceGuardCoverageGap(
        { title: 'Routine bug fix', summary: 'Update the null check and run the existing tests.' },
        { summary: 'fixed the null check', testsRun: 'existing suite', testResult: 'green' },
      ),
    ).toBeUndefined();
  });

  it('fails open for malformed item data and warns on an explicit missing guard', () => {
    expect(prescribedRecurrenceGuardCoverageGap({ title: null, summary: 42 }, null)).toBeUndefined();
    expect(
      prescribedRecurrenceGuardCoverageGap(
        { summary: 'Add a regression guard.' },
        { summary: 'guard was not added because the source is unavailable' },
      ),
    ).toBeDefined();
  });
});

describe('complete.ts wiring', () => {
  const source = readFileSync(nodePath.join(__dirname, 'complete.ts'), 'utf8');

  it('computes the detector from the fetched item and raw completion', () => {
    expect(source).toMatch(/prescribedRecurrenceGuardCoverageGap\(\s*existing,\s*it\.completion\s*\)/);
  });

  it('returns the warning instead of silently discarding the detector result', () => {
    expect(source).toMatch(/\.\.\.\(prescribedGuardWarning \? \{ prescribedGuardWarning \} : \{\}\)/);
  });
});
