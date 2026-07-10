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

const h = vi.hoisted(() => ({ sql: null as unknown }));

vi.mock('@papercusp/db-org', () => ({ getOrgPg: () => ({ sql: h.sql }) }));

const { buildStateOfHiveReaders } = await import('./corpus-digest-deps');
const { synthesizeStateOfHive } = await import('./corpus-digest');
const { createOrgTestDb } = await import('../../test/_org-test-db');
const { createIssue } = await import('../issues-engineer');
const { OBSERVATION_TOPIC } = await import('../harness/improvements/read-items');

const WS = 'ws-state-of-hive-test';
const T = Date.parse('2026-06-08T10:00:00Z');

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

    // — agent_usage_samples spend buckets (NOT NULL: bucket_key/provider/model_class/source). —
    await sql`
      INSERT INTO harness_shared.agent_usage_samples
        (workspace_id, ts, bucket_key, provider, model_class, source, cost_usd, input_tokens, output_tokens, harness_slug, role)
      VALUES
        (${WS}, ${T}, 'b1', 'anthropic', 'opus', 'provider', 8.00, 800000, 120000, 'papercup', 'worker'),
        (${WS}, ${T}, 'b1', 'anthropic', 'opus', 'provider', 4.00, 400000,  60000, 'papercup', 'worker'),
        (${WS}, ${T}, 'b2', 'anthropic', 'opus', 'provider', 2.50, 200000,  30000, 'papercup', 'validator')`;

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
    const ids = reverts.map((r) => r.workItemId);

    expect(ids).toContain('F-REVERT'); // passed→failing (+ validating→todo)
    expect(ids).toContain('F-KILLED'); // passed→deprecated
    expect(ids).not.toContain('F-RECOVER'); // failing→todo is a recovery
    expect(ids).not.toContain('F-NOISE'); // field='notes', not a status change

    const sample = reverts.find((r) => r.workItemId === 'F-KILLED')!;
    expect(sample.from).toBe('passed'); // unquoted (not '"passed"')
    expect(sample.to).toBe('deprecated');
    expect(sample.harness).toBe('papercup');
  });

  it('spend reader rolls up by (harness, role) with summed cost', async () => {
    const readers = buildStateOfHiveReaders();
    const spend = await readers.spend();
    const worker = spend.find((s) => s.role === 'worker' && s.harness === 'papercup')!;
    expect(worker).toBeDefined();
    expect(worker.costUsd).toBeCloseTo(12.0, 5); // 8 + 4
    expect(worker.inputTokens).toBe(1_200_000);
    expect(worker.runs).toBe(2);
    const validator = spend.find((s) => s.role === 'validator')!;
    expect(validator.costUsd).toBeCloseTo(2.5, 5);
  });

  it('deferrals reader returns blocked/needs-human items + deferred decisions, excludes done', async () => {
    const readers = buildStateOfHiveReaders();
    const deferrals = await readers.deferrals();
    const itemTexts = deferrals.filter((d) => d.source === 'item').map((d) => d.text);
    expect(itemTexts).toContain('wire the cadence trigger primitive'); // blocked
    expect(itemTexts).toContain('cross-machine paid E2E'); // needs-human
    expect(itemTexts).not.toContain('a normal done item'); // done is excluded

    const decisions = deferrals.filter((d) => d.source === 'decision');
    expect(decisions.map((d) => d.refId)).toContain('D-004'); // body marks a deferral
    expect(decisions.map((d) => d.refId)).not.toContain('D-005'); // no deferral marker
  });

  it('end-to-end: synthesize produces a populated digest from the real corpus', async () => {
    const digest = await synthesizeStateOfHive(buildStateOfHiveReaders(), { nowMs: T });

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
    const rec = records.find((r) => r.rubricRef === 'pot-coordination-health');
    expect(rec).toBeDefined();
    expect(rec!.sourceHive).toBe('papercusp');
    expect(rec!.ratings?.['end-to-end-flow']).toEqual({ rating: 'broken', evidence: '88 items unplaced despite idle capacity' });

    // The digest surfaces the broken criterion as a rubric measurement; healthy drops.
    const digest = await synthesizeStateOfHive(buildStateOfHiveReaders(), { nowMs: T });
    expect(digest.corpus.observations).toBeGreaterThanOrEqual(1);
    const e2e = digest.rubricRatings.find(
      (p) => p.ref === 'rubric:pot-coordination-health#end-to-end-flow@papercusp',
    );
    expect(e2e).toBeDefined();
    expect(e2e!.summary).toContain('broken');
    expect(e2e!.category).toBe('rubric-rating');
    expect(digest.rubricRatings.some((p) => p.ref.includes('ideation-quality'))).toBe(false); // healthy → not surfaced
  });
});
