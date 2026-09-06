import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import amendTool, { rubricsAmendArgs } from './amend';

const criterion = {
  key: 'r-1',
  title: 'Outcome one',
  model: 'Outcome one remains true.',
  bar: 'Outcome one remains true.',
  method: 'Run the focused test.',
  driftMarkers: 'The focused test fails.',
  barKey: 'R-1',
  role: 'outcome' as const,
  mandatory: true,
  requiredScope: ['tree'],
  evidencePlane: 'tree' as const,
  passRatings: ['healthy'],
  check: { kind: 'tests' as const, files: ['packages/operator-core/lib/acceptance-bar-amendment.test.ts'] },
};

describe('rubrics:amend complete acceptance criteria input', () => {
  it('keeps the complete tool schema JSON-Schema-representable', () => {
    expect(() => z.toJSONSchema(amendTool.args as never)).not.toThrow();
  });

  it('accepts a full criterion set with structured checks', () => {
    const parsed = rubricsAmendArgs.safeParse({
      rubricRef: 'acceptance-example',
      criteria: [criterion],
      reason: 'Bind the runnable acceptance check.',
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.criteria?.[0]?.bar).toBe(criterion.bar);
  });

  it('allows passRatings: [] for disclosure criteria and rejects the same shape for outcomes', () => {
    const disclosure = {
      ...criterion,
      role: 'disclosure' as const,
      mandatory: false,
      passRatings: [],
      coversBarKeys: ['R-1'],
    };
    expect(
      rubricsAmendArgs.safeParse({
        rubricRef: 'acceptance-example',
        criteria: [disclosure],
      }).success,
    ).toBe(true);
    expect(
      rubricsAmendArgs.safeParse({
        rubricRef: 'acceptance-example',
        requirement: { key: 'r-1', acceptance: { role: 'disclosure', passRatings: [] } },
      }).success,
    ).toBe(true);

    const invalid = rubricsAmendArgs.safeParse({
      rubricRef: 'acceptance-example',
      criteria: [{ ...disclosure, role: 'outcome', mandatory: true }],
    });
    expect(invalid.success).toBe(false);
    if (!invalid.success) {
      expect(invalid.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: ['criteria', 0, 'passRatings'],
            message: expect.stringContaining("role:'disclosure'"),
          }),
        ]),
      );
    }

    const invalidDisclosure = rubricsAmendArgs.safeParse({
      rubricRef: 'acceptance-example',
      criteria: [{ ...disclosure, passRatings: ['healthy'] }],
    });
    expect(invalidDisclosure.success).toBe(false);
    if (!invalidDisclosure.success) {
      expect(invalidDisclosure.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: ['criteria', 0, 'passRatings'],
            message: expect.stringContaining('must be empty'),
          }),
        ]),
      );
    }
  });

  it('retains a missing-class binding without requiring replacement criteria', () => {
    const parsed = rubricsAmendArgs.parse({
      rubricRef: 'acceptance-example',
      classRef: ' plan-class-investigation ',
    });
    expect(parsed.classRef).toBe('plan-class-investigation');
    expect(parsed.criteria).toBeUndefined();
    expect(rubricsAmendArgs.safeParse({ rubricRef: 'acceptance-example', classRef: '  ' }).success).toBe(false);
  });

  it('refuses an ambiguous full-set plus single-criterion patch', () => {
    const parsed = rubricsAmendArgs.safeParse({
      rubricRef: 'acceptance-example',
      criteria: [criterion],
      criterion: { key: 'r-1', field: 'method', mode: 'append', text: 'Also inspect the log.' },
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: ['criteria'], message: expect.stringContaining('cannot be combined') }),
        ]),
      );
    }
  });
});
