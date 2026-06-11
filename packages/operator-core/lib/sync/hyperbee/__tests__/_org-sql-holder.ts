import type postgres from 'postgres';

/** getOrgPg() → the CURRENT authority "machine"'s PG (rebound per test/round) for
 *  the cross-peer coordination suite. Lives in its own dependency-free module so
 *  the test files' vi.mock('@papercusp/db-org') factories can `await import` it
 *  without a mock↔rig import cycle (the rig transitively imports db-org, so a
 *  factory that awaits the RIG deadlocks module init). */
export const orgSqlHolder = { sql: undefined as unknown as postgres.Sql };
