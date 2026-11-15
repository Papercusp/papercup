/**
 * hive-settings projection: delete tombstones (WI-6554700010049343, migration 1636).
 *
 * The bug: a federated delete removed the pot_settings row and recorded nothing, so a
 * put that the delete supersedes, applied AFTER it (a log downloaded later, a re-fold
 * after restart), re-inserted the row on that peer only and catch-up diverged (v1 R-3).
 * The fix keeps the delete's order key in harness_shared.fed_tombstones and refuses any
 * put whose order key is not newer than it.
 *
 * The decisive property is order independence: every arrival order of the same op set
 * must leave the same pot_settings state, namely the state of the op with the greatest
 * order key (a put leaves its row, a delete leaves no row).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import { getTestPg, markManagedTestDatabase } from '@papercusp/test-config/pg';
import { FED_ORDER_KEY_DDL, fedTombstonesDdl } from '../../../../test/_pg-helpers';
import { buildHiveSettingsProjection } from './hive-settings';

const WS = 'ws-tombstone';
const SLUG = 'hive-tomb';
const KEY = 'budget';

let sql: postgres.Sql;

beforeAll(async () => {
  const adminUri = await getTestPg();
  const dbName = `hst_${randomBytes(5).toString('hex')}`;
  const admin = postgres(adminUri, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
    await markManagedTestDatabase(admin, dbName);
  } finally {
    await admin.end({ timeout: 5 });
  }
  const u = new URL(adminUri);
  u.pathname = `/${dbName}`;
  sql = postgres(u.toString(), { max: 1, onnotice: () => {} });
  await sql.unsafe(`CREATE SCHEMA harness_shared`);
  await sql.unsafe(FED_ORDER_KEY_DDL);
  await sql.unsafe(fedTombstonesDdl());
  // FAITHFUL to the live relation (dev:pg_query describe harness_shared.pot_settings).
  await sql.unsafe(`
    CREATE TABLE harness_shared.pot_settings (
      workspace_id text NOT NULL,
      harness_slug text NOT NULL,
      setting_key text NOT NULL,
      value text,
      author_pubkey text,
      origin text DEFAULT 'local' NOT NULL,
      fed_ts bigint,
      created_at bigint NOT NULL,
      updated_at bigint DEFAULT 0 NOT NULL,
      fed_hlc text,
      CONSTRAINT pot_settings_pkey PRIMARY KEY (workspace_id, harness_slug, setting_key)
    )`);
}, 90_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 });
});

beforeEach(async () => {
  await sql`TRUNCATE harness_shared.pot_settings, harness_shared.fed_tombstones`;
});

const proj = () => buildHiveSettingsProjection({ sql, workspaceId: WS, harnessSlug: SLUG });

type Op =
  | { kind: 'put'; ts: number; value: string; hlc?: string }
  | { kind: 'del'; ts: number; hlc?: string };

const put = (ts: number, value: string, hlc?: string): Op => ({ kind: 'put', ts, value, hlc });
const del = (ts: number, hlc?: string): Op => ({ kind: 'del', ts, hlc });

async function apply(op: Op): Promise<void> {
  if (op.kind === 'put') {
    await proj().writeToPg(
      { harness_slug: SLUG, setting_key: KEY, value: op.value },
      { ts: op.ts, fedHlc: op.hlc, authorPubkey: 'pk-remote', origin: 'remote' },
    );
  } else {
    await proj().deleteFromPg(KEY, op.ts, op.hlc);
  }
}

async function settingRow(): Promise<{ value: string | null; fed_ts: string | null } | null> {
  const rows = await sql<{ value: string | null; fed_ts: string | null }[]>`
    SELECT value, fed_ts::text AS fed_ts FROM harness_shared.pot_settings
     WHERE workspace_id = ${WS} AND harness_slug = ${SLUG} AND setting_key = ${KEY}`;
  return rows[0] ?? null;
}

async function tombstoneTs(): Promise<string | null> {
  const rows = await sql<{ fed_ts: string | null }[]>`
    SELECT fed_ts::text AS fed_ts FROM harness_shared.fed_tombstones
     WHERE workspace_id = ${WS} AND harness_slug = ${SLUG}
       AND table_name = 'pot_settings' AND row_key = ${KEY}`;
  return rows[0]?.fed_ts ?? null;
}

function permutations<T>(items: T[]): T[][] {
  if (items.length <= 1) return [items];
  return items.flatMap((item, i) =>
    permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest]));
}

describe('hive-settings delete tombstones (PG)', () => {
  it('a put older than an applied delete does not resurrect the row', async () => {
    await apply(put(50, 'old'));
    await apply(del(200));
    expect(await settingRow()).toBeNull();
    await apply(put(100, 'stale'));
    expect(await settingRow()).toBeNull();
    expect(await tombstoneTs()).toBe('200');
  });

  it('a put newer than the delete restores the row and retires the tombstone', async () => {
    await apply(del(200));
    await apply(put(300, 'fresh'));
    expect(await settingRow()).toEqual({ value: 'fresh', fed_ts: '300' });
    expect(await tombstoneTs()).toBeNull();
  });

  it('orders by HLC when the delete carries one', async () => {
    await apply(del(1, '000000000000200:00001'));
    await apply(put(150, 'stale'));
    expect(await settingRow()).toBeNull();
    await apply(put(250, 'fresh'));
    expect(await settingRow()).toEqual({ value: 'fresh', fed_ts: '250' });
  });

  it('an older delete arriving later does not regress the tombstone', async () => {
    await apply(del(200));
    await apply(del(120));
    expect(await tombstoneTs()).toBe('200');
    await apply(put(180, 'stale'));
    expect(await settingRow()).toBeNull();
  });

  it('an unordered legacy delete removes the row and leaves no tombstone', async () => {
    await apply(put(100, 'v'));
    await proj().deleteFromPg(KEY);
    expect(await settingRow()).toBeNull();
    expect(await tombstoneTs()).toBeNull();
    await apply(put(90, 'later'));
    expect(await settingRow()).toEqual({ value: 'later', fed_ts: '90' });
  });

  const opSets: { name: string; ops: Op[]; expected: { value: string; fed_ts: string } | null }[] = [
    { name: 'newest op is a put', ops: [put(100, 'a'), del(200), put(300, 'b'), put(250, 'c')],
      expected: { value: 'b', fed_ts: '300' } },
    { name: 'newest op is a delete', ops: [put(100, 'a'), del(200), put(150, 'c'), del(120)],
      expected: null },
  ];

  for (const set of opSets) {
    it(`every arrival order converges (${set.name}, ${permutations(set.ops).length} orders)`, async () => {
      const outcomes: string[] = [];
      for (const order of permutations(set.ops)) {
        await sql`TRUNCATE harness_shared.pot_settings, harness_shared.fed_tombstones`;
        for (const op of order) await apply(op);
        const got = await settingRow();
        const label = order.map((op) => (op.kind === 'put' ? `put${op.ts}` : `del${op.ts}`)).join(',');
        outcomes.push(`${label} => ${JSON.stringify(got)}`);
        expect(got, label).toEqual(set.expected);
      }
      expect(outcomes).toHaveLength(24);
    });
  }
});
