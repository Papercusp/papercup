/** Real-PG recurrence guard for migration 1140 and the P-016 registry/binding store. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OrgTestDb } from '../test/_org-test-db';
import { PROSE_VECTOR_DIMS } from './search/prose-vector-dims';
import {
  bindCapabilityProviderToPot,
  defineCapabilityClass,
  getCapabilityClass,
  listCapabilityClasses,
  listProviderBindings,
  recordProviderConformance,
  type ProviderConformanceReport,
} from './capability-class-registry-store';

const { createOrgTestDb } = await import('../test/_org-test-db');
const embedding = (): number[] => Array.from({ length: PROSE_VECTOR_DIMS }, () => 0.2);
const verbs = {
  send: {
    inputSchema: {
      type: 'object',
      properties: { body: { type: 'string' } },
      required: ['body'],
    },
  },
};

function report(ok: boolean): ProviderConformanceReport {
  return {
    schemaVersion: 'capability-class-structural-v1',
    ok,
    classRef: 'crm.email@1.0.0',
    providerPackage: 'acme-crm',
    providerVersion: '2.0.0',
    registryRevision: 'registry-r1',
    checks: [{ verb: 'send', tool: 'acme:send-email', ok, problems: ok ? [] : ['input schema differs'] }],
    behavioral: { status: 'not-required', suiteRef: null },
  };
}

describe('capability class registry (real PG)', () => {
  let db: OrgTestDb;

  beforeAll(async () => {
    db = await createOrgTestDb();
  }, 120_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  it('keeps class@version immutable and discovers it through tsv/embedding fields', async () => {
    const base = {
      workspaceId: 'ws-classes',
      id: 'crm.email',
      version: '1.0.0',
      title: 'CRM email delivery',
      description: 'Send customer email from a CRM contact record.',
      interfaceVerbs: verbs,
      embedding: embedding(),
      tags: ['crm', 'email'],
      createdBy: 'operator-1',
    };
    const first = await defineCapabilityClass(db.adminSql, base);
    expect(first.created).toBe(true);
    expect(first.conflict).toBe(false);
    expect(first.capabilityClass.hasEmbedding).toBe(true);

    const replay = await defineCapabilityClass(db.adminSql, base);
    expect(replay).toMatchObject({ created: false, conflict: false });
    const conflict = await defineCapabilityClass(db.adminSql, { ...base, description: 'changed without a new version' });
    expect(conflict).toMatchObject({ created: false, conflict: true });

    const got = await getCapabilityClass(db.adminSql, 'ws-classes', 'crm.email', '1.0.0');
    expect(got?.ref).toBe('crm.email@1.0.0');
    const found = await listCapabilityClasses(db.adminSql, 'ws-classes', { query: 'customer email' });
    expect(found.map((row) => row.ref)).toContain('crm.email@1.0.0');
    expect(await getCapabilityClass(db.adminSql, 'other-workspace', 'crm.email', '1.0.0')).toBeNull();
  });

  it('records every run but derives a provider binding only from a passing run', async () => {
    const workspaceId = 'ws-binding';
    await defineCapabilityClass(db.adminSql, {
      workspaceId,
      id: 'crm.email',
      version: '1.0.0',
      title: 'CRM email',
      description: 'Send customer email.',
      interfaceVerbs: verbs,
      createdBy: 'operator-1',
    });
    const common = {
      workspaceId,
      classId: 'crm.email',
      classVersion: '1.0.0',
      providerPackage: 'acme-crm',
      providerVersion: '2.0.0',
      verbBindings: { send: 'acme:send-email' },
      performedBy: 'su-test',
    };
    const failed = await recordProviderConformance(db.adminSql, { ...common, report: report(false) });
    expect(failed.binding).toBeNull();
    expect(await listProviderBindings(db.adminSql, workspaceId, 'crm.email', '1.0.0')).toEqual([]);

    const passed = await recordProviderConformance(db.adminSql, { ...common, report: report(true) });
    expect(passed.binding).toMatchObject({
      classRef: 'crm.email@1.0.0',
      providerPackage: 'acme-crm',
      conformanceRunId: passed.runId,
      conformanceStatus: 'passed',
    });
    const providers = await listProviderBindings(db.adminSql, workspaceId, 'crm.email', '1.0.0');
    expect(providers).toHaveLength(1);
    expect(providers[0]?.conformanceRunId).toBe(passed.runId);

    await bindCapabilityProviderToPot(db.adminSql, {
      workspaceId,
      potSlug: 'sales-ops',
      classId: 'crm.email',
      classVersion: '1.0.0',
      providerPackage: 'acme-crm',
      providerVersion: '2.0.0',
      boundBy: 'operator-1',
    });
    const rows = await db.adminSql<{ provider_package: string; provider_version: string }[]>`
      SELECT provider_package, provider_version
        FROM harness_shared.pot_capability_class_bindings
       WHERE workspace_id = ${workspaceId} AND pot_slug = 'sales-ops'`;
    expect(rows).toEqual([{ provider_package: 'acme-crm', provider_version: '2.0.0' }]);
  });
});
