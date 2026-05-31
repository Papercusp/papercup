import { describe, it } from 'vitest';

// voice-prefs.ts moved from `<papercuspRoot>/system/operator/voice-prefs.json`
// to `harness_shared.operator_voice_prefs` (PG, migration 020) so the
// previous file-mocking tests don't apply. The PG-backed read/save path is
// covered by integration smoke tests in scripts (insert + GET round-trip);
// the pure-logic mergePrefs() helper is internal and not separately tested.
//
// If we want a unit test for voice-prefs again, the right shape is a mock
// of @papercusp/db-org's getOrgPg() with an in-memory tagged-template handler
// that records the SQL call and returns the canned row. That's a heavier
// scaffold than this module needed previously and isn't reused yet.

describe('voice-prefs (PG-backed)', () => {
  it.skip('migrated to PG — see operator-state-pg.ts smoke tests', () => {
    // intentionally empty — see comment above.
  });
});
