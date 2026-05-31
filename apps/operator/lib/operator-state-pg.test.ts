import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Map keyed by `<table>:<workspace_id>` → row payload (JSONB-equivalent).
const store = new Map<string, unknown>();

vi.mock('./workspace-registry', () => ({ activeWorkspaceId: () => 'test-ws' }));
vi.mock('./db-encryption', () => ({
  ENCRYPTED_TABLES: new Set<string>(), // tests cover the unencrypted path only
  getDbEncryptionKey: () => 'unused',
}));

vi.mock('@papercusp/db-org', () => {
  function tableFromFragment(s: string): string | null {
    const m = /harness_shared\.([a-zA-Z0-9_]+)/.exec(s);
    return m ? m[1] : null;
  }

  // Tagged template handler. Values: [fragment(table), workspaceId, ...rest].
  function tagged(strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> {
    const sqlText = strings.join('?');
    // values[0] is the table fragment (from sql(`harness_shared.X`)),
    // values[1] is the bound workspace_id parameter, values[2+] follow.
    const tableName = (values[0] as { _table?: string })?._table ?? null;
    const ws = typeof values[1] === 'string' ? (values[1] as string) : 'test-ws';
    const key = `${tableName}:${ws}`;

    if (/SELECT payload FROM/.test(sqlText)) {
      const row = store.get(key);
      return Promise.resolve(row !== undefined ? [{ payload: row }] : []);
    }
    if (/INSERT INTO/.test(sqlText)) {
      // Insert order: ${sql(table)}, ${ws}, ${JSON.stringify(payload)}, ${now}.
      // The implementation pre-stringifies before the ::jsonb cast, so
      // the bound value is a JSON string. Parse it to reconstruct the
      // object the caller passed in.
      const raw = values[2];
      const payload = typeof raw === 'string' ? JSON.parse(raw) : raw;
      store.set(key, payload);
      return Promise.resolve([]);
    }
    return Promise.resolve([]);
  }

  // sql(`harness_shared.X`) returns a fragment object. sql`...` runs the
  // tagged template. Differentiate by the type of the first arg.
  function sqlCallable(strs: TemplateStringsArray | string, ..._rest: unknown[]): unknown {
    if (typeof strs === 'string') {
      return { _table: tableFromFragment(strs) };
    }
    return tagged(strs as TemplateStringsArray, ..._rest);
  }
  const wrapped = sqlCallable as unknown as typeof tagged;
  (wrapped as unknown as { json: <T>(v: T) => T }).json = (v) => v;
  (wrapped as unknown as { begin: <T>(cb: (tx: unknown) => Promise<T>) => Promise<T> }).begin =
    async <T>(cb: (tx: unknown) => Promise<T>) => cb(wrapped);

  return {
    getOrgPg: () => ({ sql: wrapped, db: {} }),
  };
});

import { readOperatorState, writeOperatorState } from './operator-state-pg';

beforeEach(() => store.clear());
afterEach(() => store.clear());

describe('readOperatorState / writeOperatorState (unencrypted path)', () => {
  it('returns null when no row exists', async () => {
    expect(await readOperatorState('operator_first_run')).toBeNull();
  });

  it('round-trips a payload through write→read', async () => {
    await writeOperatorState('operator_first_run', { shownAt: '2026-05-01', shownToUserIds: ['u1'] });
    const got = await readOperatorState<{ shownToUserIds: string[] }>('operator_first_run');
    expect(got?.shownToUserIds).toEqual(['u1']);
  });

  it('overwrites the row on second write', async () => {
    await writeOperatorState('operator_first_run', { shownAt: '2026-05-01', shownToUserIds: ['u1'] });
    await writeOperatorState('operator_first_run', { shownAt: '2026-05-02', shownToUserIds: ['u2'] });
    const got = await readOperatorState<{ shownToUserIds: string[] }>('operator_first_run');
    expect(got?.shownToUserIds).toEqual(['u2']);
  });

  it('isolates rows by table name', async () => {
    await writeOperatorState('operator_first_run', { a: 1 });
    await writeOperatorState('operator_budget', { b: 2 });
    expect(await readOperatorState('operator_first_run')).toEqual({ a: 1 });
    expect(await readOperatorState('operator_budget')).toEqual({ b: 2 });
  });

  it('readOperatorState honors workspace override', async () => {
    // The mock's activeWorkspaceId is fixed to 'test-ws'; passing a different
    // override should query that key instead. Pre-populate manually.
    store.set('operator_first_run:other-ws', { override: true });
    const got = await readOperatorState<{ override?: boolean }>('operator_first_run', 'other-ws');
    expect(got?.override).toBe(true);
  });
});
