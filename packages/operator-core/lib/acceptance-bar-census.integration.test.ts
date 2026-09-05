import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyMigrationForTest, createFreshPgDb, type FreshPgDb } from '../test/_pg-helpers';
import { runAcceptanceBarCensus, type AcceptanceBarCensusSql } from './acceptance-bar-census';

const WORKSPACE = 'acceptance-bar-census-test';
const HARNESS = 'papercusp';
const here = dirname(fileURLToPath(import.meta.url));
const migration = (name: string) => resolve(here, '../../../libs/papercusp/libs/db/sql', name);

let db: FreshPgDb;

beforeAll(async () => {
  db = await createFreshPgDb('acceptance-bar-census');
  await db.sql.unsafe(`
    CREATE TABLE harness_shared.harness_plans (
      workspace_id text NOT NULL,
      harness_slug text NOT NULL,
      plan_slug text NOT NULL,
      title text,
      status text,
      content text NOT NULL,
      content_hash text NOT NULL,
      version bigint NOT NULL DEFAULT 1,
      owner text,
      template text,
      template_slug text,
      template_data jsonb,
      archived boolean NOT NULL DEFAULT false,
      is_legacy boolean NOT NULL DEFAULT false,
      items jsonb NOT NULL DEFAULT '[]'::jsonb,
      decisions jsonb NOT NULL DEFAULT '[]'::jsonb,
      now_state text,
      now_next text,
      created text,
      updated text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      origin text NOT NULL DEFAULT 'local',
      PRIMARY KEY (workspace_id, harness_slug, plan_slug)
    );
    CREATE TABLE harness_shared.plan_items (
      workspace_id text NOT NULL,
      harness_slug text NOT NULL,
      plan_slug text NOT NULL,
      item_id text NOT NULL,
      seq integer NOT NULL,
      status text NOT NULL,
      item_text text NOT NULL,
      PRIMARY KEY (workspace_id, harness_slug, plan_slug, item_id)
    );
  `);
  await applyMigrationForTest(db.sql, migration('851-first-class-plan-spec-clauses.sql'));
  await applyMigrationForTest(db.sql, migration('929-spec-clause-falsifier.sql'));
  await applyMigrationForTest(db.sql, migration('1111-acceptance-bar-contract-seed.sql'));
}, 90_000);

afterAll(async () => {
  await db?.cleanup();
});

beforeEach(async () => {
  await db.sql`TRUNCATE harness_shared.plan_spec_clause_revisions, harness_shared.plan_spec_clauses, harness_shared.plan_items, harness_shared.harness_plans CASCADE`;
});

describe('runAcceptanceBarCensus (real Postgres)', () => {
  it('is rerunnable with the same stated corpus/query and names missing coverage', async () => {
    const content = '## Requirements\n\n**R-1 — Outcome.** The outcome is true.';
    await db.sql`
      INSERT INTO harness_shared.harness_plans
        (workspace_id, harness_slug, plan_slug, title, status, content, content_hash,
         acceptance_bar_epoch, acceptance_bar_cohort, acceptance_bar_set_hash,
         acceptance_bar_rubric_slug, acceptance_bar_rubric_revision)
      VALUES (${WORKSPACE}, ${HARNESS}, 'census-target', 'Census target', 'ready', ${content}, md5(${content}),
              1, 'legacy-backfilled', NULL, NULL, NULL)`;
    const censusSql = db.sql as unknown as AcceptanceBarCensusSql;
    const first = await runAcceptanceBarCensus(censusSql, {
      workspaceId: WORKSPACE,
      harnessSlug: HARNESS,
      measuredAt: new Date('2026-09-05T00:00:00.000Z'),
    });
    const second = await runAcceptanceBarCensus(censusSql, {
      workspaceId: WORKSPACE,
      harnessSlug: HARNESS,
      measuredAt: new Date('2026-09-05T00:00:00.000Z'),
    });
    expect(second).toEqual(first);
    expect(first).toMatchObject({
      schemaVersion: 1,
      requirementsAdoption: { numerator: 1, denominator: 1, percent: 100 },
      barCoverage: { numerator: 0, denominator: 1, percent: 0 },
      residuals: [{ planSlug: 'census-target', reasons: expect.arrayContaining(['bar_set_hash_missing', 'rubric_missing_or_unreadable']) }],
    });
  });
});
