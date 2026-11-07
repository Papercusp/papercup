import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLatencyPgFixture } from '../../../test/_latency-pg-fixture';
import { latencyFixtureDigest } from '../../../test/_latency-acceptance';

describe('LATENCY-M1 private migrated fixture preparation', () => {
  let fx: Awaited<ReturnType<typeof createLatencyPgFixture>> | undefined;
  beforeAll(async () => { fx = await createLatencyPgFixture(); }, 180_000);
  afterAll(async () => {
    if (fx) expect(await fx.cleanup()).toBe('dropped');
  }, 60_000);

  it('round-trips every frozen work-item field, including scope and adjacent-marker controls', async () => {
    const { db, fixture } = fx!;
    const rows = await db.adminSql`SELECT feature_id, workspace_id, harness_slug, item_kind, status,
      title, summary, payload, created_ts, updated_ts FROM harness_shared.work_items
      WHERE feature_id LIKE 'WI-800%' ORDER BY feature_id`;
    expect(rows).toHaveLength(10_000);
    expect(JSON.parse(JSON.stringify(rows))).toEqual(fixture.workItems);
    expect(latencyFixtureDigest(JSON.parse(JSON.stringify(rows)))).toBe(latencyFixtureDigest(fixture.workItems));
  });

  it('preserves the complete condition history and exact coverage edges without production writes', async () => {
    const { db, fixture } = fx!;
    const rows = await db.adminSql`SELECT body FROM harness_shared.coord_event_log
      WHERE workspace_id = ${fixture.workspace} ORDER BY msg_id`;
    expect(rows).toHaveLength(10_000);
    expect(rows.map(row => row.body)).toEqual(fixture.conditionEnvelopes);
    const edges = await db.adminSql`SELECT workspace_id, src_kind, src_ref, dst_kind, dst_ref, rel,
      to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at
      FROM harness_shared.coord_links WHERE workspace_id = ${fixture.workspace} ORDER BY src_ref`;
    expect(JSON.parse(JSON.stringify(edges))).toEqual(fixture.coverageEdges);
    const [identity] = await db.adminSql`SELECT current_database() AS name`;
    expect(identity?.name).toBe(db.dbName);
  });
});
