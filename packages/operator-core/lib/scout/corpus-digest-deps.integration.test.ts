/**
 * corpus-digest-deps.integration.test.ts — the state-of-Hive digest's PRODUCTION
 * readers against real migrated Postgres (hive-creative-ideation-2026-06-08
 * P-003 / B1).
 *
 * The pure layer (corpus-digest.test.ts) proves the synthesis over injected
 * readers; THIS suite pins that the three NEW PG queries actually derive their
 * substrate from the real tables — status regressions from
 * `feature_audit_consolidated`, spend from `agent_usage_samples`, deferrals from
 * `harness_plans.{items,decisions}` jsonb — so they cannot silently return `[]`
 * the way the first cut of change-feed-deps.ts did (its cautionary tale; the
 * core's defensive wrapper would hide an empty production digest otherwise).
 *
 * The completions + friction readers reuse already-integration-tested functions
 * (gatherCompletions / readImprovementItems) and are not re-pinned here.
 *
 * Follows the established org-fixture pattern (test/_org-test-db.ts): mock
 * `getOrgPg` onto the fixture's admin client.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { OrgTestDb } from '../../test/_org-test-db';
import type { DeferralRecord, RevertRecord, SpendRecord, StructuredObservationRecord } from './corpus-digest';
import type { MetaPattern } from './types';

const h = vi.hoisted(() => ({ sql: null as unknown }));

vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: h.sql }),
}));

const { buildStateOfHiveReaders } = await import('./corpus-digest-deps');
const { buildPtyHostHealthLane } = await import('./pty-host-health-lane');
const { buildCiTestHealthLane } = await import('./ci-test-health-lane');
const { buildWorkspaceHostHealthLane } = await import('./workspace-host-health-lane');
const { buildSystemHealthFlapLane } = await import('./system-health-flap-lane');
const { buildBrowserCrashHealthLane } = await import('./browser-crash-health-lane');
const { synthesizeStateOfHive } = await import('./corpus-digest');
// Copy-out mutation probes exercise the real corpus oracle without ever mutating
// the shared production tree. Ordinary CI always loads the canonical module.
const { flattenDigest } = await import(process.env.PAPERCUSP_LENSES_MODULE_PROBE || './lenses');
const { createOrgTestDb } = await import('../../test/_org-test-db');
const { createIssue } = await import('../issues-engineer');
const { OBSERVATION_TOPIC } = await import('../harness/improvements/read-items');

const WS = 'ws-state-of-hive-test';
const OTHER_WS = 'ws-state-of-hive-other';
const T = Date.parse('2026-06-08T10:00:00Z');
const DAY_MS = 24 * 60 * 60 * 1000;

describe('state-of-Hive production readers (real PG)', () => {
  let db: OrgTestDb;

  beforeAll(async () => {
    db = await createOrgTestDb();
    h.sql = db.adminSql;
    const sql = db.adminSql;

    // — feature_audit status transitions: regressions + one recovery (excluded).
    //   Status values are JSON-quoted strings in the text columns (real shape). —
    await sql`
      INSERT INTO harness_shared.feature_audit_consolidated
        (workspace_id, harness_slug, feature_id, ts, field, old_value, new_value, actor)
      VALUES
        (${WS}, 'papercup', 'F-REVERT', ${T},        'status', '"passed"',     '"failing"',    'ci'),
        (${WS}, 'papercup', 'F-REVERT', ${T - 1000}, 'status', '"validating"', '"todo"',       'worker'),
        (${WS}, 'papercup', 'F-KILLED', ${T},        'status', '"passed"',     '"deprecated"', 'reviewer'),
        (${WS}, 'papercup', 'F-RECOVER',${T},        'status', '"failing"',    '"todo"',       'worker'),
        (${WS}, 'papercup', 'F-NOISE',  ${T},        'notes',  'old note',     'new note',     'worker')`;
    await sql`
      INSERT INTO harness_shared.harness_features_consolidated
        (workspace_id, harness_slug, feature_id, title, status, deprecation_reason)
      VALUES
        (${WS}, 'papercup', 'F-KILLED', 'Reason-backed killed feature', 'deprecated',
         'The implementation relied on a stale provider assumption')
    `;

    // — agent_usage_samples spend buckets (NOT NULL: bucket_key/provider/model_class/source). —
    await sql`
      INSERT INTO harness_shared.agent_usage_samples
        (workspace_id, ts, bucket_key, provider, model_class, source, cost_usd, input_tokens, output_tokens, harness_slug, role)
      VALUES
        (${WS}, ${T}, 'b1', 'anthropic', 'opus', 'provider', 8.00, 800000, 120000, 'papercup', 'worker'),
        (${WS}, ${T}, 'b1', 'anthropic', 'opus', 'provider', 4.00, 400000,  60000, 'papercup', 'worker'),
        (${WS}, ${T}, 'b2', 'anthropic', 'opus', 'provider', 2.50, 200000,  30000, 'papercup', 'validator'),
        (${OTHER_WS}, ${T}, 'b3', 'anthropic', 'opus', 'provider', 100.00, 900000, 90000, 'papercup', 'foreign'),
        (${WS}, ${T - 8 * DAY_MS}, 'b4', 'anthropic', 'opus', 'provider', 50.00, 700000, 70000, 'papercup', 'stale'),
        (${WS}, ${T + 60_000}, 'b5', 'anthropic', 'opus', 'provider', 75.00, 600000, 60000, 'papercup', 'future')`;

    // — harness_plans: deferred items (blocked/needs-human) + a deferred decision. —
    await sql`
      INSERT INTO harness_shared.harness_plans
        (workspace_id, harness_slug, plan_slug, title, items, decisions)
      VALUES
        (${WS}, 'papercup', 'plan-x', 'Plan X',
         ${sql.json([
           { id: 'P-005', text: 'wire the cadence trigger primitive', status: 'blocked' },
           { id: 'P-009', text: 'cross-machine paid E2E', status: 'needs-human' },
           { id: 'P-001', text: 'a normal done item', status: 'done' },
         ])}::jsonb,
         ${sql.json([
           { id: 'D-004', title: 'Defer the threshold tuning', body: 'Date: 2026-06-08\nThe gym A/B threshold tuning is deferred to a follow-up.' },
           { id: 'D-005', title: 'A settled decision', body: 'Date: 2026-06-08\nRatified now; shipped this cycle with no open questions.' },
         ])}::jsonb)`;
  }, 120_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  it('reverts reader keeps only regressions, unquotes statuses, drops recoveries + non-status fields', async () => {
    const readers = buildStateOfHiveReaders();
    const reverts = await readers.reverts();
    const ids = reverts.map((r: RevertRecord) => r.workItemId);

    expect(ids).toContain('F-REVERT'); // passed→failing (+ validating→todo)
    expect(ids).toContain('F-KILLED'); // passed→deprecated
    expect(ids).not.toContain('F-RECOVER'); // failing→todo is a recovery
    expect(ids).not.toContain('F-NOISE'); // field='notes', not a status change

    const sample = reverts.find((r: RevertRecord) => r.workItemId === 'F-KILLED')!;
    expect(sample.from).toBe('passed'); // unquoted (not '"passed"')
    expect(sample.to).toBe('deprecated');
    expect(sample.harness).toBe('papercup');
    expect(sample.reason).toContain('stale provider assumption');
    const digest = await synthesizeStateOfHive(readers, { nowMs: T });
    const lessons = flattenDigest(digest).filter((pattern: MetaPattern) => pattern.category === 'rework-lesson');
    expect(lessons).toContainEqual(expect.objectContaining({
      ref: 'wi:F-KILLED',
      summary: expect.stringContaining('stale provider assumption'),
    }));
    expect(lessons.some((pattern: MetaPattern) => pattern.ref === 'wi:F-REVERT')).toBe(false);
  });

  it('CI corpus reader separates repeated gate failures from clean same-commit local divergence', async () => {
    const sql = db.adminSql;
    await sql`
      INSERT INTO harness_shared.test_runs
        (file_path, framework, status, started_at, finished_at, run_group_id,
         source, commit_sha, worktree_dirty)
      VALUES
        ('repeat-ci.test.ts', 'vitest', 'fail', '2026-06-08T08:00:00Z', '2026-06-08T08:01:00Z', 'gate-a', 'ci', 'abc123', false),
        ('repeat-ci.test.ts', 'vitest', 'error', '2026-06-08T09:00:00Z', '2026-06-08T09:01:00Z', 'gate-b', 'ci', 'abc123', false),
        ('repeat-ci.test.ts', 'vitest', 'pass', '2026-06-08T09:03:00Z', '2026-06-08T09:04:00Z', 'local-a', 'local', 'abc123', false),
        ('one-off-ci.test.ts', 'vitest', 'fail', '2026-06-08T08:00:00Z', '2026-06-08T08:01:00Z', 'gate-a', 'ci', 'abc123', false),
        ('one-off-ci.test.ts', 'vitest', 'pass', '2026-06-08T09:03:00Z', '2026-06-08T09:04:00Z', 'local-a', 'local', 'abc123', true),
        ('other-commit.test.ts', 'vitest', 'fail', '2026-06-08T08:00:00Z', '2026-06-08T08:01:00Z', 'gate-a', 'ci', 'abc123', false),
        ('other-commit.test.ts', 'vitest', 'pass', '2026-06-08T09:03:00Z', '2026-06-08T09:04:00Z', 'local-a', 'local', 'def456', false)
    `;
    const lane = await buildCiTestHealthLane({ nowMs: T });
    expect(lane).toHaveLength(1);
    expect(lane[0]).toMatchObject({ category: 'ci-test-health' });
    expect(lane[0]?.summary).toContain('repeat-ci.test.ts: 2 failing CI run group(s)');
    expect(lane[0]?.summary).toContain('clean local pass at the same commit');
    expect(lane[0]?.detail).toContain('2 failed CI file-run row(s)');
    expect(lane[0]?.detail).toMatch(/test_runs\.id=\d+/);
    expect(flattenDigest({
      recurringFriction: [], timeTokenSinks: [], chronicDeferrals: [], capabilityGaps: [],
      ciTestHealth: lane,
    }).map((pattern: MetaPattern) => pattern.ref)).toEqual([lane[0]!.ref]);
  });

  it('workspace-host corpus reader groups failed event rows and cites later host success separately', async () => {
    const sql = db.adminSql;
    await sql`
      INSERT INTO harness_shared.workspace_host_connections
        (workspace_id, id, target, label, credential_ref)
      VALUES (${WS}, 'corpus-conn', 'gcp', 'corpus test', 'test:credential')
    `;
    await sql`
      INSERT INTO harness_shared.workspace_hosts
        (workspace_id, id, name, connection_id, target, scope_label, region, size, image,
         disk_gib, network, desired_state, observed_state)
      VALUES (${WS}, 'corpus-host', 'corpus host', 'corpus-conn', 'gcp', 'test-project',
              'us-central1', 'e2-standard-4', 'image-v1', 64, 'default', 'running', 'running')
    `;
    await sql`
      INSERT INTO harness_shared.workspace_host_operations
        (workspace_id, id, host_id, action, status)
      VALUES
        (${WS}, 'corpus-op-failed', 'corpus-host', 'initialize', 'failed'),
        (${WS}, 'corpus-op-success', 'corpus-host', 'initialize', 'succeeded')
    `;
    await sql`
      INSERT INTO harness_shared.workspace_host_events
        (workspace_id, id, host_id, operation_id, occurred_at, phase, status, message)
      VALUES
        (${WS}, 'corpus-failure-1', 'corpus-host', 'corpus-op-failed',
         '2026-06-08T08:00:00Z', 'initialize:failed', 'failed', 'failed once'),
        (${WS}, 'corpus-failure-2', 'corpus-host', 'corpus-op-failed',
         '2026-06-08T08:01:00Z', 'initialize:failed', 'failed', 'failed twice'),
        (${WS}, 'corpus-recovery', 'corpus-host', 'corpus-op-success',
         '2026-06-08T08:05:00Z', 'initialize:complete', 'succeeded', 'later success')
    `;
    const lane = await buildWorkspaceHostHealthLane({ workspaceId: WS, nowMs: T });
    expect(lane).toHaveLength(1);
    expect(lane[0]).toMatchObject({ category: 'workspace-host-health', ref: 'workspace-host:event:corpus-failure-2' });
    expect(lane[0]?.summary).toContain('1 failed managed workspace-host operation(s)');
    expect(lane[0]?.detail).toContain('2 failed event row(s)');
    expect(lane[0]?.detail).toContain('workspace_host_events.id=corpus-recovery');
    expect(lane[0]?.detail).toContain('may be a separate operation');
    expect(flattenDigest({
      recurringFriction: [], timeTokenSinks: [], chronicDeferrals: [], capabilityGaps: [],
      workspaceHostHealth: lane,
    }).map((pattern: MetaPattern) => pattern.ref)).toEqual(['workspace-host:event:corpus-failure-2']);
  });

  it('health-flap corpus reader measures time to OK and leaves an open critical entry incomplete', async () => {
    const sql = db.adminSql;
    await sql`
      INSERT INTO harness_shared.system_health_transitions
        (workspace_id, panel, from_status, to_status, at)
      VALUES
        (${WS}, 'infrastructure', 'ok', 'crit', '2026-06-08T08:00:00Z'),
        (${WS}, 'infrastructure', 'crit', 'warn', '2026-06-08T08:05:00Z'),
        (${WS}, 'infrastructure', 'warn', 'ok', '2026-06-08T08:20:00Z'),
        (${WS}, 'infrastructure', 'ok', 'crit', '2026-06-08T09:00:00Z')
    `;
    const lane = await buildSystemHealthFlapLane({ workspaceId: WS, nowMs: T });
    expect(lane).toHaveLength(1);
    expect(lane[0]).toMatchObject({ category: 'system-health-flap' });
    expect(lane[0]?.ref).toMatch(/^health-transition:\d+$/);
    expect(lane[0]?.summary).toContain('2 time(s) in 14d; 1 return(s) to OK not observed');
    expect(lane[0]?.detail).toContain('median 20 min to OK');
    expect(lane[0]?.detail).toMatch(/latest OK transition id=\d+/);
    expect(flattenDigest({
      recurringFriction: [], timeTokenSinks: [], chronicDeferrals: [], capabilityGaps: [],
      systemHealthFlaps: lane,
    }).map((pattern: MetaPattern) => pattern.ref)).toEqual([lane[0]!.ref]);
  });

  it('browser crash corpus reader folds only redacted render-boundary reports from the local archive', async () => {
    const sql = db.adminSql;
    const payload = {
      source: 'render-boundary', boundary: 'adv-tab', errorType: 'TypeError',
      component: 'LearningTab', tab: 'learning',
      fingerprint: 'adv-tab:TypeError:LearningTab:learning',
    };
    await sql`
      INSERT INTO harness_shared.telemetry_reports_archive
        (workspace_id, received_at, kind, payload)
      VALUES
        (${WS}, '2026-06-08T08:00:00Z', 'crash', ${JSON.stringify(payload)}::text::jsonb),
        (${WS}, '2026-06-08T09:00:00Z', 'crash', ${JSON.stringify(payload)}::text::jsonb),
        (${WS}, '2026-06-08T09:01:00Z', 'crash',
         '{"message":"raw error; no render-boundary source"}'::jsonb)
    `;
    const lane = await buildBrowserCrashHealthLane({ workspaceId: WS, nowMs: T });
    expect(lane).toHaveLength(1);
    expect(lane[0]).toMatchObject({ category: 'browser-crash-health' });
    expect(lane[0]?.summary).toContain('2 redacted TypeError render crash report(s)');
    expect(lane[0]?.detail).toMatch(/telemetry_reports_archive\.id=\d+/);
    expect(lane[0]?.detail).not.toContain('raw error');
    expect(flattenDigest({
      recurringFriction: [], timeTokenSinks: [], chronicDeferrals: [], capabilityGaps: [],
      browserCrashHealth: lane,
    }).map((pattern: MetaPattern) => pattern.ref)).toEqual([lane[0]!.ref]);
  });

  it('spend reader scopes to the workspace and trailing 7d window', async () => {
    const readers = buildStateOfHiveReaders({ workspaceId: WS, nowMs: T });
    const spend = await readers.spend();
    expect(spend.map((s: SpendRecord) => `${s.harness}:${s.role}`).sort()).toEqual(['papercup:validator', 'papercup:worker']);
    const worker = spend.find((s: SpendRecord) => s.role === 'worker' && s.harness === 'papercup')!;
    expect(worker).toBeDefined();
    expect(worker.costUsd).toBeCloseTo(12.0, 5); // 8 + 4
    expect(worker.inputTokens).toBe(1_200_000);
    expect(worker.runs).toBe(2);
    const validator = spend.find((s: SpendRecord) => s.role === 'validator')!;
    expect(validator.costUsd).toBeCloseTo(2.5, 5);
  });

  it('deferrals reader returns blocked/needs-human items + deferred decisions, excludes done', async () => {
    const readers = buildStateOfHiveReaders();
    const deferrals = await readers.deferrals();
    const itemTexts = deferrals.filter((d: DeferralRecord) => d.source === 'item').map((d: DeferralRecord) => d.text);
    expect(itemTexts).toContain('wire the cadence trigger primitive'); // blocked
    expect(itemTexts).toContain('cross-machine paid E2E'); // needs-human
    expect(itemTexts).not.toContain('a normal done item'); // done is excluded

    const decisions = deferrals.filter((d: DeferralRecord) => d.source === 'decision');
    expect(decisions.map((d: DeferralRecord) => d.refId)).toContain('D-004'); // body marks a deferral
    expect(decisions.map((d: DeferralRecord) => d.refId)).not.toContain('D-005'); // no deferral marker
  });

  it('end-to-end: synthesize produces a populated digest from the real corpus', async () => {
    const digest = await synthesizeStateOfHive(
      buildStateOfHiveReaders({ workspaceId: WS, nowMs: T }),
      { nowMs: T },
    );

    // Sinks: worker ($12) ranks above validator ($2.50), normalised weight top=1.
    expect(digest.timeTokenSinks[0].summary).toContain('papercup · worker');
    expect(digest.timeTokenSinks[0].weight).toBe(1);

    // Reverts substrate: the killed + reverted items present, recovery absent.
    const revertRefs = digest.reverts.map((p) => p.ref);
    expect(revertRefs).toContain('wi:F-KILLED');
    expect(revertRefs).toContain('wi:F-REVERT');
    expect(revertRefs).not.toContain('wi:F-RECOVER');

    // Deferrals: the two punted items aggregate into the chronic-deferral lane.
    expect(digest.chronicDeferrals.length).toBeGreaterThan(0);
    expect(digest.chronicDeferrals.every((p) => p.category === 'chronic-deferral')).toBe(true);

    // Corpus rollup reflects the real spend.
    expect(digest.corpus.spendUsd).toBeCloseTo(14.5, 5);
    expect(digest.corpus.spendBuckets).toBe(2); // 2 (harness,role) groups

    // P-006: the rubric-rating lane is wired through the production readers without
    // crashing. (Populated end-to-end in the dedicated scorecard test below.)
    expect(Array.isArray(digest.rubricRatings)).toBe(true);
    expect(digest.corpus.observations).toBe(0); // no scorecards inserted yet
  });

  it('observations reader surfaces a rubric-graded scorecard end-to-end → the rubric-rating lane (P-006)', async () => {
    // REAL read path: createIssue(observation topic, payload.observation) → listIssues →
    // issueToCandidate.observation (P-001 surfacing, su-f8ee5) → observations() reader →
    // buildRubricRatings. Proves the structured observation flows all the way to the lane.
    await createIssue({
      title: 'pot-coordination-health scorecard',
      topics: [OBSERVATION_TOPIC],
      createdBy: 'kettle',
      payload: {
        lane: 'observation',
        observation: {
          rubricRef: 'pot-coordination-health',
          sourceHive: 'papercusp',
          // ratings is a Record keyed by criterion (D-003); evidence mandatory.
          ratings: {
            'end-to-end-flow': { rating: 'broken', evidence: '88 items unplaced despite idle capacity' },
            'ideation-quality': { rating: 'healthy', evidence: 'lens weights diverged from uniform' },
          },
        },
      },
    });

    // The reader maps the surfaced candidate.observation onto a clean record.
    const records = await buildStateOfHiveReaders().observations();
    const rec = records.find((r: StructuredObservationRecord) => r.rubricRef === 'pot-coordination-health');
    expect(rec).toBeDefined();
    expect(rec!.sourceHive).toBe('papercusp');
    expect(rec!.ratings?.['end-to-end-flow']).toEqual({ rating: 'broken', evidence: '88 items unplaced despite idle capacity' });

    // The digest surfaces the broken criterion as a rubric measurement; healthy drops.
    const digest = await synthesizeStateOfHive(buildStateOfHiveReaders(), { nowMs: T });
    expect(digest.corpus.observations).toBeGreaterThanOrEqual(1);
    const e2e = digest.rubricRatings.find(
      (p: MetaPattern) => p.ref === 'rubric:pot-coordination-health#end-to-end-flow@papercusp',
    );
    expect(e2e).toBeDefined();
    expect(e2e!.summary).toContain('broken');
    expect(e2e!.category).toBe('rubric-rating');
    expect(digest.rubricRatings.some((p) => p.ref.includes('ideation-quality'))).toBe(false); // healthy → not surfaced
  });

  it('ingested PTY-host failures and recovered retries reach Blender with persisted row citations', async () => {
    const sql = db.adminSql;
    const at = new Date(T).toISOString();
    await sql`
      INSERT INTO harness_shared.psu_pty_host_events
        (workspace_id, owner_id, ts, kind, payload, row_digest)
      VALUES
        (${WS}, 'su-pty-a', ${at}::timestamptz, 'submit-verify-unconfirmed',
         '{"label":"reset inject","resubmits":3}'::jsonb, 'pty-health-failure'),
        (${WS}, 'su-pty-a', ${at}::timestamptz, 'turn-delivered',
         '{"label":"reset inject","resubmits":3}'::jsonb, 'pty-health-recovered'),
        (${WS}, 'su-pty-a', ${at}::timestamptz, 'turn-delivered',
         '{"label":"turn inject","resubmits":0}'::jsonb, 'pty-health-routine'),
        (${OTHER_WS}, 'su-pty-other', ${at}::timestamptz, 'pty-load-failed',
         '{}'::jsonb, 'pty-health-other-workspace')`;

    const lane = await buildPtyHostHealthLane({ workspaceId: WS, nowMs: T + 1_000 });
    const refs = lane.map((p) => p.ref);
    expect(refs).toContain('pty-host:kind:submit-verify-unconfirmed');
    expect(refs).toContain('pty-host:kind:turn-delivered-after-retry');
    expect(refs).not.toContain('pty-host:kind:turn-delivered');
    expect(refs).not.toContain('pty-host:kind:pty-load-failed');
    expect(lane.every((p) => p.detail?.includes('psu_pty_host_events.id='))).toBe(true);

    const flat = flattenDigest({
      recurringFriction: [], timeTokenSinks: [], chronicDeferrals: [], capabilityGaps: [],
      ptyHostHealth: lane,
    });
    expect(flat.map((p: MetaPattern) => p.ref)).toEqual(refs);
    expect(flat.every((p: MetaPattern) => p.category === 'pty-host-health')).toBe(true);
  });

  it('excludes the carry-drills roll-up rather than double-counting it as a session', async () => {
    const sql = db.adminSql;
    const at = new Date(T + 3_000).toISOString();
    await sql`
      INSERT INTO harness_shared.psu_pty_host_events
        (workspace_id, owner_id, ts, kind, payload, row_digest)
      VALUES
        (${WS}, 'su-pty-a', ${at}::timestamptz, 'respawn-carry-dropped',
         '{}'::jsonb, 'pty-health-real-carry-drop'),
        (${WS}, 'carry-drills', ${at}::timestamptz, 'respawn-carry-dropped',
         '{}'::jsonb, 'pty-health-mirrored-carry-drop'),
        (${WS}, 'carry-drills', ${at}::timestamptz, 'carry-drill-requested',
         '{}'::jsonb, 'pty-health-operator-drill')`;

    const lane = await buildPtyHostHealthLane({ workspaceId: WS, nowMs: T + 4_000 });
    const drop = lane.find((pattern) => pattern.ref === 'pty-host:kind:respawn-carry-dropped');
    expect(drop?.summary).toContain('1 PTY-host event(s) across 1 session(s)');
    expect(lane.map((pattern) => pattern.ref)).not.toContain('pty-host:kind:carry-drill-requested');
  });

  it('cites the newest event time when older files are ingested later', async () => {
    const sql = db.adminSql;
    const newerAt = new Date(T + 1_000).toISOString();
    const olderAt = new Date(T).toISOString();
    const [newest] = await sql<{ id: string }[]>`
      INSERT INTO harness_shared.psu_pty_host_events
        (workspace_id, owner_id, ts, kind, payload, row_digest)
      VALUES (${WS}, 'su-pty-a', ${newerAt}::timestamptz,
              'control-socket-error', '{}'::jsonb, 'pty-health-citation-newer')
      RETURNING id::text AS id`;
    await sql`
      INSERT INTO harness_shared.psu_pty_host_events
        (workspace_id, owner_id, ts, kind, payload, row_digest)
      VALUES (${WS}, 'su-pty-a', ${olderAt}::timestamptz,
              'control-socket-error', '{}'::jsonb, 'pty-health-citation-older')`;

    const lane = await buildPtyHostHealthLane({ workspaceId: WS, nowMs: T + 2_000 });
    const pattern = lane.find((entry) => entry.ref === 'pty-host:kind:control-socket-error');
    expect(pattern?.detail).toContain(`psu_pty_host_events.id=${newest!.id}`);
    expect(pattern?.detail).toContain(newerAt.replace('T', ' ').slice(0, 19));
  });
});
