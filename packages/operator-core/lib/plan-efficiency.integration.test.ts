/**
 * plan-efficiency.integration.test.ts — review-system-rework-reduction-2026-09-23 P-032 guard.
 *
 * A fixture plan whose seeded tool_invocations rows are known exactly must come back from
 * readPlanEfficiency with category, failure, dropped-effort, holder and wall-clock counts that
 * match those rows — and every row that is NOT the plan's (observation-lane item, another plan's
 * item, a non-agent call, another workspace, a transcript part outside the corpus workspace or
 * outside the plan's window) must be excluded. Real Postgres via the org test fixture; the reader
 * takes its postgres-js client as an argument, so nothing is mocked.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OrgTestDb } from '../test/_org-test-db';

const { createOrgTestDb } = await import('../test/_org-test-db');
const { readPlanEfficiency, readWorkflowStepMeasurement } = await import('./plan-efficiency');
const { recordRubricCheckResults, readLatestRubricCheckResults } = await import('./check-results-ledger');
const { retainMeasurementProvenance } = await import('./measurement-provenance');

const WS = 'ws-plan-efficiency';
const HARNESS = 'papercusp';
const PLAN = 'plan-efficiency-fixture';
const T0 = Date.parse('2026-09-01T10:00:00Z');
const at = (offsetSec: number) => new Date(T0 + offsetSec * 1000).toISOString();

let nextId = 1;

describe('readPlanEfficiency (real PG)', () => {
  let db: OrgTestDb;

  async function item(featureId: string, status: string, opts: { plan?: string; lane?: string } = {}) {
    // `lane` is GENERATED from payload->>'lane', so the observation lane rides in the payload.
    const payload = opts.lane ? { lane: opts.lane } : {};
    await db.adminSql`
      INSERT INTO harness_shared.work_items
        (workspace_id, harness_slug, feature_id, title, status, item_kind, source_plan_slug, payload)
      VALUES (${WS}, ${HARNESS}, ${featureId}, ${`fixture ${featureId}`}, ${status}, 'feature',
              ${opts.plan ?? PLAN}, ${db.adminSql.json(payload)})`;
  }

  async function call(
    goalRef: string,
    owner: string,
    tool: string,
    offsetSec: number,
    opts: { status?: string; errorCode?: string | null; origin?: string; ws?: string } = {},
  ) {
    const id = nextId++;
    await db.adminSql`
      INSERT INTO harness_shared.tool_invocations
        (id, workspace_id, harness_slug, plugin_name, tool_name, role, spawn_id, coord_owner_id,
         invoked_at, window_key, status, error_code, transport, call_origin, goal_ref)
      VALUES
        (${id}, ${opts.ws ?? WS}, ${HARNESS}, 'core', ${tool}, 'su', ${`sp-${id}`}, ${owner},
         ${at(offsetSec)}::timestamptz, 'w', ${opts.status ?? 'ok'}, ${opts.errorCode ?? null}, 'mcp',
         ${opts.origin ?? 'agent'}, ${goalRef})`;
  }

  async function part(owner: string, offsetSec: number, ws = 'default') {
    const idx = nextId++;
    await db.adminSql`
      INSERT INTO harness_shared.session_turn_parts
        (workspace_id, source_kind, session_id, part_idx, ts, owner, speaker, part_kind, tool_name, text)
      VALUES (${ws}, 'claude', ${`sess-${owner}`}, ${idx}, ${at(offsetSec)}::timestamptz, ${owner},
              'assistant', 'text', null, 'fixture')`;
  }

  async function usage(key: string, opts: { ws?: string; harness?: string; session?: string;
    event?: number | null; grain?: string; input?: number | null; output?: number | null;
    cost?: number | null; costSource?: string; outcome?: string } = {}) {
    const eventTime = opts.event === undefined ? Date.parse(at(20)) : opts.event;
    await db.adminSql`
      INSERT INTO harness_shared.agent_usage_samples
        (workspace_id, ts, bucket_key, provider, model_class, source, model, harness_slug, session_id,
         usage_event_key, event_ts, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
         cost_usd, cost_source, usage_provenance)
      VALUES (${opts.ws ?? WS}, ${eventTime ?? T0}, 'step-fixture', 'openai', 'gpt', 'interactive', 'gpt-test',
        ${opts.harness ?? HARNESS}, ${opts.session ?? 'sess-a1'}, ${key}, ${eventTime},
        ${opts.input === undefined ? 100 : opts.input}, ${opts.output === undefined ? 20 : opts.output}, 0, 0,
        ${opts.cost === undefined ? 0.01 : opts.cost}, ${opts.costSource ?? 'estimated'},
        ${db.adminSql.json({ grain: opts.grain ?? 'request', outcome: opts.outcome ?? 'completed', workItemSource: 'unavailable' })})`;
  }

  const stepInput = () => ({ workspaceId: WS, harnessSlug: HARNESS, sql: db.adminSql,
    subject: { kind: 'work-item', ref: 'WI-A', windowStart: at(-1), windowEnd: at(1261) } });

  beforeAll(async () => {
    db = await createOrgTestDb();

    await item('WI-A', 'done');
    await item('WI-B', 'done');
    await item('WI-C', 'dropped');
    await item('WI-D', 'open');
    await item('WI-O', 'open', { lane: 'observation' });
    await item('WI-X', 'done', { plan: 'some-other-plan' });

    // The plan's attributed calls: 8 in total.
    await call('WI-A', 'a1', 'capability:bash', 0);
    await call('WI-A', 'a1', 'capability:bash', 30);
    await call('WI-A', 'a1', 'coord:send', 60);
    await call('WI-A', 'a2', 'testing:run', 600);
    await call('WI-B', 'a1', 'rubrics:amend', 900, { status: 'invalid-input', errorCode: 'invalid_input' });
    await call('WI-B', 'a1', 'scorecards:emit', 960);
    await call('WI-C', 'a2', 'plans:get', 1200);
    await call('WI-C', 'a2', 'release:checkpoint-run', 1260, { status: 'error' });

    // Rows that must NOT be counted.
    await call('WI-O', 'a1', 'capability:bash', 100); // observation-lane item
    await call('WI-X', 'a3', 'coord:send', 100); // another plan's item
    await call('WI-A', 'a4', 'capability:bash', 5000, { origin: 'system' }); // not an agent call
    await call('WI-A', 'a5', 'capability:bash', 100, { ws: 'other-ws' }); // another workspace

    // Transcript parts. a1: gaps 60 (active) and 900 (idle). a2: gaps 600 (idle) and 60 (active).
    await part('a1', 0);
    await part('a1', 60);
    await part('a1', 960);
    await part('a2', 600);
    await part('a2', 1200);
    await part('a2', 1260);
    // Excluded parts: outside the plan window, and outside the corpus workspace.
    await part('a1', -7200);
    await part('a1', 30, WS);

    await usage('a'.repeat(64));
    await usage('b'.repeat(64), { input: 50, output: 5, cost: 0.02, costSource: 'provider', outcome: 'failed' });
    await usage('c'.repeat(64), { input: 0, output: 0, cost: 0, costSource: 'provider' });
    await usage('d'.repeat(64), { input: null, output: null, cost: null });
    await usage('e'.repeat(64), { harness: 'foreign', cost: 999 });
    await usage('f'.repeat(64), { event: null, cost: 999 });
    await usage('1'.repeat(64), { grain: 'cumulative', cost: 999 });
    await usage('2'.repeat(64), { event: Date.parse(at(5000)), cost: 999 });
    await usage('3'.repeat(64), { session: 'foreign-native', cost: 999 });
    await usage('4'.repeat(64), { ws: 'foreign-workspace', cost: 999 });
  }, 120_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  it('counts exactly the seeded rows of the plan, by purpose', async () => {
    const eff = await readPlanEfficiency({ workspaceId: WS, harnessSlug: HARNESS, planSlug: PLAN, sql: db.adminSql });

    expect(eff.items).toEqual({ total: 4, byStatus: { done: 2, dropped: 1, open: 1 } });
    expect(eff.calls.total).toBe(8);
    expect(eff.calls.agents).toBe(2);
    expect(eff.calls.activeHours).toBe(1);
    expect(eff.calls.firstAt).toBe(at(0));
    expect(eff.calls.lastAt).toBe(at(1260));
    expect(eff.calls.byCategory).toEqual({
      'generic-exec': 2,
      'coordination-carry': 1,
      'read-orient': 1,
      'acceptance-ceremony': 2,
      'gate-pipeline': 1,
      'implementation-test': 1,
      other: 0,
    });
  });

  it('classes failed calls, counts effort on dropped items, and counts holder changes', async () => {
    const eff = await readPlanEfficiency({ workspaceId: WS, harnessSlug: HARNESS, planSlug: PLAN, sql: db.adminSql });

    expect(eff.failed).toEqual({ total: 2, share: 0.25, byClass: { invalid_input: 1, error: 1 } });
    expect(eff.droppedEffort).toEqual({ calls: 2, items: 1, itemIds: ['WI-C'] });
    expect(eff.holders).toEqual({
      itemsWorked: 3,
      itemsWithHolderChange: 1,
      holderChanges: 1,
      mostHandled: [{ itemId: 'WI-A', holders: 2 }],
    });
  });

  it('splits holders wall-clock into active and idle inside the plan window only', async () => {
    const eff = await readPlanEfficiency({ workspaceId: WS, harnessSlug: HARNESS, planSlug: PLAN, sql: db.adminSql });

    expect(eff.wallClock).toMatchObject({
      scope: 'holders-across-plan-window',
      owners: 2,
      activeSec: 120,
      idleSec: 1500,
      awaySec: 0,
      idleGaps: 2,
    });
    expect(eff.population.floor).toBe(true);
  });

  it('returns zeros, not an error, for a plan with no work items', async () => {
    const eff = await readPlanEfficiency({ workspaceId: WS, harnessSlug: HARNESS, planSlug: 'no-such-plan', sql: db.adminSql });

    expect(eff.items.total).toBe(0);
    expect(eff.calls.total).toBe(0);
    expect(eff.calls.firstAt).toBeNull();
    expect(eff.wallClock.owners).toBe(0);
  });

  it('derives canonical work/owner/native scope and measures exact observed deltas in real PG', async () => {
    const result = await readWorkflowStepMeasurement(stepInput());
    expect(result.provenance).toBe('platform-computed');
    expect(result.source.workItemIds).toEqual(['WI-A']);
    expect(result.source.nativeSessionIds).toEqual(['sess-a1', 'sess-a2']);
    expect(result.source.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(result.inputFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(result.population).toMatchObject({ observedRecords: 8, selectedUniqueRequests: 4,
      expectedUniqueRequests: null, query: { complete: true } });
    expect(result.totals).toMatchObject({ inputTokens: { value: 150, observedRecords: 3, missingRecords: 1 },
      outputTokens: { value: 25 }, providerReportedUsd: { value: 0.02 },
      estimatedListUsd: { value: 0.01, missingRecords: 1 }, failedRequestRecords: 1 });
    expect(result.partitions.excluded.map(row => row.reason).sort()).toEqual(['foreign-or-missing-harness', 'outside-event-window']);
    expect(result.partitions['missing-time-unknown-grain']).toHaveLength(2);
    expect(result.partitions['unallocated-shared']).toHaveLength(4);
    expect(result.time.observedToolIntervalUnionMs).toBeNull(); // No durations were observed on these tool rows.
    expect(result.exactStepSpendKnown).toBe(false);
    expect(result.gaps).toContain('expected-request-denominator-unknown');
    expect(Object.values(result.partitions).flat()).toHaveLength(8);
  });

  it('keeps query overflow and unresolved subjects unknown rather than reporting complete zero spend', async () => {
    const limited = await readWorkflowStepMeasurement({ ...stepInput(), maxRows: 2 });
    expect(limited.population.query.complete).toBe(false);
    expect(limited.population.truncatedResidueRecords).toBe(6);
    expect(limited.sourceReadLimits.complete).toBe(false);
    expect(limited.exactStepSpendKnown).toBe(false);
    const absent = await readWorkflowStepMeasurement({ ...stepInput(),
      subject: { ...stepInput().subject, ref: 'not-a-canonical-step' } });
    expect(absent.source.workItemIds).toEqual([]);
    expect(absent.totals.estimatedListUsd.value).toBeNull();
    expect(absent.gaps).toContain('subject-unresolved');
  });

  it('enforces unique canonical event identities instead of counting a duplicate/conflicting ledger insert', async () => {
    await expect(usage('a'.repeat(64), { input: 101 })).rejects.toMatchObject({ code: '23505' });
    const result = await readWorkflowStepMeasurement(stepInput());
    expect(result.population.observedRecords).toBe(8);
    expect(result.totals.inputTokens.value).toBe(150);
  });

  it('retains an actual PG read failure as unknown without a false empty-population measurement', async () => {
    // Only this private fixture DB is changed, and restored even if the assertion fails.
    await db.adminSql`ALTER TABLE harness_shared.agent_usage_samples RENAME TO step_usage_unavailable`;
    try {
      const result = await readWorkflowStepMeasurement(stepInput());
      expect(result.population.query).toMatchObject({ complete: false, totalRecords: null });
      expect(result.population.query.error).toContain('agent_usage_samples');
      expect(result.totals.inputTokens.value).toBeNull();
      expect(result.gaps).toContain('ledger-read-failed');
    } finally {
      await db.adminSql`ALTER TABLE harness_shared.step_usage_unavailable RENAME TO agent_usage_samples`;
    }
  });

  it('round-trips the real measured input, unknown verdict and full partial facts through the existing results ledger', async () => {
    const measurement = await readWorkflowStepMeasurement(stepInput());
    const subject = { kind: 'work-item', ref: 'WI-A' };
    const provenance = retainMeasurementProvenance({
      procedure: { kind: 'platform-instrument', input: { workspaceId: WS, harnessSlug: HARNESS, subject: stepInput().subject } },
      result: { inputFingerprint: measurement.inputFingerprint, sourceFingerprint: measurement.source.fingerprint },
      startedAt: measurement.measuredAt, finishedAt: measurement.measuredAt,
    });
    const ids = await recordRubricCheckResults([{
      check: { id: 'step-population', rubricRef: 'workflow-step-fixture', criterionKey: 'measurement-coverage',
        kind: 'instrument', value: null, unit: null, subject, provenance },
      verdict: 'error', measuredAt: measurement.measuredAt, durationMs: null, detail: JSON.stringify(measurement),
    }], { workspaceId: WS, harnessSlug: HARNESS }, db.adminSql);
    const readback = await readLatestRubricCheckResults({ rubricRef: 'workflow-step-fixture', workspaceId: WS, subject }, db.adminSql);
    const row = readback.get('step-population');
    expect(row?.testRunId).toBe(ids[0]);
    expect(row?.status).toBe('error');
    expect(row?.check.value).toBeNull();
    expect(row?.check.subject).toEqual(subject);
    expect(row?.check.provenance).toEqual(provenance);
    expect(JSON.parse(row!.detail!)).toEqual(JSON.parse(JSON.stringify(measurement)));
    expect(row?.provenanceStatus).toBe('retained');
  });
});
