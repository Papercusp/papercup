/**
 * store.test.ts — the display-name store's contract (plan
 * hud-session-display-names-2026-08-31, D-003).
 *
 * What is worth pinning here is NOT the SQL text but the encoding contract the
 * resolver depends on: absence of a row means "unnamed" (so an unnamed owner is
 * simply missing from the batch map), the batch read is ONE query for the whole
 * owner set (R10), and a degenerate owner set costs no query at all. The `sql`
 * seam is injected, so these run with no Postgres.
 */
import { describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { getAgentDisplayName, getAgentDisplayNameRow, getAgentDisplayNames } from './store';

/**
 * A postgres.js stand-in. The real `sql` is BOTH a tagged template and a
 * callable helper (`sql(array)` builds an IN list), and this store uses both in
 * one statement — so the fake discriminates on whether it received a
 * TemplateStringsArray (which carries `.raw`) or a plain array.
 */
function fakeSql(rows: Array<Record<string, unknown>>) {
  const queries: Array<{ values: unknown[] }> = [];
  const fn = ((...args: unknown[]) => {
    const first = args[0];
    if (Array.isArray(first) && !('raw' in (first as object))) {
      return { __inList: first } as unknown;
    }
    queries.push({ values: args.slice(1) });
    return Promise.resolve(rows);
  }) as unknown as Sql;
  return { sql: fn, queries };
}

const ROW = {
  owner_id: 'su-b2572cce-1111',
  display_name: 'release wrangler',
  set_by: 'owner',
  set_at: '2026-08-31T11:00:00.000Z',
};

describe('getAgentDisplayName', () => {
  it('returns the bare name for a named owner', async () => {
    const { sql } = fakeSql([ROW]);
    await expect(getAgentDisplayName('ws', 'su-b2572cce-1111', sql)).resolves.toBe('release wrangler');
  });

  it('returns null when the owner has no row — absence IS the unnamed state', async () => {
    const { sql } = fakeSql([]);
    await expect(getAgentDisplayName('ws', 'su-b2572cce-1111', sql)).resolves.toBeNull();
  });

  it('never queries on a missing workspace or owner', async () => {
    const { sql, queries } = fakeSql([ROW]);
    await expect(getAgentDisplayName('', 'su-x', sql)).resolves.toBeNull();
    await expect(getAgentDisplayName('ws', '', sql)).resolves.toBeNull();
    expect(queries).toHaveLength(0);
  });

  it('carries provenance on the row form', async () => {
    const { sql } = fakeSql([ROW]);
    await expect(getAgentDisplayNameRow('ws', 'su-b2572cce-1111', sql)).resolves.toEqual({
      ownerId: 'su-b2572cce-1111',
      displayName: 'release wrangler',
      setBy: 'owner',
      setAt: '2026-08-31T11:00:00.000Z',
    });
  });

  it('tolerates a legacy row with no set_by/set_at', async () => {
    const { sql } = fakeSql([{ owner_id: 'su-a', display_name: 'n', set_by: null, set_at: null }]);
    const row = await getAgentDisplayNameRow('ws', 'su-a', sql);
    expect(row).toEqual({ ownerId: 'su-a', displayName: 'n', setBy: null, setAt: null });
  });
});

describe('getAgentDisplayNames — the roster batch read (R10)', () => {
  it('resolves a whole owner set in ONE query', async () => {
    const { sql, queries } = fakeSql([ROW, { ...ROW, owner_id: 'su-other', display_name: 'gate fixer' }]);
    const map = await getAgentDisplayNames('ws', ['su-b2572cce-1111', 'su-other', 'su-unnamed'], sql);
    expect(queries).toHaveLength(1);
    expect(map.get('su-b2572cce-1111')).toBe('release wrangler');
    expect(map.get('su-other')).toBe('gate fixer');
    // the unnamed owner is ABSENT rather than mapped to '' — one encoding, so the
    // resolver's `manualName` can take map.get(id) straight through
    expect(map.has('su-unnamed')).toBe(false);
  });

  it('de-duplicates and drops blank owner ids before querying', async () => {
    const { sql, queries } = fakeSql([ROW]);
    await getAgentDisplayNames('ws', ['su-a', 'su-a', '', 'su-b'], sql);
    expect(queries).toHaveLength(1);
    expect(queries[0].values).toContainEqual({ __inList: ['su-a', 'su-b'] });
  });

  it('costs no query for an empty owner set or a missing workspace', async () => {
    const { sql, queries } = fakeSql([ROW]);
    await expect(getAgentDisplayNames('ws', [], sql)).resolves.toEqual(new Map());
    await expect(getAgentDisplayNames('', ['su-a'], sql)).resolves.toEqual(new Map());
    expect(queries).toHaveLength(0);
  });
});
