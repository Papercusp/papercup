/**
 * WI-10004427 recurrence guard (unit tier).
 *
 * pg_dump never serializes roles, so a logical seed built on a cluster where a
 * migration created a role (978: hosted_owner / hosted_app / hosted_service) carries
 * GRANTs and policies naming roles a fresh install's cluster lacks, and the restore
 * failed on every first boot. The boot path now reads those names out of the dump
 * and pre-creates them. These cases pin the parser against lines copied verbatim
 * from `pg_dump --schema-only --no-owner` of the migrated papercusp database.
 * The end-to-end guard is embedded-pg-logical-seed.integration.test.ts.
 */
import { describe, expect, it } from 'vitest';
import {
  SEED_ROLE_ATTRIBUTES,
  createMissingSeedRoles,
  granteeRolesInRestoreSql,
} from '@papercusp/embedded-postgres-server';

const REAL_DUMP_LINES = [
  "CREATE POLICY customer_workspaces_app_scope ON harness_shared.customer_workspaces TO hosted_app USING (((organization_id = NULLIF(current_setting('app.organization_id'::text, true), ''::text))));",
  "CREATE POLICY external_identities_app_select ON papercusp_auth.external_identities FOR SELECT TO hosted_app USING (((hosted_user_id)::text = NULLIF(current_setting('app.user_id'::text, true), ''::text)));",
  'CREATE POLICY external_identities_service_insert ON papercusp_auth.external_identities FOR INSERT TO hosted_service WITH CHECK (true);',
  'GRANT ALL ON FUNCTION harness_shared.workspace_host_scope_allows(control_workspace_id text, workspace_host_id text) TO hosted_app;',
  'GRANT SELECT,INSERT ON TABLE papercusp_auth.legal_acceptances TO hosted_owner;',
  'GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE harness_shared.pg_query_advisory_fires TO harness_app;',
  'GRANT SELECT ON TABLE papercusp_auth.hosted_user_preferences TO harness_zero;',
  'GRANT USAGE ON SCHEMA harness_shared TO hosted_service;',
  'REVOKE ALL ON FUNCTION harness_shared.workspace_host_scope_allows(control_workspace_id text, workspace_host_id text) FROM PUBLIC;',
].join('\n');

describe('granteeRolesInRestoreSql', () => {
  it('finds every role a real dump grants to or names in a policy, and nothing else', () => {
    expect(granteeRolesInRestoreSql(REAL_DUMP_LINES)).toEqual([
      'harness_app',
      'harness_zero',
      'hosted_app',
      'hosted_owner',
      'hosted_service',
    ]);
  });

  it('never reports pseudo-roles or pg_* built-ins', () => {
    const sql = [
      'REVOKE USAGE ON SCHEMA public FROM PUBLIC;',
      'GRANT ALL ON SCHEMA public TO pg_database_owner;',
      'GRANT SELECT ON TABLE public.t TO CURRENT_USER, SESSION_USER;',
      'CREATE POLICY p ON public.t USING (true);',
    ].join('\n');
    expect(granteeRolesInRestoreSql(sql)).toEqual([]);
  });

  it('parses role lists, quoted names and trailing grant clauses', () => {
    const sql = [
      'GRANT SELECT ON TABLE public.t TO alpha, "Beta ""Quoted""", gamma WITH GRANT OPTION;',
      'GRANT SELECT(from_date, to_date) ON TABLE public.t TO delta GRANTED BY harness_admin;',
      'REVOKE SELECT ON TABLE public.t FROM epsilon CASCADE;',
      'CREATE POLICY p ON public.t AS RESTRICTIVE FOR UPDATE TO zeta, eta USING ((a = 1)) WITH CHECK ((b = 2));',
      'ALTER DEFAULT PRIVILEGES FOR ROLE theta IN SCHEMA public GRANT SELECT ON TABLES TO iota;',
    ].join('\n');
    expect(granteeRolesInRestoreSql(sql)).toEqual([
      'Beta "Quoted"',
      'alpha',
      'delta',
      'epsilon',
      'eta',
      'gamma',
      'iota',
      'theta',
      'zeta',
    ]);
  });

  it('does not read a TO inside a policy expression as a grantee', () => {
    const sql = "CREATE POLICY p ON public.t FOR SELECT USING ((status = 'moved TO archive'::text));";
    expect(granteeRolesInRestoreSql(sql)).toEqual([]);
  });
});

describe('createMissingSeedRoles', () => {
  function fakeSql(existing: string[]) {
    const statements: string[] = [];
    const tag = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
      expect(strings.join('?')).toContain('FROM pg_roles WHERE rolname =');
      return existing.includes(String(values[0])) ? [{ '?column?': 1 }] : [];
    }) as unknown as Parameters<typeof createMissingSeedRoles>[0];
    (tag as unknown as { unsafe: (s: string) => Promise<unknown[]> }).unsafe = async (s: string) => {
      statements.push(s);
      return [];
    };
    return { sql: tag, statements };
  }

  it('creates only the missing roles, locked down, with identifiers quoted', async () => {
    const { sql, statements } = fakeSql(['harness_app']);
    const created = await createMissingSeedRoles(sql, ['harness_app', 'hosted_app', 'odd"name']);
    expect(created).toEqual(['hosted_app', 'odd"name']);
    expect(statements).toEqual([
      `CREATE ROLE "hosted_app" ${SEED_ROLE_ATTRIBUTES}`,
      `CREATE ROLE "odd""name" ${SEED_ROLE_ATTRIBUTES}`,
    ]);
    expect(SEED_ROLE_ATTRIBUTES).toContain('NOLOGIN');
    expect(SEED_ROLE_ATTRIBUTES).toContain('NOBYPASSRLS');
  });
});
