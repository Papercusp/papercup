/**
 * EI-20202338985443847 — the mixed-principal coord_owner_id classifier.
 *
 * This is an integration guard because the classifier is SQL that every
 * adoption writer shares. A source-only test could prove that a query names a
 * function while missing the function's actual boundary cases.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createFreshTestDb, type MigratedTestDb } from '@papercusp/test-config/pg';

const ROOT = join(__dirname, '../../../../');
const MIGRATION_PATH = join(ROOT, 'libs/papercusp/libs/db/sql/802-agent-owner-predicate.sql');

const ADOPTION_WRITERS = [
  'scripts/check-plane-adoption.mjs',
  'scripts/stats-proof.ts',
  'packages/operator-core/lib/agent-tools/coordination/dispatch-adoption-sample.ts',
  'packages/operator-core/lib/scout/enforcement-tier-census.ts',
] as const;

describe('is_agent_coord_owner_id — mixed-principal telemetry boundary', () => {
  let db: MigratedTestDb;
  let sql: Sql;

  beforeAll(async () => {
    db = await createFreshTestDb({ prefix: 'agent-owner' });
    sql = postgres(db.url, { max: 1, prepare: false, onnotice: () => {} });
    await sql.unsafe('CREATE SCHEMA IF NOT EXISTS harness_shared');
    await sql.unsafe(
      'CREATE TABLE harness_shared.tool_invocations (coord_owner_id text, role text NOT NULL)',
    );
    await sql.unsafe(readFileSync(MIGRATION_PATH, 'utf8'));
  }, 180_000);

  afterAll(async () => {
    await sql?.end({ timeout: 5 }).catch(() => {});
    await db?.drop?.().catch(() => {});
  });

  it('classifies individual identities and excludes system/UI/test/shared principals', async () => {
    const rows = await sql<Array<{ owner_id: string | null; role: string; expected: boolean; is_agent: boolean }>>`
      SELECT v.owner_id,
             v.role,
             v.expected,
             harness_shared.is_agent_coord_owner_id(v.owner_id, v.role) AS is_agent
        FROM (VALUES
          ('su-agent-1'::text, 'operator'::text, true),
          ('s-child-1'::text, 'cup'::text, true),
          ('pus-session-1'::text, 'operator'::text, true),
          ('6cd1db84-be48-414a-bb2c-fd9d842b200a'::text, 'release-fixer'::text, true),
          ('84e1d015-fed8-4462-a17d-6d559f609d48'::text, 'content-fixer'::text, true),
          ('28dbf719-be48-414a-bb2c-fd9d842b200a'::text, 'operator'::text, false),
          ('system:predicate-watch:abc'::text, 'release-fixer'::text, false),
          ('e2e-hooklive-1'::text, 'operator'::text, false),
          ('mcp-call-123'::text, 'operator'::text, false),
          ('harness:papercusp'::text, 'cup'::text, false),
          ('su-loopback'::text, 'operator'::text, false),
          (NULL::text, 'operator'::text, false)
        ) AS v(owner_id, role, expected)
    `;

    expect(rows).toHaveLength(12);
    expect(rows.every((row) => row.is_agent === row.expected)).toBe(true);
  });

  it.each(ADOPTION_WRITERS)('routes %s through the canonical predicate', (relativePath) => {
    const source = readFileSync(join(ROOT, relativePath), 'utf8');
    expect(source).toContain('harness_shared.is_agent_coord_owner_id(coord_owner_id, role)');
  });
});
