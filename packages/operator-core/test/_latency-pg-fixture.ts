/** LATENCY-M1 preparation in an owned migrated test database. No task timings. */
import { createOrgTestDb, type CreateOrgTestDbOptions, type OrgTestDb } from './_org-test-db';
import { latencyDataFixtures, latencyFixtureDigest } from './_latency-acceptance';

export interface LatencyTimelineSnapshot {
  window: { owner: string; since: string; until: string };
  turns: Array<{ row: Record<string, unknown> }>;
  tools: Array<{ row: Record<string, unknown> }>;
  coord: Array<{ row: Record<string, unknown> }>;
}

/** Replay stored inputs, never a timeline projection or an expected answer.
 * All original columns (including generated values) must round-trip exactly.
 * Only workspace_id is rehomed; legacy default-workspace turns stay default.
 * The transaction rolls back on schema, generated-value or identity drift. */
export async function seedLatencyTimelineSnapshot(db: OrgTestDb, input: {
  snapshot: LatencyTimelineSnapshot; expectedSha256: string; workspaceId: string;
}) {
  const { snapshot, workspaceId } = input;
  if (!workspaceId.trim() || workspaceId === 'default'
    || latencyFixtureDigest(snapshot) !== input.expectedSha256
    || !snapshot.window.owner.trim()
    || !(Date.parse(snapshot.window.until) > Date.parse(snapshot.window.since))) {
    throw new Error('LATENCY-M1 invalid frozen timeline input or fingerprint');
  }
  const sql = db.adminSql;
  const [identity] = await sql`SELECT current_database() AS name`;
  if (identity?.name !== db.dbName || !db.dbName.startsWith('org_')) {
    throw new Error('LATENCY-M1 refuses a database outside its owned org test fixture');
  }
  return sql.begin(async tx => {
    await tx`SET LOCAL TIME ZONE 'UTC'`;
    const receipts = [];
    for (const [key, table] of [['turns', 'session_turns'], ['tools', 'tool_invocations'],
      ['coord', 'coord_event_log']] as const) {
      const rows: Record<string, unknown>[] = snapshot[key].map(({ row }) => ({ ...row,
        workspace_id: key === 'turns' && row.workspace_id === 'default' ? 'default' : workspaceId }));
      if (!rows.length) { receipts.push({ table, count: 0 }); continue; }
      if (rows.length > 10_000) throw new Error('LATENCY-M1 timeline source exceeds its frozen bound');
      const columns = Object.keys(rows[0]!).sort();
      const schema = await tx<{ column_name: string; is_generated: string; generation_expression: string | null }[]>`
        SELECT column_name, is_generated, generation_expression FROM information_schema.columns
        WHERE table_schema = 'harness_shared' AND table_name = ${table} ORDER BY column_name`;
      if (latencyFixtureDigest(columns) !== latencyFixtureDigest(schema.map(row => row.column_name))
        || rows.some(row => latencyFixtureDigest(Object.keys(row).sort()) !== latencyFixtureDigest(columns))) {
        throw new Error(`LATENCY-M1 frozen ${table} schema differs; no columns may be dropped or invented`);
      }
      // Names come only from the three literal tables and validated PG columns.
      const writable = schema.filter(row => row.is_generated === 'NEVER').map(row => row.column_name);
      const quote = (name: string) => '"' + name.replaceAll('"', '""') + '"';
      const names = writable.map(quote).join(', ');
      const target = `harness_shared.${quote(table)}`;
      const stored = await tx.unsafe<{ row: Record<string, unknown> }[]>(
        `INSERT INTO ${target} AS seeded (${names}) OVERRIDING SYSTEM VALUE
         SELECT ${names} FROM jsonb_populate_recordset(NULL::${target}, $1::text::jsonb)
         RETURNING to_jsonb(seeded) AS row`, [JSON.stringify(rows)]);
      if (stored.length !== rows.length || stored.some((row, i) =>
        latencyFixtureDigest(row.row) !== latencyFixtureDigest(rows[i]))) {
        const differences = stored.flatMap(({ row }, index) => columns.filter(column =>
          latencyFixtureDigest(row[column]) !== latencyFixtureDigest(rows[index]?.[column]))
          .map(column => ({ index, column,
            expectedSha256: latencyFixtureDigest(rows[index]?.[column]),
            actualSha256: latencyFixtureDigest(row[column]) })));
        throw new Error(`LATENCY-M1 frozen ${table} readback differs, including generated columns: ${JSON.stringify(differences)}`);
      }
      receipts.push({ table, count: rows.length, columns,
        generated: schema.filter(row => row.is_generated !== 'NEVER'),
        schemaSha256: latencyFixtureDigest(schema), sourceSha256: latencyFixtureDigest(snapshot[key]),
        privateRowsSha256: latencyFixtureDigest(stored), allFieldsExact: true });
    }
    return { phase: 'preparation-only', actualTaskAttempts: 0, database: db.dbName, workspaceId,
      window: snapshot.window, sourceSha256: input.expectedSha256,
      transformation: 'workspace_id only; legacy default-workspace turns unchanged', tables: receipts };
  });
}

export async function createLatencyPgFixture(options: CreateOrgTestDbOptions = {}) {
  const db = await createOrgTestDb(options);
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
