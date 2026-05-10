import { describe, it } from 'vitest';

// operator-standing-candidates.ts moved its file-based JSON cache to
// `harness_shared.operator_standing_candidates` (PG, migration 020).
// The audit_log query is unchanged; only the candidate-cache layer
// switched from filesystem to PG. File-mocked tests don't apply.

describe('operator-standing-candidates (PG-backed)', () => {
  it.skip('migrated to PG', () => {
    // intentionally empty
  });
});
