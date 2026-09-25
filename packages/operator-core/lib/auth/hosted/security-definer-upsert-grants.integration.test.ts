/**
 * RECURRENCE GUARD for the class behind WI-10002240 / WI-10002367.
 *
 * Incident: every real hosted self-serve signup silently bounced the user back to
 * the entry page. The cause was NOT in the sign-up code at all — it was a GRANT:
 *
 *   migration 1188:138  GRANT INSERT ON papercusp_auth.legal_acceptances TO hosted_owner;
 *
 * while the SECURITY DEFINER function that owns that write upserts:
 *
 *   INSERT INTO papercusp_auth.legal_acceptances (...) ON CONFLICT (...) DO NOTHING;
 *
 * PostgreSQL requires **SELECT** on the target table to evaluate an ON CONFLICT
 * arbiter index. With INSERT alone the SECURITY DEFINER function DENIES ITSELF with
 * 42501 (aclcheck_error). Because the admission runs in a single transaction, the
 * whole signup rolled back: no rows anywhere, nothing logged, and the route mapped
 * the throw to a generic recovery redirect. A missing GRANT never self-heals, so the
 * owner hit the identical failure on every attempt.
 *
 * The guard is deliberately written against the CLASS, not the one table: any
 * SECURITY DEFINER function in papercusp_auth that upserts must have an OWNER
 * holding SELECT on each table it inserts into. A new function with the same
 * privilege gap fails here instead of silently bouncing real users.
 */
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFreshTestDb, type MigratedTestDb } from '@papercusp/test-config/pg';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * The chain that creates legal_acceptances (907), the SECURITY DEFINER signup
 * functions + their grants (1188), and the SELECT grant this guard exists for
 * (1191). Migration 978 also needs the customer workspace directory from 906.
 */
const MIGRATIONS = [
  '903-customer-organization-boundary.sql',
  '904-hosted-identity-links.sql',
  '906-customer-workspace-directory.sql',
  '907-hosted-governance.sql',
  // 978 carries the hosted_owner grants on the organization/membership tables.
  // Omitting it makes this guard fire on bootstrap_hosted_self_signup_membership(),
  // which is a FIXTURE gap, not a product defect — the live schema has those grants.
  '978-hosted-customer-rls.sql',
  '1188-hosted-self-signup.sql',
  '1191-hosted-self-signup-legal-acceptances-select-grant.sql',
];

function migrationPath(file: string): string {
  const armed = path.resolve(HERE, '../../../../../libs/papercusp/libs/db/sql', file);
  if (existsSync(armed)) return armed;
  const draft = `${armed}.DRAFT`;
  if (existsSync(draft)) return draft;
  throw new Error(`migration not found at ${armed}[.DRAFT]`);
}

let db: MigratedTestDb;
let sql: Sql;

async function provisionMigrationRoles(): Promise<void> {
  await sql.unsafe(`
    DO $$
    DECLARE
      target_role text;
    BEGIN
      FOREACH target_role IN ARRAY ARRAY[
        'hosted_owner', 'hosted_app', 'hosted_service', 'harness_app', 'harness_zero', 'postgres_app'
      ]
      LOOP
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = target_role) THEN
          EXECUTE format(
            'CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS',
            target_role
          );
        END IF;
      END LOOP;
      EXECUTE format('GRANT hosted_owner, hosted_app, hosted_service TO %I', current_user);
    END
    $$;
  `);
}

beforeAll(async () => {
  db = await createFreshTestDb({ prefix: 'secdefupsertgrants' });
  sql = postgres(db.url, { max: 1, onnotice: () => {} });
  await provisionMigrationRoles();
  // Fresh test databases have no baseline. 906 needs the existing host identity
  // table, and 978 needs the directory tables 906 creates.
  await sql.unsafe(`
    CREATE SCHEMA harness_shared;
    CREATE TABLE harness_shared.workspace_hosts (
      workspace_id text NOT NULL,
      id text NOT NULL,
      PRIMARY KEY (workspace_id, id)
    );
  `);
  for (const file of MIGRATIONS) {
    await sql.unsafe(readFileSync(migrationPath(file), 'utf8'));
  }
}, 300_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 }).catch(() => {});
});

interface DefinerFn {
  schema: string;
  name: string;
  owner: string;
  body: string;
}

/** Tables a function body INSERTs into while using ON CONFLICT. */
function upsertTargets(body: string): string[] {
  if (!/ON\s+CONFLICT/i.test(body)) return [];
  const targets = new Set<string>();
  const re = /INSERT\s+INTO\s+(?:papercusp_auth\.)?("?[a-z_][a-z0-9_]*"?)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) targets.add(m[1].replace(/"/g, ''));
  return [...targets];
}

describe('SECURITY DEFINER upsert functions hold SELECT on their own targets', () => {
  it('every papercusp_auth SECURITY DEFINER function that upserts can evaluate its ON CONFLICT arbiter', async () => {
    const fns = await sql<DefinerFn[]>`
      SELECT n.nspname                  AS schema,
             p.proname                  AS name,
             pg_get_userbyid(p.proowner) AS owner,
             pg_get_functiondef(p.oid)  AS body
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'papercusp_auth'
         AND p.prosecdef
    `;

    // Positive control: if the migration set stops producing SECURITY DEFINER
    // functions at all, this guard would pass vacuously. Fail loudly instead —
    // a zero-population assertion is indistinguishable from a satisfied one.
    expect(
      fns.length,
      'no SECURITY DEFINER functions found in papercusp_auth — the guard would pass vacuously',
    ).toBeGreaterThan(0);

    const violations: string[] = [];
    let upsertFnCount = 0;

    for (const fn of fns) {
      const targets = upsertTargets(fn.body);
      if (targets.length === 0) continue;
      upsertFnCount += 1;

      for (const table of targets) {
        const [row] = await sql<Array<{ has_select: boolean }>>`
          SELECT has_table_privilege(
                   ${fn.owner}, ${'papercusp_auth.' + table}, 'SELECT'
                 ) AS has_select
        `;
        if (!row?.has_select) {
          violations.push(
            `${fn.schema}.${fn.name}() is SECURITY DEFINER owned by "${fn.owner}" and upserts into ` +
              `papercusp_auth.${table}, but "${fn.owner}" lacks SELECT on it. PostgreSQL needs SELECT to ` +
              `evaluate an ON CONFLICT arbiter, so this function will fail 42501 at runtime and roll back ` +
              `its whole transaction. Add: GRANT SELECT ON papercusp_auth.${table} TO ${fn.owner};`,
          );
        }
      }
    }

    // Second control: the specific function from the incident must be in scope,
    // so a refactor that renames or inlines it cannot silently empty this guard.
    expect(
      upsertFnCount,
      'no SECURITY DEFINER function with an ON CONFLICT body was detected — check upsertTargets()',
    ).toBeGreaterThan(0);

    expect(violations, violations.join('\n')).toEqual([]);
  }, 300_000);

  it('regression: record_hosted_self_signup_legal can read legal_acceptances (the exact 1188 defect)', async () => {
    const [fn] = await sql<Array<{ owner: string }>>`
      SELECT pg_get_userbyid(p.proowner) AS owner
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'papercusp_auth'
         AND p.proname = 'record_hosted_self_signup_legal'
    `;
    expect(fn?.owner, 'record_hosted_self_signup_legal() is missing from the migrated schema').toBeTruthy();

    const [privs] = await sql<Array<{ can_insert: boolean; can_select: boolean }>>`
      SELECT has_table_privilege(${fn.owner}, 'papercusp_auth.legal_acceptances', 'INSERT') AS can_insert,
             has_table_privilege(${fn.owner}, 'papercusp_auth.legal_acceptances', 'SELECT') AS can_select
    `;
    expect(privs.can_insert).toBe(true);
    // The bug: this was false, so the function denied itself on its own upsert.
    expect(
      privs.can_select,
      `${fn.owner} lacks SELECT on papercusp_auth.legal_acceptances — hosted self-serve signup will fail 42501`,
    ).toBe(true);
  }, 300_000);
});
