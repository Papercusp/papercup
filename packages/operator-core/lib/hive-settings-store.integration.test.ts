/**
 * hive-settings-store.integration.test.ts — per-Hive settings federation
 * (migration 186, shared-hive-federation-2026-06-08 P-005) against real migrated
 * PG. Covers the local store (set/get/list/delete + the logical-scope guard) AND
 * the read-side projection (federated apply + LWW guard + per-harness demux).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import type { OrgTestDb } from '../test/_org-test-db';
import { createOrgTestDb } from '../test/_org-test-db';
import { insertHiveIfAbsent } from './hive-store';
import {
  deleteHiveInstancePromptOverride,
  deleteHiveLocalBlueprintConfig,
  deleteHiveSetting,
  getHiveInstancePromptOverride,
  getHiveLocalBlueprintConfig,
  getHiveSetting,
  listHiveInstancePromptOverrides,
  listHiveLocalBlueprintConfig,
  listHiveSettings,
  localBlueprintConfigKey,
  promptOverrideSettingKey,
  setHiveInstancePromptOverride,
  setHiveLocalBlueprintConfig,
  setHiveSetting,
} from './hive-settings-store';
import { buildHiveSettingsProjection } from './sync/hyperbee/projections/hive-settings';

const pk = (fill: number): string => Buffer.alloc(32, fill).toString('base64');

describe('hive_settings (real PG, migration 186)', () => {
  let db: OrgTestDb;
  let sql: Sql;
  beforeAll(async () => {
    db = await createOrgTestDb();
    sql = db.adminSql;
    // A Hive must exist — setHiveSetting enforces the logical scope.
    await insertHiveIfAbsent({ workspaceId: 'ws', homeSlug: 'myhive', pubkeyBase64: pk(1), keychainId: 'k' }, sql);
  }, 120_000);
  afterAll(async () => {
    await db?.cleanup();
  });

  it('set/get/list/delete round-trips JSON values', async () => {
    await setHiveSetting({ workspaceId: 'ws', hiveHomeSlug: 'myhive', settingKey: 'budget', value: { usd: 5 } }, sql);
    await setHiveSetting({ workspaceId: 'ws', hiveHomeSlug: 'myhive', settingKey: 'tier', value: 'auto' }, sql);

    expect((await getHiveSetting('ws', 'myhive', 'budget', sql))?.value).toEqual({ usd: 5 });
    expect((await listHiveSettings('ws', 'myhive', sql)).map((s) => s.settingKey)).toEqual(['budget', 'tier']);

    // upsert overwrites
    await setHiveSetting({ workspaceId: 'ws', hiveHomeSlug: 'myhive', settingKey: 'budget', value: { usd: 9 } }, sql);
    expect((await getHiveSetting('ws', 'myhive', 'budget', sql))?.value).toEqual({ usd: 9 });

    expect(await deleteHiveSetting('ws', 'myhive', 'tier', sql)).toBe(true);
    expect(await getHiveSetting('ws', 'myhive', 'tier', sql)).toBeNull();
    expect(await deleteHiveSetting('ws', 'myhive', 'tier', sql)).toBe(false); // idempotent
  });

  it('hive-instance prompt overrides round-trip + list by role (P-003)', async () => {
    expect(await getHiveInstancePromptOverride('ws', 'myhive', 'bee', sql)).toBeNull();

    await setHiveInstancePromptOverride('ws', 'myhive', 'bee', 'You are a Papercusp bee.', sql);
    await setHiveInstancePromptOverride('ws', 'myhive', 'su', 'You are a Papercusp engineer.', sql);

    expect(await getHiveInstancePromptOverride('ws', 'myhive', 'bee', sql)).toBe('You are a Papercusp bee.');
    expect(await getHiveInstancePromptOverride('ws', 'myhive', 'su', sql)).toBe('You are a Papercusp engineer.');

    // stored under the promptOverride.<role> key (federates like any other hive setting)
    expect((await getHiveSetting('ws', 'myhive', promptOverrideSettingKey('bee'), sql))?.value).toBe(
      'You are a Papercusp bee.',
    );

    // list returns role -> markdown, filtered to the prompt-override prefix (ignores other settings)
    await setHiveSetting({ workspaceId: 'ws', hiveHomeSlug: 'myhive', settingKey: 'tier', value: 'auto' }, sql);
    expect(await listHiveInstancePromptOverrides('ws', 'myhive', sql)).toEqual({
      bee: 'You are a Papercusp bee.',
      su: 'You are a Papercusp engineer.',
    });

    // upsert overwrites
    await setHiveInstancePromptOverride('ws', 'myhive', 'bee', 'Updated bee persona.', sql);
    expect(await getHiveInstancePromptOverride('ws', 'myhive', 'bee', sql)).toBe('Updated bee persona.');
  });

  it('local-blueprint structured config deltas round-trip + list by section (P-015)', async () => {
    expect(await getHiveLocalBlueprintConfig('ws', 'myhive', 'scout', sql)).toBeNull();

    await setHiveLocalBlueprintConfig('ws', 'myhive', 'scout', { buckets: { maxMoonshots: 2 } }, sql);
    expect(await getHiveLocalBlueprintConfig('ws', 'myhive', 'scout', sql)).toEqual({ buckets: { maxMoonshots: 2 } });

    // stored under localBlueprint.<section> (federates like any other hive setting)
    expect((await getHiveSetting('ws', 'myhive', localBlueprintConfigKey('scout'), sql))?.value).toEqual({
      buckets: { maxMoonshots: 2 },
    });

    // list filters to the localBlueprint.* prefix only — ignores promptOverride.* + plain settings
    await setHiveInstancePromptOverride('ws', 'myhive', 'queen', 'persona', sql);
    await setHiveSetting({ workspaceId: 'ws', hiveHomeSlug: 'myhive', settingKey: 'tier', value: 'auto' }, sql);
    expect(await listHiveLocalBlueprintConfig('ws', 'myhive', sql)).toEqual({
      scout: { buckets: { maxMoonshots: 2 } },
    });

    // upsert overwrites; delete is idempotent
    await setHiveLocalBlueprintConfig('ws', 'myhive', 'scout', { lenses: ['inversion'] }, sql);
    expect(await getHiveLocalBlueprintConfig('ws', 'myhive', 'scout', sql)).toEqual({ lenses: ['inversion'] });
    expect(await deleteHiveLocalBlueprintConfig('ws', 'myhive', 'scout', sql)).toBe(true);
    expect(await getHiveLocalBlueprintConfig('ws', 'myhive', 'scout', sql)).toBeNull();
    expect(await deleteHiveLocalBlueprintConfig('ws', 'myhive', 'scout', sql)).toBe(false);

    // deleteHiveInstancePromptOverride round-trips too (symmetric clear path)
    expect(await getHiveInstancePromptOverride('ws', 'myhive', 'queen', sql)).toBe('persona');
    expect(await deleteHiveInstancePromptOverride('ws', 'myhive', 'queen', sql)).toBe(true);
    expect(await getHiveInstancePromptOverride('ws', 'myhive', 'queen', sql)).toBeNull();
  });

  it('refuses a setting for a non-existent Hive (logical scope, no hard FK)', async () => {
    await expect(
      setHiveSetting({ workspaceId: 'ws', hiveHomeSlug: 'nohive', settingKey: 'x', value: 1 }, sql),
    ).rejects.toThrow(/no Hive/);
  });

  it('projection applies a federated setting + LWW-guards a stale op + demuxes by hive', async () => {
    const proj = buildHiveSettingsProjection({ workspaceId: 'ws', harnessSlug: 'myhive', sql });

    // remote put at fed_ts=100
    await proj.writeToPg(
      { harness_slug: 'myhive', setting_key: 'theme', value: JSON.stringify('dark') },
      { origin: 'remote', authorPubkey: 'pk', ts: 100 },
    );
    expect((await getHiveSetting('ws', 'myhive', 'theme', sql))?.value).toBe('dark');

    // a STALE op (fed_ts=50) must NOT overwrite
    await proj.writeToPg(
      { harness_slug: 'myhive', setting_key: 'theme', value: JSON.stringify('light') },
      { origin: 'remote', authorPubkey: 'pk', ts: 50 },
    );
    expect((await getHiveSetting('ws', 'myhive', 'theme', sql))?.value).toBe('dark');

    // a NEWER op (fed_ts=200) wins
    await proj.writeToPg(
      { harness_slug: 'myhive', setting_key: 'theme', value: JSON.stringify('light') },
      { origin: 'remote', authorPubkey: 'pk', ts: 200 },
    );
    expect((await getHiveSetting('ws', 'myhive', 'theme', sql))?.value).toBe('light');

    // per-harness demux: an op for a DIFFERENT hive home is dropped by this projection
    await proj.writeToPg(
      { harness_slug: 'otherhive', setting_key: 'theme', value: JSON.stringify('x') },
      { origin: 'remote', authorPubkey: 'pk', ts: 300 },
    );
    expect(await getHiveSetting('ws', 'otherhive', 'theme', sql)).toBeNull();

    // delete with a stale ts is guarded; a current ts removes it
    await proj.deleteFromPg('theme', 100); // stale → no-op
    expect((await getHiveSetting('ws', 'myhive', 'theme', sql))?.value).toBe('light');
    await proj.deleteFromPg('theme', 999);
    expect(await getHiveSetting('ws', 'myhive', 'theme', sql)).toBeNull();
  });
});
