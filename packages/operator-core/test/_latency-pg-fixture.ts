/** LATENCY-M1 preparation in an owned migrated test database. No task timings. */
import { createOrgTestDb, type OrgTestDb } from './_org-test-db';
import { latencyDataFixtures, latencyFixtureDigest } from './_latency-acceptance';

export async function createLatencyPgFixture() {
  const db = await createOrgTestDb();
  try {
    const fixture = latencyDataFixtures();
    await seedLatencyPgFixture(db, fixture);
    return { db, fixture, sha256: latencyFixtureDigest(fixture), cleanup: db.cleanupWithResult };
  } catch (error) {
    await db.cleanup();
    throw error;
  }
}

async function seedLatencyPgFixture(db: OrgTestDb, fixture: ReturnType<typeof latencyDataFixtures>) {
  const sql = db.adminSql;
  const [identity] = await sql<{ name: string }[]>`SELECT current_database() AS name`;
  if (identity?.name !== db.dbName || !db.dbName.startsWith('org_')) {
    throw new Error('LATENCY-M1 refuses a database outside its owned org test fixture');
  }
  await sql.begin(async tx => {
    await tx`INSERT INTO harness_shared.work_items
      (workspace_id, harness_slug, feature_id, item_kind, status, title, summary, payload, created_ts, updated_ts)
      SELECT workspace_id, harness_slug, feature_id, item_kind, status, title, summary, payload, created_ts, updated_ts
      FROM jsonb_to_recordset(${JSON.stringify(fixture.workItems)}::jsonb) AS r(
        workspace_id text, harness_slug text, feature_id text, item_kind text, status text,
        title text, summary text, payload jsonb, created_ts bigint, updated_ts bigint)`;
    await tx`INSERT INTO harness_shared.coord_links
      (workspace_id, src_kind, src_ref, dst_kind, dst_ref, rel, created_at)
      SELECT workspace_id, src_kind, src_ref, dst_kind, dst_ref, rel, created_at
      FROM jsonb_to_recordset(${JSON.stringify(fixture.coverageEdges)}::jsonb) AS r(
        workspace_id text, src_kind text, src_ref text, dst_kind text, dst_ref text, rel text, created_at timestamptz)`;
    await tx`INSERT INTO harness_shared.coord_event_log (workspace_id, surface, writer_key, msg_id, body, ts)
      SELECT ${fixture.workspace}, 'messages', body->>'from', body->>'msg_id', body, (body->>'ts')::timestamptz
      FROM jsonb_array_elements(${JSON.stringify(fixture.conditionEnvelopes)}::jsonb) AS r(body)`;
  });
}
