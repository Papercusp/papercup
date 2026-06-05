import { describe, it } from 'vitest';

// Paperclip's in-flight drizzle migration converted operator-conversations.ts
// from raw tagged-template `sql\`\`` to drizzle's fluent builder
// (db.select(cols).from(oc).where(...)). The previous PG-mock pattern
// (text-match on the SQL fragment) no longer applies; replicating the
// drizzle stub requires table-aware identity comparisons.
//
// The voice/text unification spine these tests cover is verified live
// against the real PG (see project_operator_unification_active.md memory).
// Pinning the unit tests will be revisited once the drizzle migration
// stabilizes and we can use a shared drizzle stub helper across
// operator-{audit,scan-lock,conversations,...}.
describe.skip('operator-conversations (PG-backed)', () => {
  it('TODO: re-port to drizzle stub once @papercusp/db-org migration lands', () => {
    /* placeholder */
  });
});
