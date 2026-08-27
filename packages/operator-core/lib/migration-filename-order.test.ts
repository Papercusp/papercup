import { describe, expect, it } from 'vitest';
import { compareMigrationFilenames } from '../../../libs/papercusp/packages/embedded-postgres-server/src/migration-runner.js';

describe('migration filename ordering', () => {
  it('orders four-digit migrations after their three-digit prerequisites', () => {
    const files = [
      '1003-work-item-sequence-federation-floor.sql',
      '374-work-items-unify-base-table.sql',
      '999-personal-vault-import-failed-entries.sql',
      '1000-first-four-digit.sql',
      '000-baseline.sql',
    ];

    expect(files.sort(compareMigrationFilenames)).toEqual([
      '000-baseline.sql',
      '374-work-items-unify-base-table.sql',
      '999-personal-vault-import-failed-entries.sql',
      '1000-first-four-digit.sql',
      '1003-work-item-sequence-federation-floor.sql',
    ]);
  });

  it('uses the complete filename as a deterministic tie-breaker', () => {
    expect(
      ['1003-z.sql', 'notes.sql', '1003-a.sql'].sort(compareMigrationFilenames),
    ).toEqual(['1003-a.sql', '1003-z.sql', 'notes.sql']);
  });
});
