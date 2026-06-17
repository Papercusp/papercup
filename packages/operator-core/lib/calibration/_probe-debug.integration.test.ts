import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { _resetForTests, getOrgPg } from '@papercusp/db-org';
// eslint-disable-next-line import/no-relative-packages
import { _resetUrlCacheForTests } from '../../../../libs/papercusp/libs/db/src/connection';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';

let db: OrgTestDb;
const saved: Record<string, string | undefined> = {};

beforeAll(async () => {
  db = await createOrgTestDb();
  saved.HARNESS_ADMIN_DATABASE_URL = process.env.HARNESS_ADMIN_DATABASE_URL;
  saved.HARNESS_DATABASE_URL = process.env.HARNESS_DATABASE_URL;
  process.env.HARNESS_ADMIN_DATABASE_URL = db.adminDsn;
  process.env.HARNESS_DATABASE_URL = db.appDsn;
  _resetUrlCacheForTests();
  await _resetForTests();
}, 180000);

afterAll(async () => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  _resetUrlCacheForTests();
  await _resetForTests();
  await db?.cleanup();
});

describe('debug', () => {
  it('inspects payload + which DB getOrgPg sees', async () => {
    await db.adminSql`INSERT INTO harness_shared.engineer_issues (workspace_id, issue_id, title, state, payload, created_at, updated_at) VALUES ('default','EI-DBG','t','open', ${JSON.stringify({watchdogKey:'wd:dbg'})}::jsonb, now(), now())`;
    const viaSeed = await db.adminSql`SELECT issue_id, payload, payload ? 'watchdogKey' as has_key, payload->>'watchdogKey' as key, current_database() as db FROM harness_shared.engineer_issues WHERE issue_id='EI-DBG'`;
    // eslint-disable-next-line no-console
    console.log('DBG viaSeed=', JSON.stringify(viaSeed));
    const { sql } = getOrgPg();
    const viaOrg = await sql`SELECT issue_id, payload, payload ? 'watchdogKey' as has_key, current_database() as db FROM harness_shared.engineer_issues WHERE issue_id='EI-DBG'`;
    // eslint-disable-next-line no-console
    console.log('DBG viaOrg=', JSON.stringify(viaOrg));
    expect(true).toBe(true);
  });
});
