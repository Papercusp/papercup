/**
 * beacon-consent.integration.test.ts — the C-2 beacon-publish consent accessor
 * (hive-network-surface-2026-06-11 P-005 / brief B-07) against real migrated PG.
 * Asserts the default-OFF posture (absent / non-true reads as OFF, D-002) and the
 * set/read round-trip through the federated hive_settings store (migration 186).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import type { OrgTestDb } from '../test/_org-test-db';
import { createOrgTestDb } from '../test/_org-test-db';
import { insertHiveIfAbsent } from './hive-store';
import { setHiveSetting } from './hive-settings-store';
import {
  BEACON_PUBLISH_CONSENT_KEY,
  getBeaconPublishConsent,
  setBeaconPublishConsent,
} from './beacon-consent';

const pk = (fill: number): string => Buffer.alloc(32, fill).toString('base64');

describe('beacon-consent (real PG, C-2 default-OFF)', () => {
  let db: OrgTestDb;
  let sql: Sql;
  beforeAll(async () => {
    db = await createOrgTestDb();
    sql = db.adminSql;
    await insertHiveIfAbsent({ workspaceId: 'ws', homeSlug: 'beaconhive', pubkeyBase64: pk(1), keychainId: 'k' }, sql);
  }, 120_000);
  afterAll(async () => {
    await db?.cleanup();
  });

  it('an absent consent reads as OFF (default-deny, D-002)', async () => {
    expect(await getBeaconPublishConsent('ws', 'beaconhive', sql)).toBe(false);
  });

  it('set true → reads true; set false → reads false (round-trip)', async () => {
    await setBeaconPublishConsent('ws', 'beaconhive', true, sql);
    expect(await getBeaconPublishConsent('ws', 'beaconhive', sql)).toBe(true);

    await setBeaconPublishConsent('ws', 'beaconhive', false, sql);
    expect(await getBeaconPublishConsent('ws', 'beaconhive', sql)).toBe(false);
  });

  it('stores under the C-2 key and treats a non-true legacy value as OFF', async () => {
    await setBeaconPublishConsent('ws', 'beaconhive', true, sql);
    // A junk / legacy value (not strictly `true`) must read OFF — the gate is structural.
    await setHiveSetting(
      { workspaceId: 'ws', hiveHomeSlug: 'beaconhive', settingKey: BEACON_PUBLISH_CONSENT_KEY, value: 'yes' },
      sql,
    );
    expect(await getBeaconPublishConsent('ws', 'beaconhive', sql)).toBe(false);
  });
});
