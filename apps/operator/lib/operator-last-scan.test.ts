import { describe, it } from 'vitest';

// operator-last-scan.ts moved from `<papercuspRoot>/system/operator/last-scan.json`
// to `harness_shared.operator_last_scan` (PG, migration 020). Same rationale
// as voice-prefs.test.ts and operator-budget.test.ts — file-mocked tests
// don't apply to PG-backed storage.

describe('operator-last-scan (PG-backed)', () => {
  it.skip('migrated to PG — round-trip covered by operator-scan + operator-last-scan integration', () => {
    // intentionally empty
  });
});
