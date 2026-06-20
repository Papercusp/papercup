/**
 * observation-source-hive-backfill.integration.test.ts — guards migration
 * 325-observation-schema-v2.sql (rubric-driven-observations-2026-06-20 P-001, brief B1).
 *
 * The migration backfills `payload.observation.sourceHive` (camelCase, per plan D-003) onto the
 * EXISTING observation corpus (engineer_issues.payload.lane='observation'), derived from each
 * row's federated identity (scope + workspace_id), so the workspace-scoped Scout corpus-digest
 * (P-006) can GROUP BY source hive over HISTORICAL rows, not just newly-filed ones.
 *
 * This is an INTEGRATION test (real Postgres) because the backfill is pure SQL — jsonb_set +
 * a CASE derivation + DISABLE TRIGGER + partial expression indexes — which a mocked unit test
 * cannot exercise. We RE-RUN THE REAL migration body from the .sql file (not a re-implementation),
 * so the asserted derivation can never drift from what ships. The migration already ran once at
 * DB creation (000→head) against an empty table; it is idempotent, so re-running it after we
 * insert fixtures backfills exactly those fixtures.
 *
 * Asserts:
 *  1. derivation — each scope/workspace shape maps to the right sourceHive;
 *  2. free-text first-class — a BARE observation (no payload.observation object) gets one created
 *     with just { sourceHive }, and a structured observation keeps its existing keys;
 *  3. idempotency — a row that already carries sourceHive is left UNTOUCHED (never clobbered);
 *  4. scoping — a non-observation engineer_issue is never touched;
 *  5. silence — updated_at is NOT bumped (the triggers are suppressed for the backfill);
 *  6. indexes — the two supporting partial indexes exist.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOrgTestDb, type OrgTestDb } from '../../../test/_org-test-db';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../../../..');
const MIGRATION_FILE = resolve(REPO_ROOT, 'libs/papercusp/libs/db/sql/325-observation-schema-v2.sql');

/** The real migration body with the wrapper removed so postgres.js can run it as one
 *  multi-statement simple query: the psql-only meta-command (\set …) and the explicit
 *  BEGIN/COMMIT (postgres.js rejects raw transaction control via `unsafe` on a pooled
 *  connection — a multi-statement simple query is already its own implicit transaction, so
 *  the DISABLE/ENABLE-TRIGGER + UPDATE atomicity is preserved). Every real statement
 *  (ALTER … DISABLE/ENABLE TRIGGER, UPDATE, CREATE INDEX) runs verbatim. */
function migrationBody(): string {
  return readFileSync(MIGRATION_FILE, 'utf8')
    .split('\n')
    .filter((line) => {
      const t = line.trim().toUpperCase();
      return !line.trimStart().startsWith('\\') && t !== 'BEGIN;' && t !== 'COMMIT;';
    })
    .join('\n');
}

const PAST = '2026-06-01T00:00:00.000Z'; // fixed past timestamp — proves the backfill does not bump updated_at

interface ObsFixture {
  id: string;
  workspace: string;
  scope: string;
  payload: Record<string, unknown>;
  expectSourceHive: string;
}

// One fixture per derivation branch (values mirror the live distribution verified at authoring).
const OBS_FIXTURES: ObsFixture[] = [
  { id: 'EI-OBS-OP-DEFAULT', workspace: 'default', scope: 'operator', payload: { lane: 'observation', observation: { kind: 'friction', confidence: 'high' } }, expectSourceHive: 'papercusp' },
  { id: 'EI-OBS-OP-PCWS', workspace: 'papercusp-workspace', scope: 'operator', payload: { lane: 'observation', observation: { kind: 'gap' } }, expectSourceHive: 'papercusp' },
  { id: 'EI-OBS-GENERIC', workspace: 'generic-test', scope: 'operator', payload: { lane: 'observation', observation: { kind: 'surprise' } }, expectSourceHive: 'generic-test' },
  { id: 'EI-OBS-HARNESS', workspace: 'default', scope: 'harness:sb-devboard-hive', payload: { lane: 'observation', observation: { kind: 'gap' } }, expectSourceHive: 'sb-devboard-hive' },
  { id: 'EI-OBS-HARNESS-DEMO', workspace: 'default', scope: 'harness:offsite-planner-demo', payload: { lane: 'observation', observation: { kind: 'workaround' } }, expectSourceHive: 'offsite-planner-demo' },
  { id: 'EI-OBS-LITERAL-SCOPE', workspace: 'default', scope: 'papercusp', payload: { lane: 'observation', observation: { kind: 'reinforce' } }, expectSourceHive: 'papercusp' },
  // free-text first-class: a bare observation with NO structured object — the backfill must create it.
  { id: 'EI-OBS-BARE', workspace: 'default', scope: 'operator', payload: { lane: 'observation' }, expectSourceHive: 'papercusp' },
];

describe('migration 325 — observation sourceHive backfill', () => {
  let db: OrgTestDb;

  beforeAll(async () => {
    db = await createOrgTestDb();
    const sql = db.adminSql;
    // Seed pre-v2 fixtures (no sourceHive) with a FIXED past updated_at, plus an idempotency row
    // (already carries sourceHive) and a non-observation control row.
    for (const f of OBS_FIXTURES) {
      await sql`
        INSERT INTO harness_shared.engineer_issues
          (workspace_id, issue_id, scope, title, payload, created_at, updated_at)
        VALUES (${f.workspace}, ${f.id}, ${f.scope}, ${'obs ' + f.id},
                ${JSON.stringify(f.payload)}::text::jsonb, ${PAST}, ${PAST})`;
    }
    // Idempotency: a structured observation that ALREADY has a (deliberately "wrong") sourceHive —
    // the backfill must NOT overwrite it.
    await sql`
      INSERT INTO harness_shared.engineer_issues
        (workspace_id, issue_id, scope, title, payload, created_at, updated_at)
      VALUES ('default', 'EI-OBS-PRESET', 'operator', 'preset obs',
              ${JSON.stringify({ lane: 'observation', observation: { kind: 'gap', sourceHive: 'already-set-hive' } })}::text::jsonb,
              ${PAST}, ${PAST})`;
    // Control: a normal (non-observation) engineer_issue — must be left untouched.
    await sql`
      INSERT INTO harness_shared.engineer_issues
        (workspace_id, issue_id, scope, title, kind, payload, created_at, updated_at)
      VALUES ('default', 'EI-NOT-OBS', 'operator', 'a real bug', 'bug',
              ${JSON.stringify({ paths: ['a.ts'] })}::text::jsonb, ${PAST}, ${PAST})`;

    // Re-run the REAL migration body against the freshly-seeded fixtures (idempotent).
    await sql.unsafe(migrationBody());
  }, 120_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  it('derives the right sourceHive for every scope/workspace shape', async () => {
    for (const f of OBS_FIXTURES) {
      const [row] = await db.adminSql<{ source_hive: string | null }[]>`
        SELECT payload -> 'observation' ->> 'sourceHive' AS source_hive
          FROM harness_shared.engineer_issues
         WHERE workspace_id = ${f.workspace} AND issue_id = ${f.id}`;
      expect(row?.source_hive, `sourceHive for ${f.id}`).toBe(f.expectSourceHive);
    }
  });

  it('creates the observation object on a bare free-text observation (only sourceHive added)', async () => {
    const [row] = await db.adminSql<{ obs: Record<string, unknown> }[]>`
      SELECT payload -> 'observation' AS obs
        FROM harness_shared.engineer_issues
       WHERE issue_id = 'EI-OBS-BARE'`;
    expect(row?.obs).toEqual({ sourceHive: 'papercusp' });
  });

  it('preserves the existing structured keys when adding sourceHive', async () => {
    const [row] = await db.adminSql<{ obs: Record<string, unknown> }[]>`
      SELECT payload -> 'observation' AS obs
        FROM harness_shared.engineer_issues
       WHERE issue_id = 'EI-OBS-OP-DEFAULT'`;
    expect(row?.obs).toEqual({ kind: 'friction', confidence: 'high', sourceHive: 'papercusp' });
  });

  it('is idempotent — never clobbers a sourceHive already present', async () => {
    const [row] = await db.adminSql<{ source_hive: string }[]>`
      SELECT payload -> 'observation' ->> 'sourceHive' AS source_hive
        FROM harness_shared.engineer_issues
       WHERE issue_id = 'EI-OBS-PRESET'`;
    expect(row?.source_hive).toBe('already-set-hive');
  });

  it('never touches a non-observation engineer_issue', async () => {
    const [row] = await db.adminSql<{ payload: Record<string, unknown> }[]>`
      SELECT payload FROM harness_shared.engineer_issues WHERE issue_id = 'EI-NOT-OBS'`;
    expect(row?.payload).toEqual({ paths: ['a.ts'] });
    expect(row?.payload).not.toHaveProperty('observation');
  });

  it('is silent — does not bump updated_at on the backfilled rows', async () => {
    const rows = await db.adminSql<{ issue_id: string; updated_at: Date }[]>`
      SELECT issue_id, updated_at FROM harness_shared.engineer_issues
       WHERE issue_id = ANY(${OBS_FIXTURES.map((f) => f.id)})`;
    expect(rows.length).toBe(OBS_FIXTURES.length);
    for (const r of rows) {
      expect(new Date(r.updated_at).toISOString(), `updated_at unchanged for ${r.issue_id}`).toBe(PAST);
    }
  });

  it('creates the supporting partial indexes', async () => {
    const idx = await db.adminSql<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes
       WHERE schemaname = 'harness_shared' AND tablename = 'engineer_issues'
         AND indexname IN ('engineer_issues_obs_source_hive_idx', 'engineer_issues_obs_rubric_ref_idx')`;
    const names = idx.map((r) => r.indexname).sort();
    expect(names).toEqual(['engineer_issues_obs_rubric_ref_idx', 'engineer_issues_obs_source_hive_idx']);
  });
});
