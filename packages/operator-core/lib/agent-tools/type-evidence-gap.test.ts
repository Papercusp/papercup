import { describe, expect, it } from 'vitest';
import { typeEvidenceGapInCompletion } from './type-evidence-gap';
import { typeEvidenceWarningForPlanItem } from './plans/set-status';

describe('type-evidence advisory shared by terminal surfaces', () => {
  it('detects a unit-verified TypeScript close with no typecheck', () => {
    expect(
      typeEvidenceGapInCompletion({
        verifiedHow: 'unit',
        filesChanged: ['packages/operator-core/lib/example.ts'],
        testsRun: 'npm run test:file -- example.test.ts',
        testResult: '8 passed / 0 failed',
      }),
    ).toEqual({ tsFiles: ['packages/operator-core/lib/example.ts'] });
  });

  it('stays silent when the evidence already cites a typecheck', () => {
    expect(
      typeEvidenceGapInCompletion({
        verifiedHow: 'unit',
        filesChanged: ['example.ts'],
        testsRun: 'npm run lint:tsc -- --files=example.ts; vitest',
        testResult: 'tsc clean; 8 passed',
      }),
    ).toBeUndefined();
  });

  it('stays silent when the evidence cites a scoped TypeScript check', () => {
    expect(
      typeEvidenceGapInCompletion({
        verifiedHow: 'unit',
        filesChanged: ['example.ts'],
        testsRun: 'scoped TypeScript check',
        testResult: 'LINT_TSC_RESULT scope=files exit=0 status=clean',
      }),
    ).toBeUndefined();
  });

  it('warns when a done plan-item flip omits verification evidence', () => {
    expect(
      typeEvidenceWarningForPlanItem({
        ref: 'plan-a#P-001',
        oldStatus: 'wip',
        newStatus: 'done',
      }),
    ).toMatch(/without structured verification evidence/);
  });

  it('reuses the same gap check for unit-only TypeScript evidence', () => {
    expect(
      typeEvidenceWarningForPlanItem({
        ref: 'plan-a#P-001',
        oldStatus: 'wip',
        newStatus: 'done',
        verification: {
          verifiedHow: 'unit',
          filesChanged: ['packages/operator-core/lib/example.ts'],
          testsRun: 'vitest run example.test.ts',
          testResult: '8 passed / 0 failed',
        },
      }),
    ).toMatch(/NEVER typechecks/);
  });

  it('does not warn for a non-terminal or already-done flip', () => {
    expect(
      typeEvidenceWarningForPlanItem({
        ref: 'plan-a#P-001',
        oldStatus: 'todo',
        newStatus: 'wip',
      }),
    ).toBeUndefined();
    expect(
      typeEvidenceWarningForPlanItem({
        ref: 'plan-a#P-001',
        oldStatus: 'done',
        newStatus: 'done',
      }),
    ).toBeUndefined();
  });
});
