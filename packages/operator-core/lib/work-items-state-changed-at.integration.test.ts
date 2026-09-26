/**
 * Migration 896 — work_items.state_changed_at against real migrated Postgres.
 *
 * `updated_ts` is advanced by metadata-only writers such as issue topic-tagging,
 * so it cannot be used as a parked-state age. This test runs the real migration,
 * writes through the real engineer_issues compatibility view, and proves that a
 * tag update leaves the state clock alone while a real state transition advances it.
 *
 * Run:
 *   npm run test:file -- packages/operator-core/lib/work-items-state-changed-at.integration.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import postgres, { type Sql } from 'postgres';
import { createFreshTestDb, type MigratedTestDb } from '@papercusp/test-config/pg';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..', '..');
const sqlDir = join(repo, 'libs', 'papercusp', 'libs', 'db', 'sql');
const runner = join(repo, 'libs', 'papercusp', 'packages', 'embedded-postgres-server', 'src', 'migration-runner.js');
const migration896 = join(sqlDir, '896-work-items-state-changed-at.sql');
const migration896Draft = `${migration896}.DRAFT`;

const bootPrereqsDdl = `
  DO $pg$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='harness_app')   THEN CREATE ROLE harness_app   LOGIN PASSWORD 'harness_app_pwd'; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='harness_admin') THEN CREATE ROLE harness_admin LOGIN SUPERUSER PASSWORD 'harness_admin_pwd'; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='harness_zero')  THEN CREATE ROLE harness_zero  LOGIN REPLICATION SUPERUSER PASSWORD 'harness_zero_pwd'; END IF;
  END $pg$;
  CREATE EXTENSION IF NOT EXISTS pgcrypto;
  CREATE EXTENSION IF NOT EXISTS pg_trgm;
  CREATE EXTENSION IF NOT EXISTS vector;
`;

function readMigration896(): string {
  const path = existsSync(migration896) ? migration896 : migration896Draft;
  if (!existsSync(path)) throw new Error(`migration 896 not found at ${migration896}[.DRAFT]`);
  const text = readFileSync(path, 'utf8');
  if (!text.includes('stamp_work_item_state_changed_at')) {
    throw new Error(`migration 896 at ${path} does not define the state clock trigger`);
  }
  // The production runner strips psql directives and supplies the transaction
  // wrapper. The test applies this one file through postgres.js directly.
  return text
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('\\') && !/^(BEGIN|COMMIT);\s*$/i.test(line.trim()))
    .join('\n');
}

async function provision(url: string): Promise<void> {
  const client = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await client.unsafe(bootPrereqsDdl);
    const { applyPendingMigrations } = (await import(pathToFileURL(runner).href)) as {
      applyPendingMigrations: (opts: { client: Sql; sqlDir: string }) =>
        Promise<{ appliedCount: number; totalKnown: number }>;
    };
    const result = await applyPendingMigrations({ client, sqlDir });
    if (result.appliedCount !== result.totalKnown) {
      throw new Error(`migration provision incomplete: ${result.appliedCount}/${result.totalKnown}`);
    }
  } finally {
    await client.end({ timeout: 5 });
  }
}

let db: MigratedTestDb;
let sql: Sql;

function iso(value: Date | string | null): string | null {
  return value instanceof Date ? value.toISOString() : value;
}

function numeric(value: number | string | bigint): number {
  return Number(value);
}

beforeAll(async () => {
  db = await createFreshTestDb({ prefix: 'wi-state-clock', provision });
  sql = postgres(db.url, { max: 4, onnotice: () => {}, prepare: false });
  await sql.unsafe(readMigration896()).simple();
}, 600_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 }).catch(() => {});
  await db?.drop().catch(() => {});
});

describe('migration 896 — work-item state age clock', () => {
  it('freezes metadata-only issue tag writes and advances on a real state transition', async () => {
    const issueId = 'EI-896-state-clock';
    const origin = '2026-08-01T12:00:00.000Z';

    await sql`
      INSERT INTO harness_shared.engineer_issues
        (workspace_id, issue_id, scope, title, body, state, kind, origin, created_at, updated_at)
      VALUES
        ('ws-896', ${issueId}, 'harness:papercusp', 'state clock', 'body', 'open', 'bug', 'local',
         ${origin}, ${origin})`;

    const [inserted] = await sql<{
      status: string;
      state_changed_at: string | null;
      updated_ts: number;
      tags: unknown;
    }[]>`
      SELECT status, state_changed_at, updated_ts, payload -> 'tags' AS tags
        FROM harness_shared.work_items
       WHERE workspace_id = 'ws-896' AND feature_id = ${issueId}`;
    expect(inserted.status).toBe('open');
    expect(iso(inserted.state_changed_at)).toBe(origin);
    expect(inserted.tags).toBeNull();
    const beforeMetadata = iso(inserted.state_changed_at);
    const beforeUpdatedTs = inserted.updated_ts;

    // This is the issue-family write shape used by work-item topic tagging:
    // payload metadata changes and updated_at moves, but state remains open.
    await sql`
      UPDATE harness_shared.engineer_issues
         SET payload = COALESCE(payload, '{}'::jsonb) || '{"tags":["migration-896"]}'::jsonb,
             updated_at = now()
       WHERE workspace_id = 'ws-896' AND issue_id = ${issueId}`;

    const [afterMetadata] = await sql<{
      status: string;
      state_changed_at: string | null;
      updated_ts: number;
      tags: unknown;
    }[]>`
      SELECT status, state_changed_at, updated_ts, payload -> 'tags' AS tags
        FROM harness_shared.work_items
       WHERE workspace_id = 'ws-896' AND feature_id = ${issueId}`;
    expect(afterMetadata.status).toBe('open');
    expect(iso(afterMetadata.state_changed_at)).toBe(beforeMetadata);
    expect(numeric(afterMetadata.updated_ts)).toBeGreaterThan(numeric(beforeUpdatedTs));
    expect(afterMetadata.tags).toEqual(['migration-896']);

    await sql`
      UPDATE harness_shared.engineer_issues
         SET state = 'wip', updated_at = now()
       WHERE workspace_id = 'ws-896' AND issue_id = ${issueId}`;

    const [afterTransition] = await sql<{ status: string; state_changed_at: string | null }[]>`
      SELECT status, state_changed_at
        FROM harness_shared.work_items
       WHERE workspace_id = 'ws-896' AND feature_id = ${issueId}`;
    expect(afterTransition.status).toBe('wip');
    const afterTransitionAt = iso(afterTransition.state_changed_at);
    expect(afterTransitionAt).not.toBe(beforeMetadata);
    expect(Date.parse(afterTransitionAt!)).toBeGreaterThan(Date.parse(beforeMetadata!));
  });

  it('exposes the new clock through the issue compatibility view and installs its trigger', async () => {
    const [column] = await sql<{ exists: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'harness_shared'
           AND table_name = 'engineer_issues'
           AND column_name = 'state_changed_at'
      ) AS exists`;
    const [trigger] = await sql<{ exists: boolean }[]>`
      SELECT EXISTS (
        SELECT 1
          FROM pg_trigger t
          JOIN pg_class c ON c.oid = t.tgrelid
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'harness_shared'
           AND c.relname = 'work_items'
           -- mig 1227 renamed it to fire before stamp_local_federated_write_trg (WI-10003230)
           AND t.tgname = 'stamp_before_fed_work_item_state_changed_at_trg'
           AND NOT t.tgisinternal
      ) AS exists`;
    expect(column.exists).toBe(true);
    expect(trigger.exists).toBe(true);
  });
});
