import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { createLatencyPgFixture, seedLatencyTimelineSnapshot,
  type LatencyTimelineSnapshot } from '../../../test/_latency-pg-fixture';
import { latencyFixtureDigest, latencyRetrievalFixtures, observeLatencyRetrievalSchedule } from '../../../test/_latency-acceptance';
import { interactiveEmbedAcquireBudgetMs } from '../search/embedder';

const conditionScope = vi.hoisted(() => ({ sql: undefined as postgres.Sql | undefined, workspace: '' }));
vi.mock('@papercusp/db-org', async importOriginal => ({
  ...await importOriginal<typeof import('@papercusp/db-org')>(),
  getOrgPg: () => {
    if (!conditionScope.sql) throw new Error('LATENCY-M1 coverage reader requires its private PG fixture');
    return { sql: conditionScope.sql };
  },
}));
vi.mock('../coordination/log', async importOriginal => ({
  ...await importOriginal<typeof import('../coordination/log')>(),
  coordHasPgFastPath: () => true,
  coordSql: () => {
    if (!conditionScope.sql) throw new Error('LATENCY-M1 condition reader requires its private PG fixture');
    return conditionScope.sql;
  },
  coordWorkspaceId: () => conditionScope.workspace,
}));
import { computeConditionStates, readConditionEnvelopesForPrefix } from '../coordination/condition-state';
import { listCoveredPlanItemRefs } from '../../plan-items/convert';

describe('LATENCY-M1 private migrated fixture preparation', () => {
  let fx: Awaited<ReturnType<typeof createLatencyPgFixture>> | undefined;
  beforeAll(async () => {
    fx = await createLatencyPgFixture();
    conditionScope.sql = fx.db.adminSql;
    conditionScope.workspace = fx.fixture.workspace;
  }, 180_000);
  afterAll(async () => {
    conditionScope.sql = undefined;
    conditionScope.workspace = '';
    if (fx) expect(await fx.cleanup()).toBe('dropped');
  }, 60_000);

  it('replays stored timeline columns exactly and rolls back generated-value or schema drift', async () => {
    const { db, fixture } = fx!;
    const owner = 'su-latency-seed-control';
    const window = { owner, since: '2026-11-06T00:00:00.000Z', until: '2026-11-06T00:01:00.000Z' };
    const snapshot: LatencyTimelineSnapshot = await db.adminSql.begin(async tx => {
      await tx`SET LOCAL TIME ZONE 'UTC'`;
      const [turn] = await tx<{ row: Record<string, unknown> }[]>`INSERT INTO harness_shared.session_turns AS s
      (workspace_id, source_kind, session_id, turn_idx, ts, owner, speaker, text, ingested_at)
      VALUES ('default', 'codex', ${owner}, 1, ${window.since}, ${owner}, 'assistant',
        'Original é🧪 timeline input', ${window.since}) RETURNING to_jsonb(s) AS row`;
      const [call] = await tx<{ row: Record<string, unknown> }[]>`INSERT INTO harness_shared.tool_invocations AS t
      (workspace_id, harness_slug, plugin_name, tool_name, role, spawn_id, window_key, status,
        coord_owner_id, invoked_at, duration_ms, metadata_json)
      VALUES ('source-workspace', 'papercusp', 'test', 'coord:inbox', 'worker', ${owner}, ${owner},
        'ok', ${owner}, ${window.since}, 7, '{"original":[1,null,"é🧪"]}'::jsonb)
      RETURNING to_jsonb(t) AS row`;
      const [message] = await tx<{ row: Record<string, unknown> }[]>`INSERT INTO harness_shared.coord_event_log AS c
      (workspace_id, surface, writer_key, msg_id, body, ts)
      VALUES ('source-workspace', 'messages', ${owner}, 'latency-seed-message',
        ${JSON.stringify({ from: owner, summary: 'Original source' })}::text::jsonb, ${window.since})
      RETURNING to_jsonb(c) AS row`;
      return { window, turns: [turn!], tools: [call!], coord: [message!] };
    });
    await db.adminSql`DELETE FROM harness_shared.session_turns WHERE owner = ${owner}`;
    await db.adminSql`DELETE FROM harness_shared.tool_invocations WHERE coord_owner_id = ${owner}`;
    await db.adminSql`DELETE FROM harness_shared.coord_event_log WHERE msg_id = 'latency-seed-message'`;
    const seed = (value: LatencyTimelineSnapshot, expectedSha256 = latencyFixtureDigest(value)) =>
      seedLatencyTimelineSnapshot(db, { snapshot: value, expectedSha256, workspaceId: fixture.workspace });
    await expect(seed(snapshot, '0'.repeat(64))).rejects.toThrow(/fingerprint/);
    const unknownColumn = structuredClone(snapshot);
    unknownColumn.tools[0]!.row.unknown_original_column = 'must not disappear';
    await expect(seed(unknownColumn)).rejects.toThrow(/schema differs/);
    expect(await db.adminSql`SELECT 1 FROM harness_shared.session_turns WHERE owner = ${owner}`).toHaveLength(0);
    const generated = structuredClone(snapshot);
    generated.turns[0]!.row.text_tsv = 'wrong generated value';
    await expect(seed(generated)).rejects.toThrow(/readback differs/);
    expect(await db.adminSql`SELECT 1 FROM harness_shared.session_turns WHERE owner = ${owner}`).toHaveLength(0);
    await expect(seedLatencyTimelineSnapshot({ ...db, dbName: 'not-owned' }, {
      snapshot, expectedSha256: latencyFixtureDigest(snapshot), workspaceId: fixture.workspace,
    })).rejects.toThrow(/owned org test fixture/);
    const receipt = await seed(snapshot);
    expect(receipt.tables.map(row => row.count)).toEqual([1, 1, 1]);
    expect(snapshot.turns[0]!.row.workspace_id).toBe('default');
    expect(snapshot.tools[0]!.row.workspace_id).toBe('source-workspace');
    expect((await db.adminSql`SELECT workspace_id FROM harness_shared.session_turns WHERE owner = ${owner}`)[0]!.workspace_id).toBe('default');
    expect((await db.adminSql`SELECT workspace_id FROM harness_shared.tool_invocations WHERE coord_owner_id = ${owner}`)[0]!.workspace_id).toBe(fixture.workspace);
  });

  // CI always runs the synthetic schema/round-trip controls above. An explicit
  // evidence run also replays the separately retained original corpus; no live
  // database or network fetch can replace these pinned input files.
  const sourceRoot = process.env.PAPERCUSP_LATENCY_TIMELINE_SOURCE_DIR;
  if (sourceRoot) it('replays the exact canonical W1/W2/W3 stored inputs in the private database', async () => {
    const { db, fixture } = fx!;
    const manifest = JSON.parse(readFileSync(join(sourceRoot, 'timeline-source-inputs-20261109-r1--manifest.json'), 'utf8'));
    expect(manifest.windows.map((row: { id: string }) => row.id)).toEqual(['W1', 'W2', 'W3']);
    const receipts = [];
    for (const input of manifest.windows) {
      const bytes = readFileSync(join(sourceRoot, `timeline-source-inputs-20261109-r1--${input.id}.json`));
      expect(bytes.length).toBe(input.bytes);
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(input.sha256);
      const snapshot: LatencyTimelineSnapshot = JSON.parse(bytes.toString('utf8'));
      expect(snapshot.window).toEqual({ owner: input.owner, since: input.since, until: input.until });
      expect(Object.fromEntries(['turns', 'tools', 'coord'].map(key =>
        [key, snapshot[key as 'turns'].length]))).toEqual(input.sourceRows);
      receipts.push(await seedLatencyTimelineSnapshot(db, { snapshot,
        expectedSha256: latencyFixtureDigest(snapshot), workspaceId: fixture.workspace }));
    }
    const receipt = { phase: 'preparation-only', actualTaskAttempts: 0, receipts };
    const artifactDir = process.env.PAPERCUSP_TEST_ARTIFACT_DIR;
    if (artifactDir) {
      mkdirSync(artifactDir, { recursive: true });
      writeFileSync(join(artifactDir, 'latency-original-timeline-seed.json'), JSON.stringify(receipt), { flag: 'wx' });
    }
    console.info('LATENCY_ORIGINAL_TIMELINE_SEED ' + JSON.stringify(receipt));
  }, 90_000);

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
    const surfaces = await db.adminSql`SELECT DISTINCT surface FROM harness_shared.coord_event_log
      WHERE workspace_id = ${fixture.workspace}`;
    expect(surfaces.map(row => row.surface)).toEqual(['messages']);
    const edges = await db.adminSql`SELECT workspace_id, src_kind, src_ref, dst_kind, dst_ref, rel,
      to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at
      FROM harness_shared.coord_links WHERE workspace_id = ${fixture.workspace} ORDER BY src_ref`;
    expect(JSON.parse(JSON.stringify(edges))).toEqual(fixture.coverageEdges);
    const [identity] = await db.adminSql`SELECT current_database() AS name`;
    expect(identity?.name).toBe(db.dbName);
  });

  it('exercises the actual prefix reader on the seeded message surface and retains old-hold discrepancies', async () => {
    const { fixture } = fx!;
    const observations = [];
    // Keep the frozen recent controls recent on every future CI run. The
    // thirty-day-old holds stay old; no production retention value changes.
    const effectiveNowMs = fixture.anchorMs + 86_400_000;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(effectiveNowMs);
    try {
      for (const [prefix, reference] of Object.entries(fixture.conditionReference)) {
        const startedAtMs = performance.now();
        const envelopes = await readConditionEnvelopesForPrefix(prefix);
        const completedAtMs = performance.now();
        // A surface mismatch must fail even if an empty observed hold set looks
        // like the known age-filter defect. Require a real recent source row.
        expect(envelopes.length).toBeGreaterThan(0);
        expect(envelopes.every(row => [row.condition_key, row.resolves_condition,
          ...(Array.isArray(row.resolves_conditions) ? row.resolves_conditions : [])]
          .some(key => typeof key === 'string' && key.startsWith(prefix)))).toBe(true);
        const observedOpen = computeConditionStates(envelopes).filter(row => row.open)
          .map(row => row.condition_key).sort();
        observations.push({ prefix, sourceRows: envelopes.length, startedAtMs, completedAtMs,
          durationMs: completedAtMs - startedAtMs, observedOpen, reference,
          missing: reference.filter(key => !observedOpen.includes(key)),
          extra: observedOpen.filter(key => !reference.includes(key)) });
      }
    } finally {
      clock.mockRestore();
    }
    const receipt = { phase: 'preparation-only', actualTaskAttempts: 0,
      sourcePlane: 'actual condition prefix reader with private migrated PG seam and frozen Date.now; not bg-host',
      effectiveNowMs,
      fixtureSha256: latencyFixtureDigest(fixture), observedAt: new Date().toISOString(), observations };
    const artifactDir = process.env.PAPERCUSP_TEST_ARTIFACT_DIR;
    if (artifactDir) {
      mkdirSync(artifactDir, { recursive: true });
      writeFileSync(join(artifactDir, 'latency-condition-observations.json'), JSON.stringify(receipt), { flag: 'wx' });
    }
    console.info('LATENCY_CONDITION_PREPARATION ' + JSON.stringify(receipt));
  });

  it('calibrates actual typed and legacy coverage reads without hiding scope discrepancies or mutating fixtures', async () => {
    const { db, fixture } = fx!;
    const snapshot = () => db.adminSql`SELECT
      (SELECT count(*)::int FROM harness_shared.work_items) AS work_items,
      (SELECT md5(string_agg(to_jsonb(w)::text, '' ORDER BY feature_id, workspace_id, harness_slug))
        FROM harness_shared.work_items w) AS work_items_md5,
      (SELECT count(*)::int FROM harness_shared.coord_links) AS links,
      (SELECT md5(string_agg(to_jsonb(e)::text, '' ORDER BY src_ref, dst_ref))
        FROM harness_shared.coord_links e) AS links_md5`;
    const before = await snapshot();
    expect(before[0]?.work_items).toBe(10_000);
    expect(before[0]?.links).toBe(fixture.coverageEdges.length);
    const observations = [];
    for (const reference of fixture.coverageReference) {
      const startedAtMs = performance.now();
      const observed = [...await listCoveredPlanItemRefs(fixture.plan, fixture.harness,
        [reference.item], [fixture.workspace])].sort();
      const completedAtMs = performance.now();
      const repeated = [...await listCoveredPlanItemRefs(fixture.plan, fixture.harness,
        [reference.item], [fixture.workspace])].sort();
      expect(repeated).toEqual(observed);
      const expected = reference.eligibleIds.length ? [`${fixture.plan}#${reference.item}`] : [];
      observations.push({ case: reference.case, item: reference.item, eligibleIds: reference.eligibleIds,
        expected, observed, repeated, startedAtMs, completedAtMs, durationMs: completedAtMs - startedAtMs,
        missing: expected.filter(ref => !observed.includes(ref)),
        extra: observed.filter(ref => !expected.includes(ref)) });
    }
    // Ordinary typed/legacy positives prove the real reader reached the fixture;
    // separate scope controls retain its actual result, including any defect.
    for (const name of ['typed-only', 'legacy-only', 'mixed', 'terminal', 'exact-boundary']) {
      const row = observations.find(observation => observation.case === name)!;
      expect(row.observed).toContain(`${fixture.plan}#${row.item}`);
    }
    expect([...await listCoveredPlanItemRefs(fixture.plan, fixture.harness, [], [fixture.workspace])]).toEqual([]);
    expect(await snapshot()).toEqual(before);
    const receipt = { phase: 'preparation-only', actualTaskAttempts: 0,
      sourcePlane: 'actual promotion coverage reader with private migrated PG seam; not bg-host',
      observationKind: 'covered plan-item refs; eligible target IDs are independent references, not observed target receipts',
      fixtureSha256: latencyFixtureDigest(fixture), observedAt: new Date().toISOString(), observations };
    const artifactDir = process.env.PAPERCUSP_TEST_ARTIFACT_DIR;
    if (artifactDir) {
      mkdirSync(artifactDir, { recursive: true });
      writeFileSync(join(artifactDir, 'latency-coverage-observations.json'), JSON.stringify(receipt), { flag: 'wx' });
    }
    console.info('LATENCY_COVERAGE_PREPARATION ' + JSON.stringify(receipt));
  });

  it('retains real-clock retrieval observations and diagnoses late results without certifying a baseline', async () => {
    const budgetMs = interactiveEmbedAcquireBudgetMs();
    // The already-frozen input budget is a constraint, never a runtime override.
    expect(budgetMs).toBe(4_000);
    const fixtures = latencyRetrievalFixtures(budgetMs);
    const observations = [];
    for (const schedule of fixtures.cases) {
      const observation = await observeLatencyRetrievalSchedule(schedule);
      observations.push(observation);
      expect(observation.safetyDeadlineFired).toBe(false);
      expect(observation.marks.terminalMs).toBeGreaterThanOrEqual(0);
      if (['synchronous-entry-block', 'late-timer', 'late-success'].includes(schedule.id)) {
        expect(observation.marks.resultAtMs).toBeGreaterThan(budgetMs);
      }
      if (schedule.id === 'lexical-fallback') {
        expect(observation.embeddingAccepted).toBe(false);
        expect(observation.fallback).toBe(schedule.lexicalFallbackId);
      }
      if ('abortAtMs' in schedule) {
        expect(observation.callerAborted).toBe(true);
        expect(observation.cancellation).toBe(schedule.expected.cancellation);
        expect(observation.error).toBe('latency-fixture-caller-abort');
      }
    }
    const receipt = { phase: 'preparation-only', actualTaskAttempts: 0,
      budgetMs, budgetEnvironment: process.env.PAPERCUSP_QUERY_EMBED_ACQUIRE_BUDGET_MS ?? null,
      fixtureSha256: latencyFixtureDigest(fixtures), observations };
    const artifactDir = process.env.PAPERCUSP_TEST_ARTIFACT_DIR;
    if (artifactDir) {
      mkdirSync(artifactDir, { recursive: true });
      writeFileSync(join(artifactDir, 'latency-retrieval-observations.json'), JSON.stringify(receipt), { flag: 'wx' });
    }
    console.info('LATENCY_RETRIEVAL_PREPARATION ' + JSON.stringify(receipt));
  }, 90_000);
});
