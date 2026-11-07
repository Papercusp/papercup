import { describe, expect, it } from 'vitest';
import getRubricTool, { summaryRubric } from './get';
import type { Rubric } from '../../rubrics';

describe('rubrics:get workspace transaction boundary', () => {
  it('does not retain an ambient workspace transaction during its independent reads', () => {
    expect((getRubricTool as unknown as { skipWorkspaceTx?: boolean }).skipWorkspaceTx).toBe(true);
  });

  it('distinguishes manual and typed checks in the compact definition with pinned full-procedure recovery', () => {
    const rubric = { rubricId: 'readiness-fixture', revision: 7, criteriaHash: 'pinned-hash', methodRef: null,
      criteria: [
        { key: 'manual', title: 'Manual', method: 'Read the signed review.', replication: 'Retain the reviewer sources.', instrumentKey: 'none' },
        { key: 'typed', title: 'Typed', method: 'Literal $(never-execute) '.repeat(40), check: { kind: 'tests', files: ['fixture.test.ts'] } },
        { key: 'legacy', title: 'Legacy', method: '' },
      ] } as Rubric;
    const before = JSON.stringify(rubric);
    const rows = summaryRubric(rubric).criteria;
    expect(rows.map(row => row.evidenceReadiness)).toEqual(['manual', 'typed-check', 'manual']);
    expect(rows[0]!.procedureExcerpt).toBe('Read the signed review.\nRetain the reviewer sources.');
    expect(rows[1]!.procedureExcerpt).toHaveLength(240);
    expect(rows[2]!.missingSpecificity).toBe(true);
    expect(rows[1]!.definitionRead).toEqual({ tool: 'rubrics:get', args: {
      rubricRef: 'readiness-fixture', revision: 7, detail: 'full',
    } });
    expect(JSON.stringify(rubric)).toBe(before);
  });
});
