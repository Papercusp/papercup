import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  assertRubricRatingVocabulary,
  extractRubricRatingInstructions,
  validateRubricRatingVocabulary,
} from './rubric-rating-vocabulary';
import { proposeRubric, type ProposeRubricCriterion } from './rubrics';

const criterion = (over: Partial<ProposeRubricCriterion> & { key: string }): ProposeRubricCriterion => {
  const { key, title, model, method, driftMarkers, ...rest } = over;
  return {
    key,
    title: title ?? `Criterion ${key}`,
    model: model ?? 'How it should work.',
    method: method ?? 'How to investigate it.',
    driftMarkers: driftMarkers ?? 'What failure looks like.',
    ...rest,
  };
};

describe('rubric rating-vocabulary validation (WI-835208)', () => {
  it('extracts only explicit grade/rate instructions, not ordinary state prose', () => {
    const instructions = extractRubricRatingInstructions(
      'c1',
      'method',
      'The observed state may be partial. Grade `broken` if the probe fails. ' +
        'The rate limit response is recorded separately.',
    );

    expect(instructions).toHaveLength(1);
    expect(instructions[0]).toMatchObject({
      criterionKey: 'c1',
      field: 'method',
      rating: 'broken',
    });
  });

  it('finds quoted and unquoted explicit directives while ignoring ambiguous prose', () => {
    const result = validateRubricRatingVocabulary(
      [
        criterion({
          key: 'c1',
          method: 'Grade fail if the check fails.',
          replication: 'rate `partial` when only some consumers comply.',
        }),
        criterion({
          key: 'c2',
          method: 'A partial result is possible; use the evidence to decide.',
          replication: 'Discuss the rate limit behavior without prescribing a grade.',
        }),
      ],
      ['pass', 'partial', 'fail', 'unknown'],
    );

    expect(result.ok).toBe(true);
    expect(result.instructions.map((instruction) => instruction.rating)).toEqual(['fail', 'partial']);
    expect(result.violations).toEqual([]);
  });

  it('ignores contextual objects and compound labels that are not rating values', () => {
    const instructions = extractRubricRatingInstructions(
      'context',
      'method',
      'For leadership, grade it on observed claim counts. Verify GOAL+GRADE mode for the holder.',
    );

    expect(instructions).toEqual([]);
  });

  it('ignores numbered GRADE headings and rate-of noun phrases without hiding a real directive', () => {
    const instructions = extractRubricRatingInstructions(
      'procedure-prose',
      'method',
      '(5) GRADE: JUDGED, anchored to the recorded seed locations. ' +
        "Compare the polling cadence with the signal's rate of change. Grade fail if the probe disagrees.",
    );

    expect(instructions.map((instruction) => instruction.rating)).toEqual(['fail']);
  });

  it('accepts the complete shipped su-agent-behavior rubric vocabulary', () => {
    const rubric = JSON.parse(
      readFileSync(new URL('../../../rubrics/su-agent-behavior/rubric.json', import.meta.url), 'utf8'),
    ) as {
      criteria: ProposeRubricCriterion[];
      ratingScale: string[];
    };

    const result = validateRubricRatingVocabulary(rubric.criteria, rubric.ratingScale);
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it('ignores directive words inside SQL/code literals without hiding real rating instructions', () => {
    const result = validateRubricRatingVocabulary(
      [
        criterion({
          key: 'grade-vs-test-split',
          replication:
            "Query modes with mode IN ('grade','test') and inspect the `rating` column. " +
            "Grade 'healthy' when the two populations remain separate.",
        }),
      ],
      ['healthy', 'degraded', 'broken', 'unknown'],
    );

    expect(result.ok).toBe(true);
    expect(result.instructions.map((instruction) => instruction.rating)).toEqual(['healthy']);
    expect(result.violations).toEqual([]);
  });

  it.each([
    ['"', '"'],
    ["'", "'"],
    ['`', '`'],
    ['“', '”'],
  ])('ignores quoted test titles between %s and %s while retaining explicit ratings', (open, close) => {
    const cite = (title: string) => `${open}${title}${close}`;
    const result = validateRubricRatingVocabulary(
      [
        criterion({
          key: 'test-citations',
          method:
            'Run tests ' +
            cite('leaves a sound all-accept batch unflagged solely for its acceptance rate') +
            '; ' +
            cite('labels a capped scan without inventing a zero error rate') +
            ' and inspect their assertions. Grade healthy when they pass. Grade partial if evidence is missing.',
        }),
      ],
      ['healthy', 'degraded', 'broken', 'unknown'],
    );

    expect(result.instructions.map((instruction) => instruction.rating)).toEqual(['healthy', 'partial']);
    expect(result.violations.map((violation) => violation.rating)).toEqual(['partial']);
  });

  it('ignores directives inside escaped citation text and nested code strings', () => {
    const method =
      String.raw`Run "retains a \"partial\" rating when quoted" and inspect ` +
      '`const example = "Grade partial if missing"`' +
      '. Grade broken if the actual probe fails.';

    expect(
      extractRubricRatingInstructions('escaped-citations', 'method', method).map((instruction) => instruction.rating),
    ).toEqual(['broken']);
  });

  it('does not hide real directives after apostrophes or unmatched quotes', () => {
    const method =
      "The operator's evidence isn't optional. Grade partial if it is missing. " +
      'An unmatched " citation must not hide this: Grade broken if the probe fails.';

    expect(
      extractRubricRatingInstructions('unbalanced-citations', 'method', method).map(
        (instruction) => instruction.rating,
      ),
    ).toEqual(['partial', 'broken']);
  });

  it('uses a criterion ratingScale override instead of the rubric default', () => {
    const result = validateRubricRatingVocabulary(
      [
        criterion({
          key: 'override',
          ratingScale: ['pass', 'partial', 'fail'],
          method: 'Grade `partial` if the partial path is observed.',
        }),
        criterion({
          key: 'default',
          method: 'Grade `partial` if the partial path is observed.',
        }),
      ],
      ['healthy', 'degraded', 'broken', 'unknown'],
    );

    expect(result.ok).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toMatchObject({
      criterionKey: 'default',
      field: 'method',
      rating: 'partial',
      allowedRatings: ['healthy', 'degraded', 'broken', 'unknown'],
    });
  });

  it('matches rating labels case-insensitively', () => {
    expect(
      validateRubricRatingVocabulary(
        [criterion({ key: 'c1', method: 'GRADE HEALTHY IF the probe passes.' })],
        ['healthy', 'degraded', 'broken', 'unknown'],
      ).ok,
    ).toBe(true);
  });

  it('assertion names the criterion, field, offending value, and effective scale', () => {
    expect(() =>
      assertRubricRatingVocabulary(
        [criterion({ key: 'c2', replication: 'Grade `partial` if a consumer re-projects its own view.' })],
        ['healthy', 'degraded', 'broken', 'unknown'],
        { rubricId: 'acceptance-rubric' },
      ),
    ).toThrow(
      /rubric 'acceptance-rubric'.*criterion 'c2' replication.*'partial'.*healthy \| degraded \| broken \| unknown/,
    );
  });

  it('rubrics:propose rejects an off-scale explicit instruction before any store access', async () => {
    await expect(
      proposeRubric({
        rubricId: 'rating-vocabulary-wiring',
        characteristic: 'rating-vocabulary',
        title: 'Rating vocabulary wiring',
        criteria: [
          criterion({
            key: 'c1',
            method: 'Grade `partial` if the check is only partially satisfied.',
          }),
        ],
        ratingScale: ['healthy', 'degraded', 'broken', 'unknown'],
      }),
    ).rejects.toThrow(/off-scale rating instructions.*partial/);
  });
});
