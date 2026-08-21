import { describe, expect, it } from 'vitest';
import {
  assertDbosWorkItemsImportContract,
  missingDbosWorkItemsExports,
  REQUIRED_DBOS_WORK_ITEMS_EXPORTS,
} from './work-items-contract';

describe('DBOS bundled work-items import contract', () => {
  it('requires the current typed owner-action exclusion helper', () => {
    expect(REQUIRED_DBOS_WORK_ITEMS_EXPORTS).toEqual(['needsOwnerActionExclusionSql']);
  });

  it('recognizes the current module shape as complete', () => {
    expect(
      missingDbosWorkItemsExports({
        needsOwnerActionExclusionSql: () => undefined,
      }),
    ).toEqual([]);
  });

  it('recognizes the pre-rename sidecar shape as stale', () => {
    expect(missingDbosWorkItemsExports({ needsHumanExclusionSql: () => undefined })).toEqual([
      'needsOwnerActionExclusionSql',
    ]);
  });

  it('fails with an actionable rebuild error for a stale shape', () => {
    expect(() => assertDbosWorkItemsImportContract({ needsHumanExclusionSql: () => undefined })).toThrow(
      /bundled work-items import contract is stale or mixed.*needsOwnerActionExclusionSql.*Rebuild the sidecar/s,
    );
  });

  it('rejects a missing or non-function current export', () => {
    expect(() =>
      assertDbosWorkItemsImportContract({
        needsOwnerActionExclusionSql: undefined,
      }),
    ).toThrow(/needsOwnerActionExclusionSql/);
  });
});
