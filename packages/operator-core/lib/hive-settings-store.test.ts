/**
 * WI-7010 — a joiner's local pot handle may differ from the owner-authored
 * federated scope used by hive-home projections. The settings store accepts a
 * local handle at its public boundary, but every persistence operation must use
 * the resolved federated scope. A miss is otherwise silent (`null` / `[]` /
 * `false`), so exercise the real CRUD functions rather than only the resolver.
 */
import type { Sql } from 'postgres';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  getHiveBySlug: vi.fn(),
  resolveFederatedPotScope: vi.fn(),
}));

vi.mock('./hive-store', () => ({
  getHiveBySlug: h.getHiveBySlug,
}));

vi.mock('./federated-pot-scope', () => ({
  resolveFederatedPotScope: h.resolveFederatedPotScope,
}));

import {
  deleteHiveSetting,
  getHiveSetting,
  listHiveSettings,
  setHiveSetting,
} from './hive-settings-store';

const WS = 'ws-settings-scope';
const LOCAL = 'owner-hive-2';
const OWNER = 'owner-hive';
const KEY = 'theme';

function settingRow() {
  return {
    workspace_id: WS,
    harness_slug: OWNER,
    setting_key: KEY,
    value: JSON.stringify('dark'),
    created_at: 10,
    updated_at: 20,
  };
}

function scopedSql() {
  const unsafe = vi.fn(async (query: string, params: unknown[]) => {
    // Model the broken topology precisely: the projected row exists only under
    // the OWNER scope. A query under LOCAL gets the store's ordinary empty result.
    if (params[1] !== OWNER) return [];
    if (query.includes('DELETE FROM')) return [{ setting_key: KEY }];
    return [settingRow()];
  });
  return { sql: { unsafe } as unknown as Sql, unsafe };
}

describe('hive settings federated scope (WI-7010)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.resolveFederatedPotScope.mockResolvedValue(OWNER);
    h.getHiveBySlug.mockResolvedValue({ canonicalHomeSlug: OWNER });
  });

  it('reads, lists, and deletes under the federated scope rather than the local handle', async () => {
    const { sql, unsafe } = scopedSql();

    expect((await getHiveSetting(WS, LOCAL, KEY, sql))?.potHomeSlug).toBe(OWNER);
    expect((await listHiveSettings(WS, LOCAL, sql)).map((row) => row.potHomeSlug)).toEqual([OWNER]);
    expect(await deleteHiveSetting(WS, LOCAL, KEY, sql)).toBe(true);

    expect(h.resolveFederatedPotScope).toHaveBeenCalledTimes(3);
    for (const call of h.resolveFederatedPotScope.mock.calls) {
      expect(call).toEqual([WS, LOCAL, { sql }]);
    }
    expect(unsafe.mock.calls.map(([, params]) => params[1])).toEqual([OWNER, OWNER, OWNER]);
  });

  it('validates a write against the local Hive but persists it under the federated scope', async () => {
    const { sql, unsafe } = scopedSql();

    const record = await setHiveSetting(
      { workspaceId: WS, potHomeSlug: LOCAL, settingKey: KEY, value: 'dark' },
      sql,
    );

    expect(h.getHiveBySlug).toHaveBeenCalledWith(WS, LOCAL, sql);
    expect(h.resolveFederatedPotScope).toHaveBeenCalledWith(WS, LOCAL, { sql });
    expect(h.getHiveBySlug.mock.invocationCallOrder[0]).toBeLessThan(
      h.resolveFederatedPotScope.mock.invocationCallOrder[0],
    );
    expect(unsafe.mock.calls[0]?.[1]?.[1]).toBe(OWNER);
    expect(record.potHomeSlug).toBe(OWNER);
  });
});
