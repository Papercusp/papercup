import { describe, it } from 'vitest';

// operator-idle-snapshot.ts moved from `<papercuspRoot>/system/operator/idle-snapshot.json`
// to `harness_shared.operator_idle_snapshot` (PG, migration 020). Same
// rationale as the other operator-state migrations — file-mocked tests
// don't apply to PG-backed storage.

describe('operator-idle-snapshot (PG-backed)', () => {
  it.skip('migrated to PG — covered by operator-scan integration', () => {
    // intentionally empty
  });
});
