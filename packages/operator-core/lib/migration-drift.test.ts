import { describe, it, expect } from 'vitest';
import { computeSchemaAhead } from './migration-drift';

/**
 * WI-5050 (WI-4070 class): `schemaAhead` flags applied migrations numbered
 * beyond anything the running code tree ships — a stale operator against a
 * newer-migrated shared DB (the dev-source rot that silently killed VM
 * federation via the mig-557 hives→pots rename).
 */
describe('computeSchemaAhead', () => {
  const onDisk = ['001-a.sql', '002-b.sql', '557-hives-to-pots.sql'];

  it('is empty when the DB has nothing newer than the code tree', () => {
    expect(computeSchemaAhead(onDisk, ['001-a.sql', '002-b.sql'])).toEqual([]);
    expect(computeSchemaAhead(onDisk, onDisk)).toEqual([]);
  });

  it('flags applied migrations numbered beyond the on-disk cap', () => {
    expect(
      computeSchemaAhead(onDisk, ['001-a.sql', '558-newer.sql', '614-adjacency-state.sql']),
    ).toEqual(['558-newer.sql', '614-adjacency-state.sql']);
  });

  it('ignores non-numbered / runner-ineligible applied rows', () => {
    expect(
      computeSchemaAhead(onDisk, ['999-per-harness-template.sql', 'notes.txt', 'zzz.sql']),
    ).toEqual([]);
  });

  it('returns empty when the code tree has no numbered migrations (unknown ≠ ahead)', () => {
    expect(computeSchemaAhead([], ['558-newer.sql'])).toEqual([]);
    expect(computeSchemaAhead(['README.md'], ['558-newer.sql'])).toEqual([]);
  });

  it('an applied row EQUAL to the cap is not "ahead"', () => {
    expect(computeSchemaAhead(onDisk, ['557-hives-to-pots.sql'])).toEqual([]);
  });
});
