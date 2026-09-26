import { describe, expect, it } from 'vitest';
import { classifyAmendmentAdditivity, isAdditiveValue } from './acceptance-bar-amendment-additivity';

type Criterion = Record<string, unknown>;
const barKeyOf = (criterion: Criterion) => String(criterion.barKey);
const bar = (barKey: string, extra: Criterion = {}): Criterion => ({ barKey, model: `${barKey} holds.`, ...extra });
const tests = (...files: string[]) => ({ kind: 'tests', files });

/** Diff the way the rubric loss guard does, so the classifier sees realistic `changes`. */
function classify(prior: Criterion[], next: Criterion[]) {
  const priorByKey = new Map(prior.map((c) => [barKeyOf(c), c]));
  const nextByKey = new Map(next.map((c) => [barKeyOf(c), c]));
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const changes: Array<{ barKey: string; kind: string; fields: string[] }> = [];
  for (const [key, before] of priorByKey) {
    const after = nextByKey.get(key);
    if (!after) { changes.push({ barKey: key, kind: 'removed', fields: ['bar'] }); continue; }
    const fields = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((f) => !same(before[f], after[f]));
    if (fields.length) changes.push({ barKey: key, kind: 'meaning', fields });
  }
  for (const key of nextByKey.keys()) if (!priorByKey.has(key)) changes.push({ barKey: key, kind: 'added', fields: ['bar'] });
  return classifyAmendmentAdditivity({ changes, prior, next, barKeyOf });
}

describe('started-BAR amendment additivity (D-002)', () => {
  describe('add-only amendments do not require approval', () => {
    it.each([
      ['adds a structured check where none existed', [bar('R-1')], [bar('R-1', { check: tests('a.test.ts'), barHash: 'h2' })]],
      ['adds required test layers where none existed', [bar('R-1')], [bar('R-1', { requiredTestLayers: ['unit'] })]],
      ['grows required test layers', [bar('R-1', { requiredTestLayers: ['unit'] })], [bar('R-1', { requiredTestLayers: ['unit', 'integration'] })]],
      ['adds a test file to an existing tests check', [bar('R-1', { check: tests('a.test.ts') })], [bar('R-1', { check: tests('a.test.ts', 'b.test.ts') })]],
      ['adds a check to one BAR and a layer to another', [bar('R-1'), bar('R-2', { requiredTestLayers: ['unit'] })], [bar('R-1', { check: tests('a.test.ts') }), bar('R-2', { requiredTestLayers: ['unit', 'e2e'] })]],
    ])('%s', (_label, prior, next) => {
      const result = classify(prior, next);
      expect(result.approvalRequired).toBe(false);
      expect(result.reviewedBars).toEqual([]);
      expect(result.additiveBars.length).toBeGreaterThan(0);
    });

    it('an amendment with no meaning change requires nothing', () => {
      expect(classify([bar('R-1')], [bar('R-1')])).toEqual({ approvalRequired: false, additiveBars: [], reviewedBars: [] });
    });
  });

  describe('removals and rewordings still require approval', () => {
    it.each([
      ['removes a BAR', [bar('R-1'), bar('R-2')], [bar('R-1')], 'R-2', 'BAR removed'],
      ['adds a whole new BAR', [bar('R-1')], [bar('R-1'), bar('R-2')], 'R-2', 'new BAR (new prose meaning)'],
      ['rewords the model prose', [bar('R-1')], [bar('R-1', { model: 'R-1 mostly holds.' })], 'R-1', 'model changed'],
      ['removes a check', [bar('R-1', { check: tests('a.test.ts') })], [bar('R-1')], 'R-1', 'check removed or changed, not only added to'],
      ['drops a test file from a check', [bar('R-1', { check: tests('a.test.ts', 'b.test.ts') })], [bar('R-1', { check: tests('a.test.ts') })], 'R-1', 'check removed or changed, not only added to'],
      ['changes the check kind', [bar('R-1', { check: tests('a.test.ts') })], [bar('R-1', { check: { kind: 'cargo', manifestPath: 'Cargo.toml' } })], 'R-1', 'check removed or changed, not only added to'],
      ['adds a narrowing key to an existing check', [bar('R-1', { check: tests('a.test.ts') })], [bar('R-1', { check: { ...tests('a.test.ts'), pattern: 'only this' } })], 'R-1', 'check removed or changed, not only added to'],
      ['removes a required test layer', [bar('R-1', { requiredTestLayers: ['unit', 'integration'] })], [bar('R-1', { requiredTestLayers: ['unit'] })], 'R-1', 'requiredTestLayers removed or changed, not only added to'],
      ['replaces a required test layer', [bar('R-1', { requiredTestLayers: ['unit'] })], [bar('R-1', { requiredTestLayers: ['integration'] })], 'R-1', 'requiredTestLayers removed or changed, not only added to'],
      ['changes another meaning field (evidence plane)', [bar('R-1', { evidencePlane: 'tree' })], [bar('R-1', { evidencePlane: 'live' })], 'R-1', 'evidencePlane changed'],
      ['moves only the derived hash', [bar('R-1', { barHash: 'h1' })], [bar('R-1', { barHash: 'h2' })], 'R-1', 'derived hash moved without a meaning field'],
    ])('%s', (_label, prior, next, barKey, reason) => {
      const result = classify(prior, next);
      expect(result.approvalRequired).toBe(true);
      expect(result.reviewedBars).toEqual([{ barKey, reason }]);
    });

    it('a rewording mixed with an added check on the SAME BAR still requires approval', () => {
      const result = classify([bar('R-1')], [bar('R-1', { model: 'R-1 holds, reworded.', check: tests('a.test.ts') })]);
      expect(result).toEqual({ approvalRequired: true, additiveBars: [], reviewedBars: [{ barKey: 'R-1', reason: 'model changed' }] });
    });

    it('a rewording on one BAR mixed with an added check on another still requires approval', () => {
      const result = classify(
        [bar('R-1'), bar('R-2')],
        [bar('R-1', { model: 'R-1 holds, reworded.' }), bar('R-2', { check: tests('a.test.ts') })],
      );
      expect(result).toEqual({
        approvalRequired: true,
        additiveBars: ['R-2'],
        reviewedBars: [{ barKey: 'R-1', reason: 'model changed' }],
      });
    });
  });

  it('isAdditiveValue: absent grows to anything; arrays only grow; scalars never change', () => {
    expect(isAdditiveValue(undefined, tests('a.test.ts'))).toBe(true);
    expect(isAdditiveValue([], ['unit'])).toBe(true);
    expect(isAdditiveValue(['unit'], ['integration', 'unit'])).toBe(true);
    expect(isAdditiveValue(['unit'], ['integration'])).toBe(false);
    expect(isAdditiveValue('tests', 'cargo')).toBe(false);
    expect(isAdditiveValue(tests('a.test.ts'), undefined)).toBe(false);
  });
});
