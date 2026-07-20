import { describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { resolveSearchFilters } from './filters';

// The session:'self' and owner:'self' paths never touch `sql` (only the fleet
// branch queries), so a null stub is safe for these cases. resolveSelfSession
// runs against the real FS but resolves to null for a fabricated owner with no
// isolation dir — which still exercises the owner-scope branch.
const noSql = null as unknown as Sql;
const FAKE_OWNER = 'su-wi5644-test-owner-no-real-dir';

describe('resolveSearchFilters — session:self owner-scoping (WI-5644)', () => {
  it("owner-scopes session:'self' across the whole respawn chain and never pins a single native sessionId", async () => {
    const { filters } = await resolveSearchFilters(noSql, { session: 'self' }, FAKE_OWNER);
    // The fix: `session:'self'` recall must span EVERY transcript the coord
    // owner produced (a cold carry-respawn scatters history across many native
    // sessions under one owner), so it scopes by the owner column — never by a
    // single, possibly-stale native session id.
    expect(filters?.owners).toEqual([FAKE_OWNER]);
    expect(filters?.sessionId).toBeUndefined();
  });

  it('still pins filters.sessionId for an EXPLICIT (non-self) session id', async () => {
    const { filters } = await resolveSearchFilters(noSql, { session: 'abc-123' }, FAKE_OWNER);
    // Regression guard: only the 'self' sugar is owner-scoped; an explicit
    // session id must still narrow to that one session.
    expect(filters?.sessionId).toBe('abc-123');
    expect(filters?.owners).toBeUndefined();
  });

  it("resolves owner:'self' to the caller ownerId (unchanged)", async () => {
    const { filters } = await resolveSearchFilters(noSql, { owner: 'self' }, FAKE_OWNER);
    expect(filters?.owners).toEqual([FAKE_OWNER]);
  });

  it('returns no filters when nothing is set (the no-narrowing fast path)', async () => {
    const resolved = await resolveSearchFilters(noSql, {}, FAKE_OWNER);
    expect(resolved.filters).toBeUndefined();
  });
});
