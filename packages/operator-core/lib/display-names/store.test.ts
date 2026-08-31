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
import {
  AGENT_DISPLAY_NAME_MAX,
  getAgentDisplayName,
  getAgentDisplayNameRow,
  getAgentDisplayNames,
  normalizeDisplayNameInput,
  resolveOwnerWorkspaceId,
  setAgentDisplayName,
} from './store';

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

/**
 * The write path (P-007). `fakeSql` above only records interpolated VALUES,
 * which cannot tell a DELETE from an INSERT — and "clearing DELETEs" is the
 * whole contract here (R6) — so this one keeps the statement text too.
 */
function fakeWriteSql() {
  const statements: Array<{ text: string; values: unknown[] }> = [];
  const fn = ((...args: unknown[]) => {
    const strings = args[0] as TemplateStringsArray;
    statements.push({ text: strings.join(' ').replace(/\s+/g, ' ').trim(), values: args.slice(1) });
    return Promise.resolve([]);
  }) as unknown as Sql;
  return { sql: fn, statements };
}

describe('normalizeDisplayNameInput', () => {
  it('trims and collapses whitespace runs to one line', () => {
    expect(normalizeDisplayNameInput('  gate   wrangler \n lane  ')).toBe('gate wrangler lane');
  });

  // The name is printed into an OS terminal title through an OSC escape. The
  // renderer defends itself, but a stored value that NEEDS defending is a trap
  // for the next reader that forgets to — so BEL and ESC never reach the row.
  it('strips control characters, including the ones that break an OSC title', () => {
    const raw = 'gate\x07 wran\x1bgler\x7f';
    // Guard the guard: an inert '\\x07' in the literal above would make this
    // assertion vacuous while still passing.
    expect(raw).toContain('\x07');
    expect(normalizeDisplayNameInput(raw)).toBe('gate wrangler');
  });

  // R6: every shape of "nothing" collapses to the SINGLE unnamed encoding, so
  // the writer has exactly one branch to route to a DELETE.
  it.each([
    ['', 'empty'],
    ['    ', 'blank'],
    ['\x07\x1b', 'control-only'],
  ])('normalizes %j (%s) to null', (input) => {
    expect(normalizeDisplayNameInput(input)).toBeNull();
  });

  it('normalizes a non-string to null rather than coercing it', () => {
    expect(normalizeDisplayNameInput(undefined)).toBeNull();
    expect(normalizeDisplayNameInput(null)).toBeNull();
    expect(normalizeDisplayNameInput(42)).toBeNull();
  });

  it('bounds a long name instead of storing a document on the roster hot path', () => {
    const long = 'x'.repeat(AGENT_DISPLAY_NAME_MAX + 40);
    expect(normalizeDisplayNameInput(long)).toHaveLength(AGENT_DISPLAY_NAME_MAX);
  });
});

describe('setAgentDisplayName', () => {
  it('upserts a trimmed name keyed on workspace + owner', async () => {
    const { sql, statements } = fakeWriteSql();
    await expect(
      setAgentDisplayName({ workspaceId: 'ws', ownerId: 'su-a', name: '  release wrangler ', setBy: 'owner', sql }),
    ).resolves.toEqual({ ownerId: 'su-a', displayName: 'release wrangler', cleared: false });
    expect(statements).toHaveLength(1);
    expect(statements[0].text).toMatch(/^INSERT INTO harness_shared\.agent_display_names/);
    expect(statements[0].text).toContain('ON CONFLICT (workspace_id, owner_id) DO UPDATE');
    expect(statements[0].values).toEqual(['ws', 'su-a', 'release wrangler', 'owner']);
  });

  // THE encoding contract (R6). A blank must not reach the upsert: the table's
  // CHECK would reject it as a 23514, which the caller would see as a failed
  // rename rather than as the clear it asked for.
  it.each([
    ['', 'empty'],
    ['   ', 'whitespace'],
    [null, 'null'],
    [undefined, 'undefined'],
  ])('DELETEs the row when the submitted name is %j (%s)', async (name, _description) => {
    const { sql, statements } = fakeWriteSql();
    await expect(
      setAgentDisplayName({ workspaceId: 'ws', ownerId: 'su-a', name, setBy: 'owner', sql }),
    ).resolves.toEqual({ ownerId: 'su-a', displayName: null, cleared: true });
    expect(statements).toHaveLength(1);
    expect(statements[0].text).toMatch(/^DELETE FROM harness_shared\.agent_display_names/);
    expect(statements[0].text).not.toMatch(/INSERT|UPDATE/);
  });

  it('records who set it, so an owner name is distinguishable from a self-name', async () => {
    const { sql, statements } = fakeWriteSql();
    await setAgentDisplayName({ workspaceId: 'ws', ownerId: 'su-a', name: 'n', setBy: 'su-caller', sql });
    expect(statements[0].values).toContain('su-caller');
  });

  // A read with no key legitimately answers "no name"; a WRITE with no key has
  // no legitimate meaning — it would either name nothing or name the wrong row.
  it('refuses a keyless write instead of silently doing nothing', async () => {
    const { sql, statements } = fakeWriteSql();
    await expect(
      setAgentDisplayName({ workspaceId: '', ownerId: 'su-a', name: 'n', setBy: 'owner', sql }),
    ).rejects.toThrow(/workspaceId and an ownerId/);
    await expect(
      setAgentDisplayName({ workspaceId: 'ws', ownerId: '  ', name: 'n', setBy: 'owner', sql }),
    ).rejects.toThrow(/workspaceId and an ownerId/);
    expect(statements).toHaveLength(0);
  });
});

describe('resolveOwnerWorkspaceId', () => {
  // Why this exists at all: the READERS key by the owner's presence workspace,
  // so a writer that used the operator's ambient workspace would store the name
  // where nothing looks for it — a rename that silently does nothing.
  it('reads the owner’s presence workspace', async () => {
    const { sql } = fakeSql([{ workspace_id: 'papercusp-workspace' }]);
    await expect(resolveOwnerWorkspaceId('su-a', sql)).resolves.toBe('papercusp-workspace');
  });

  it('returns null for an owner with no presence row, leaving the fallback to the caller', async () => {
    const { sql } = fakeSql([]);
    await expect(resolveOwnerWorkspaceId('su-gone', sql)).resolves.toBeNull();
  });

  it('treats a blank stored workspace as absent rather than writing under ""', async () => {
    const { sql } = fakeSql([{ workspace_id: '   ' }]);
    await expect(resolveOwnerWorkspaceId('su-a', sql)).resolves.toBeNull();
  });

  it('never queries without an owner id', async () => {
    const { sql, queries } = fakeSql([{ workspace_id: 'ws' }]);
    await expect(resolveOwnerWorkspaceId('  ', sql)).resolves.toBeNull();
    expect(queries).toHaveLength(0);
  });
});
