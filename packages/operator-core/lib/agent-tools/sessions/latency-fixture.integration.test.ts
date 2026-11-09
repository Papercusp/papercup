import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { gunzipSync } from 'node:zlib';
import { createLatencyPgFixture, seedLatencyTimelineSnapshot,
  type LatencyTimelineSnapshot } from '../../../test/_latency-pg-fixture';
import { calibrateLatencyOracle, frozenOutputOracle, latencyFixtureDigest, latencyIntervalReference,
  latencyBenchAssignments, latencyRetrievalFixtures, observeLatencyRetrievalSchedule,
  type LatencyReferenceInterval } from '../../../test/_latency-acceptance';
import { interactiveEmbedAcquireBudgetMs } from '../search/embedder';
import type { PapercuspUnifiedToolContext } from '../_tool-context';
import timelineTool, { timelineResultSchema } from './timeline';
import { benchFixtureBoundarySchema, readBenchFixtureSourceSnapshot, requireBenchFixturePreflight,
  requireBenchFixtureSourcePins } from '../../external-bench/private-fixture-reads';
import { restoreBenchmarkContext, readRestoredBenchmarkContext,
  type BenchmarkContextInput } from '../../external-bench/reproducibility/context';
import { canonicalJson } from '../../external-bench/reproducibility/canonical-json';

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
  const sourceRoot = process.env.PAPERCUSP_LATENCY_TIMELINE_SOURCE_DIR;
  let fx: Awaited<ReturnType<typeof createLatencyPgFixture>> | undefined;
  let timelineWorkspace: string;
  const assertConditionScope = async () => {
    const { db, fixture } = fx!;
    const rows = await db.adminSql`SELECT body FROM harness_shared.coord_event_log
      WHERE workspace_id = ${fixture.workspace} ORDER BY msg_id`;
    expect(rows).toHaveLength(10_000);
    expect(rows.map(row => row.body)).toEqual(fixture.conditionEnvelopes);
  };
  beforeAll(async () => {
    // The frozen source's generated English tsvectors require its database
    // ctype. The default portable C fixture changes Unicode tokenization.
    fx = await createLatencyPgFixture(sourceRoot ? { locale: 'en_US.UTF-8' } : {});
    timelineWorkspace = fx.fixture.workspace + '-timeline';
    expect(timelineWorkspace).not.toBe(fx.fixture.workspace);
    conditionScope.sql = fx.db.adminSql;
    conditionScope.workspace = fx.fixture.workspace;
    await assertConditionScope();
  }, 180_000);
  afterAll(async () => {
    conditionScope.sql = undefined;
    conditionScope.workspace = '';
    if (fx) expect(await fx.cleanup()).toBe('dropped');
  }, 60_000);

  it('replays stored timeline columns exactly and rolls back generated-value or schema drift', async () => {
    const { db } = fx!;
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
      seedLatencyTimelineSnapshot(db, { snapshot: value, expectedSha256, workspaceId: timelineWorkspace });
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
      snapshot, expectedSha256: latencyFixtureDigest(snapshot), workspaceId: timelineWorkspace,
    })).rejects.toThrow(/owned org test fixture/);
    const receipt = await seed(snapshot);
    expect(receipt.tables.map(row => row.count)).toEqual([1, 1, 1]);
    expect(snapshot.turns[0]!.row.workspace_id).toBe('default');
    expect(snapshot.tools[0]!.row.workspace_id).toBe('source-workspace');
    expect((await db.adminSql`SELECT workspace_id FROM harness_shared.session_turns WHERE owner = ${owner}`)[0]!.workspace_id).toBe('default');
    expect((await db.adminSql`SELECT workspace_id FROM harness_shared.tool_invocations WHERE coord_owner_id = ${owner}`)[0]!.workspace_id).toBe(timelineWorkspace);
    expect((await db.adminSql`SELECT workspace_id FROM harness_shared.coord_event_log
      WHERE msg_id = 'latency-seed-message'`)[0]!.workspace_id).toBe(timelineWorkspace);
    await assertConditionScope();
  });

  // This explicit evidence case exercises the maintained host preflight and
  // physical context boundary. It neither launches a provider nor qualifies a
  // loaded host runtime; those remain separate baseline prerequisites.
  if (sourceRoot && process.env.PAPERCUSP_LATENCY_NATIVE_INPUTS_FILE) it(
    'binds original timeline inputs to frozen solver context and host read boundaries', async () => {
      const artifactDir = process.env.PAPERCUSP_TEST_ARTIFACT_DIR;
      if (!artifactDir?.trim()) throw new Error('Original timeline context evidence requires PAPERCUSP_TEST_ARTIFACT_DIR before allocation');
      const bindingFx = await createLatencyPgFixture({ locale: 'en_US.UTF-8' });
      const { db } = bindingFx, workspaceId = timelineWorkspace;
      const root = mkdtempSync(join(tmpdir(), 'latency-timeline-context-'));
      const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
      try {
        const sourceManifest = JSON.parse(readFileSync(join(sourceRoot,
          'timeline-source-inputs-20261109-r1--manifest.json'), 'utf8'));
        const taskManifest = JSON.parse(readFileSync(join(sourceRoot, 'benchmark-task-manifest.json'), 'utf8'));
        const nativeInputs = JSON.parse(readFileSync(process.env.PAPERCUSP_LATENCY_NATIVE_INPUTS_FILE!, 'utf8'));
        const windows: Record<string, LatencyTimelineSnapshot['window']> = {};
        const entries: Array<{ key: string; text: string }> = [];
        const rawReceipts = [];
        for (const input of sourceManifest.windows) {
          const bytes = readFileSync(join(sourceRoot, `timeline-source-inputs-20261109-r1--${input.id}.json`));
          expect(bytes.length).toBe(input.bytes);
          expect(hash(bytes)).toBe(input.sha256);
          const snapshot: LatencyTimelineSnapshot = JSON.parse(bytes.toString('utf8'));
          windows[input.id] = snapshot.window;
          await seedLatencyTimelineSnapshot(db, { snapshot, workspaceId,
            expectedSha256: latencyFixtureDigest(snapshot) });
          const selected = taskManifest.windows.find((row: { id: string }) => row.id === input.id);
          const envelope = nativeInputs.find((row: { window: { id: string } }) => row.window.id === input.id);
          const zipped = Buffer.from(envelope.data, 'base64'), raw = gunzipSync(zipped);
          expect(hash(zipped)).toBe(envelope.compressedSha256);
          expect(raw.length).toBe(selected.sourceBytes);
          expect(hash(raw)).toBe(selected.sourceSha256);
          const intervalEnvelope = JSON.parse(readFileSync(join(sourceRoot, `${input.id}-interval-source-v2.json`), 'utf8'));
          const intervalBytes = gunzipSync(Buffer.from(intervalEnvelope.data, 'base64'));
          expect(hash(intervalBytes)).toBe(intervalEnvelope.uncompressedSha256);
          const intervalSource = JSON.parse(intervalBytes.toString('utf8'));
          // The complete pinned raw file is input data. Its selected half-open
          // window governs replay; do not inject parsed operations, interval
          // partitions, gap verdicts or independentReference into the context.
          const rawSource = { window: snapshot.window, session: selected.session,
            sourceSha256: selected.sourceSha256, sourceBytes: selected.sourceBytes,
            replay: 'Replay only the declared half-open window; retain malformed records and missing evidence.',
            nativeJsonl: raw.toString('utf8'), gatewayRows: intervalSource.gatewayRows };
          entries.push({ key: `latency-raw:${input.id}`, text: canonicalJson(rawSource) });
          rawReceipts.push({ id: input.id, nativeSha256: hash(raw), nativeBytes: raw.length,
            contextSourceSha256: hash(canonicalJson(rawSource)) });
        }
        const decodeControl = JSON.parse(readFileSync(join(sourceRoot,
          'W1-with-overlap-control-interval-source-v2.json'), 'utf8'));
        const controlBytes = gunzipSync(Buffer.from(decodeControl.data, 'base64'));
        expect(hash(controlBytes)).toBe(decodeControl.uncompressedSha256);
        const control = JSON.parse(controlBytes.toString('utf8'));
        const declaredControls = control.intervals.filter((row: { id: string }) => row.id.startsWith('control:'));
        expect(declaredControls.map((row: { id: string }) => row.id))
          .toEqual(['control:model', 'control:tool', 'control:stage', 'control:next']);
        entries.push({ key: 'latency-raw:W1-with-overlap-control', text: canonicalJson({
          originalInput: 'W1', declaration: control.controlDeclaration, declaredControls }) });
        const corpus = canonicalJson({ entries }), memory = canonicalJson({ entries: [] });
        const snapshots = join(root, 'snapshots'); mkdirSync(snapshots);
        writeFileSync(join(snapshots, 'corpus.json'), corpus, { flag: 'wx' });
        writeFileSync(join(snapshots, 'memory.json'), memory, { flag: 'wx' });
        const context = { corpusRef: 'corpus.json', memoryRef: 'memory.json', corpusHash: hash(corpus),
          memoryHash: hash(memory), isolation: 'fresh-per-assignment' as const,
          forbiddenSources: ['other-arm-solutions', 'hidden-grader-answers'] };
        const cases = { 'LATENCY-M1:T04': { A: windows.W1!, B: windows.W1! },
          'LATENCY-M1:T05': { A: windows.W2!, B: windows.W3! } };
        const fixtureSha256 = hash(canonicalJson(cases)), bindings = [];
        for (const taskId of ['LATENCY-M1:T04', 'LATENCY-M1:T05'] as const) {
          const task = latencyBenchAssignments(taskManifest).find(row => row.task.instanceId === taskId)!.task;
          const boundary = benchFixtureBoundarySchema.parse({ workspaceId, runId: 'latency-context-preparation',
            preregHash: hash(canonicalJson(taskManifest)), assignmentId: `bench-assignment:${taskId}:preparation`,
            armId: 'cold', seed: 1, taskId, fixtureSha256, cases: cases[taskId] });
          const sourcePins = {} as NonNullable<typeof boundary.sourcePins>;
          for (const which of ['A', 'B'] as const) {
            const bytes = canonicalJson(await readBenchFixtureSourceSnapshot(boundary, which, { sql: db.adminSql, workspaceId }));
            sourcePins[which] = { sha256: hash(bytes), bytes: Buffer.byteLength(bytes) };
          }
          boundary.sourcePins = sourcePins;
          const oracle = (task.graderMeta.latencyM1 as { qualityOracle: unknown }).qualityOracle;
          // Only the selected task is read by preflight. This slice does not
          // claim a complete T01–T10 host allocation or its admission digest.
          const allocation = { verification: { [taskId]: { inputs: sourcePins,
            promptSha256: hash(task.problemStatement), oracleSha256: hash(canonicalJson(oracle)) } } };
          const preflight = () => requireBenchFixturePreflight(boundary,
            allocation as Parameters<typeof requireBenchFixturePreflight>[1], task,
            { sql: db.adminSql, workspaceId }, { context, snapshotRoot: snapshots });
          await preflight();
          const checkout = join(root, taskId.slice(-3)); mkdirSync(checkout);
          const restore: BenchmarkContextInput = { binding: { workspaceId, runId: boundary.runId,
            preregHash: boundary.preregHash, assignmentId: boundary.assignmentId, harnessSlug: 'papercusp' },
            context, checkout, snapshotRoot: snapshots };
          const receipt = restoreBenchmarkContext(restore);
          expect(readRestoredBenchmarkContext(restore)).toEqual(receipt);
          expect(readFileSync(receipt.corpusPath, 'utf8')).toBe(corpus);
          const originalSourcePin = { ...boundary.sourcePins.A };
          boundary.sourcePins.A.bytes++;
          await expect(requireBenchFixtureSourcePins(boundary, { sql: db.adminSql, workspaceId }))
            .rejects.toThrow(/source content or size/);
          boundary.sourcePins.A = originalSourcePin;
          const leaked = canonicalJson({ entries: [{ key: 'apparently-permitted', text: canonicalJson(oracle) }] });
          writeFileSync(join(snapshots, 'corpus.json'), leaked); context.corpusHash = hash(leaked);
          await expect(preflight()).rejects.toThrow(/hidden grading oracle/);
          writeFileSync(join(snapshots, 'corpus.json'), corpus); context.corpusHash = hash(corpus);
          await preflight();
          bindings.push({ boundary, verification: allocation.verification[taskId],
            restoredContext: { ...receipt, contextText: undefined } });
        }
        expect(bindings[0]!.boundary.sourcePins!.A).toEqual(bindings[0]!.boundary.sourcePins!.B);
        const conditionRows = await db.adminSql`SELECT body FROM harness_shared.coord_event_log
          WHERE workspace_id = ${bindingFx.fixture.workspace} ORDER BY msg_id`;
        expect(conditionRows).toHaveLength(10_000);
        expect(conditionRows.map(row => row.body)).toEqual(bindingFx.fixture.conditionEnvelopes);
        await assertConditionScope();
        mkdirSync(artifactDir, { recursive: true });
        for (const [name, value] of Object.entries({ 'timeline-solver-corpus.json': corpus,
          'timeline-solver-memory.json': memory, 'timeline-context-bindings.json': canonicalJson({
            phase: 'preparation-only', actualTaskAttempts: 0,
            scope: 'T04/T05 task boundaries and restored context only; full host allocation/runtime/native qualification remain pending.',
            fixtureSha256, context, rawReceipts, bindings }) }))
          writeFileSync(join(artifactDir, name), value, { flag: 'wx' });
      } finally {
        rmSync(root, { recursive: true, force: true });
        expect(await bindingFx.cleanup()).toBe('dropped');
      }
    }, 120_000);

  // CI always runs the synthetic schema/round-trip controls above. An explicit
  // evidence run also replays the separately retained original corpus; no live
  // database or network fetch can replace these pinned input files.
  if (sourceRoot) it('replays the exact canonical W1/W2/W3 stored inputs in the private database', async () => {
    const { db } = fx!;
    const manifest = JSON.parse(readFileSync(join(sourceRoot, 'timeline-source-inputs-20261109-r1--manifest.json'), 'utf8'));
    expect(manifest.windows.map((row: { id: string }) => row.id)).toEqual(['W1', 'W2', 'W3']);
    const receipts = [];
    const timelineReads = [];
    const [environment] = await db.adminSql`SELECT datctype, datcollate, version() AS version
      FROM pg_database WHERE datname = current_database()`;
    expect(environment).toMatchObject({ datctype: 'en_US.UTF-8', datcollate: 'en_US.UTF-8' });
    for (const input of manifest.windows) {
      const bytes = readFileSync(join(sourceRoot, `timeline-source-inputs-20261109-r1--${input.id}.json`));
      expect(bytes.length).toBe(input.bytes);
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(input.sha256);
      const snapshot: LatencyTimelineSnapshot = JSON.parse(bytes.toString('utf8'));
      expect(snapshot.window).toEqual({ owner: input.owner, since: input.since, until: input.until });
      expect(Object.fromEntries(['turns', 'tools', 'coord'].map(key =>
        [key, snapshot[key as 'turns'].length]))).toEqual(input.sourceRows);
      receipts.push(await seedLatencyTimelineSnapshot(db, { snapshot,
        expectedSha256: latencyFixtureDigest(snapshot), workspaceId: timelineWorkspace }));
      // Exercise the actual historical reader, not a projection built from
      // the expected answer. Its current source population must survive every
      // bounded continuation, including automatic calls and legacy turns.
      const ctx = { tx: db.adminSql, workspaceId: timelineWorkspace,
        uiClientId: 'su-latency-original-reader', role: 'worker', isSuperuser: true,
        principal: { slug: 'su-latency-original-reader', workspaceId: timelineWorkspace },
        signal: new AbortController().signal } as unknown as PapercuspUnifiedToolContext;
      const expectedRefs = [
        ...snapshot.turns.map(({ row }) => `turn:session_turn:${row.source_kind}:${row.session_id}:${row.turn_idx}`),
        ...snapshot.tools.map(({ row }) => `tool:${row.id}`),
        ...snapshot.coord.map(({ row }) => `coord:${row.msg_id}`),
      ].sort();
      const observedRefs: string[] = [], pages = [], cursors = new Set<string>();
      let cursor: string | undefined;
      do {
        const result = await timelineTool.handler(timelineTool.args.parse({ ...snapshot.window,
          limit: 300, include_auto: true, group_repeated: false, ...(cursor ? { cursor } : {}) }), ctx);
        if (!('content' in result) || result.content.length !== 1 || result.content[0]!.type !== 'text')
          throw new Error('Original timeline reader returned an unsupported envelope');
        const page = timelineResultSchema.parse(JSON.parse(result.content[0]!.text));
        if (!page.ok) throw new Error(`Original timeline read failed: ${JSON.stringify(page)}`);
        expect(page).toMatchObject({ ok: true, ...snapshot.window });
        observedRefs.push(...page.entries.map(row => `${row.kind}:${row.ref}`));
        pages.push(page);
        cursor = page.nextCursor;
        expect(!!cursor).toBe(page.hasMore);
        expect(pages.length).toBeLessThan(200);
        if (cursor) { expect(cursors.has(cursor)).toBe(false); cursors.add(cursor); }
      } while (cursor);
      expect(new Set(observedRefs).size).toBe(observedRefs.length);
      expect([...observedRefs].sort()).toEqual(expectedRefs);
      timelineReads.push({ id: input.id, window: snapshot.window, sourceRows: input.sourceRows,
        observedRefs, pages, complete: true,
        limitation: 'Indexed turns/tools/coord only; no native/gateway interval attribution is inferred from these entries.' });
    }
    await assertConditionScope();
    const decodeInterval = (id: string, kind: 'source' | 'reference') => {
      const bytes = readFileSync(join(sourceRoot, `${id}-interval-${kind}-v2.json`));
      const envelope = JSON.parse(bytes.toString('utf8'));
      const zipped = Buffer.from(envelope.data, 'base64');
      expect(createHash('sha256').update(zipped).digest('hex')).toBe(envelope.gzipSha256);
      const decoded = gunzipSync(zipped);
      expect(decoded.length).toBe(envelope.uncompressedBytes);
      expect(createHash('sha256').update(decoded).digest('hex')).toBe(envelope.uncompressedSha256);
      return JSON.parse(decoded.toString('utf8'));
    };
    const calibrations = [];
    for (const id of ['W1', 'W1-with-overlap-control', 'W2', 'W3']) {
      const source = decodeInterval(id, 'source'), saved = decodeInterval(id, 'reference');
      const recomputed = latencyIntervalReference(source.window, source.intervals);
      const reference = Object.fromEntries(Object.keys(recomputed).map(key => [key, saved.reference[key]]));
      expect(recomputed).toEqual(reference);
      if (id === 'W1-with-overlap-control') {
        const original = decodeInterval('W1', 'source');
        expect(source.intervals.slice(0, original.intervals.length)).toEqual(original.intervals);
        const controls: LatencyReferenceInterval[] = source.intervals.slice(original.intervals.length);
        expect(controls.map(row => [row.startMs - source.window.startMs, row.endMs - source.window.startMs]))
          .toEqual(source.controlDeclaration.relativeEndpointsMs);
        expect(controls.map(row => row.id)).toEqual(['control:model', 'control:tool', 'control:stage', 'control:next']);
        expect(controls[2]!.parentId).toBe('control:tool');
      }
      const calibration = calibrateLatencyOracle((observed, authorized) =>
        frozenOutputOracle(reference, observed, authorized), { positive: recomputed,
        incorrect: { ...recomputed, knownMs: recomputed.knownMs + 1 },
        incomplete: { ...recomputed, intervals: recomputed.intervals.slice(1) } });
      calibrations.push({ id, referenceSha256: latencyFixtureDigest(reference), calibration });
    }
    const receipt = { phase: 'preparation-only', actualTaskAttempts: 0, environment, receipts,
      sourcePlane: 'Actual sessions:timeline handler over privately replayed original indexed inputs; interval oracles remain separate test-only inputs.',
      timelineReads, calibrations };
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
