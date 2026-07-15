/**
 * EI-12141 — the shared branched sql-mock's own guarantees: an unmatched query
 * throws loudly (instead of silently returning []), a dead/never-hit branch is
 * caught by assertAllMatched(), and the escape hatches (onUnmatched:'empty', an
 * explicit catch-all branch) work as documented.
 */
import { describe, expect, it } from 'vitest';
import { createBranchedSqlMock } from './sql-mock';

describe('createBranchedSqlMock', () => {
  it('routes a matching query to its branch and returns the fixture', async () => {
    const branches = createBranchedSqlMock([
      { label: 'held-claims', match: (q) => q.includes('taken_by'), respond: () => [{ id: 'F-held' }] },
    ]);

    const rows = await branches.handler(['SELECT 1 WHERE taken_by = $1']);

    expect(rows).toEqual([{ id: 'F-held' }]);
    expect(branches.allMatched).toBe(true);
    expect(() => branches.assertAllMatched()).not.toThrow();
  });

  it('picks the FIRST matching branch in declaration order', async () => {
    const branches = createBranchedSqlMock([
      { label: 'specific', match: (q) => q.includes('taken_by'), respond: () => ['specific'] },
      { label: 'catch-all', match: () => true, respond: () => ['catch-all'] },
    ]);

    const rows = await branches.handler(['... taken_by ...']);

    expect(rows).toEqual(['specific']);
  });

  it('throws loudly on an unmatched query by default — the EI-12141 failure class, caught not silenced', async () => {
    const branches = createBranchedSqlMock([
      { label: 'active-claims-by-taken_by', match: (q) => q.includes('taken_by'), respond: () => [{ id: 'F-held' }] },
    ]);

    await expect(branches.handler(['SELECT 1 WHERE active_claims = $1'])).rejects.toThrow(
      /no branch matched a query/,
    );
    // The error names the query text and every declared branch, so the failure is
    // immediately actionable instead of masquerading as an unrelated red/green.
    await expect(branches.handler(['SELECT 1 WHERE active_claims = $1'])).rejects.toThrow(
      /active-claims-by-taken_by/,
    );
  });

  it('an unmatched query returns [] instead of throwing when onUnmatched is "empty"', async () => {
    const branches = createBranchedSqlMock(
      [{ label: 'held-claims', match: (q) => q.includes('taken_by'), respond: () => [{ id: 'F-held' }] }],
      { onUnmatched: 'empty' },
    );

    await expect(branches.handler(['SELECT unrelated'])).resolves.toEqual([]);
  });

  it('assertAllMatched throws (naming the label) when a declared branch is never hit — the dead-branch class', async () => {
    const branches = createBranchedSqlMock([
      { label: 'held-claims', match: (q) => q.includes('taken_by'), respond: () => [{ id: 'F-held' }] },
      { label: 'never-hit', match: (q) => q.includes('this-string-does-not-appear'), respond: () => [] },
    ]);

    await branches.handler(['SELECT 1 WHERE taken_by = $1']);

    expect(branches.allMatched).toBe(false);
    expect(() => branches.assertAllMatched()).toThrow(/never-hit/);
  });

  it('resetHits clears hit-tracking without dropping the branch list', async () => {
    const branches = createBranchedSqlMock([
      { label: 'held-claims', match: (q) => q.includes('taken_by'), respond: () => [{ id: 'F-held' }] },
    ]);
    await branches.handler(['... taken_by ...']);
    expect(branches.allMatched).toBe(true);

    branches.resetHits();

    expect(branches.allMatched).toBe(false);
    await expect(branches.handler(['... taken_by ...'])).resolves.toEqual([{ id: 'F-held' }]);
    expect(branches.allMatched).toBe(true);
  });

  it('rejects an empty branch list at construction — nothing to route to is a setup bug, not a runtime surprise', () => {
    expect(() => createBranchedSqlMock([])).toThrow(/at least one branch is required/);
  });

  it('handles a non-array first argument (plain string query) the same as a template-strings array', async () => {
    const branches = createBranchedSqlMock([
      { label: 'plain-string', match: (q) => q === 'SELECT 1', respond: () => [{ ok: true }] },
    ]);

    await expect(branches.handler('SELECT 1')).resolves.toEqual([{ ok: true }]);
  });
});
