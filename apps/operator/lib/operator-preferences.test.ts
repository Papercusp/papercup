import { describe, it } from 'vitest';

// operator-preferences.ts moved from `<papercuspRoot>/system/operator/preferences.md`
// to `harness_shared.operator_preferences` (PG, migration 022). The
// previous tests mocked papercusp-root + filesystem; that's no longer how
// state is stored. Re-introducing tests requires a shared mock for
// @papercusp/db-org's getOrgPg().

describe('operator-preferences (PG-backed)', () => {
  it.skip('migrated to PG — see operator-state-pg integration coverage', () => {
    // intentionally empty
  });
});
