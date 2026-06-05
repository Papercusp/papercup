import { describe, it } from 'vitest';

// operator-budget.ts moved from `<papercuspRoot>/system/operator/budget.json`
// to `harness_shared.operator_budget` (PG, migration 020). The previous
// tests mocked papercusp-root + filesystem; that's no longer how state is
// stored. PG round-trip is covered by integration smoke (insert, GET via
// /api/agent-mcp/operator-budget, compare).
//
// Re-introducing a unit test would require mocking @papercusp/db-org's
// getOrgPg() with an in-memory tagged-template handler; fine to add when
// we have one shared mock instead of per-module bespoke ones.

describe('operator-budget (PG-backed)', () => {
  it.skip('migrated to PG — smoke coverage replaces these unit tests', () => {
    // intentionally empty — see comment above.
  });
});
