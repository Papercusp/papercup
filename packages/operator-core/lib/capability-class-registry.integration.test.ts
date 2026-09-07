/** Real-PG recurrence guard for migration 1140 and the P-016 registry/binding store. */
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  applyMigrationForTest,
  createFreshPgDb,
  type FreshPgDb,
} from '../test/_pg-helpers';
import { PROSE_VECTOR_DIMS } from './search/prose-vector-dims';
import {
  bindCapabilityProviderToPot,
  deletePotCapabilityProviderBinding,
  defineCapabilityClass,
  getCapabilityClass,
  getPotCapabilityProviderBinding,
  listActiveCapabilityProviderCandidates,
  listCapabilityClasses,
  listCapabilityProviderDependents,
  listProviderBindings,
  recordProviderConformance,
  type ProviderConformanceReport,
} from './capability-class-registry-store';

const MIGRATION_1140 = fileURLToPath(
  new URL('../../../libs/papercusp/libs/db/sql/1140-capability-class-registry.sql', import.meta.url),
);
const MIGRATION_1141_BASE = fileURLToPath(
  new URL('../../../libs/papercusp/libs/db/sql/1141-enforce-capability-class-passing-bindings.sql', import.meta.url),
);
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
  let db: FreshPgDb;

  beforeAll(async () => {
    db = await createFreshPgDb('capclass');
    await db.sql.unsafe('CREATE EXTENSION IF NOT EXISTS vector');
    await applyMigrationForTest(db.sql, MIGRATION_1140);
    await applyMigrationForTest(db.sql, MIGRATION_1141_BASE);
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
    const first = await defineCapabilityClass(db.sql, base);
    expect(first.created).toBe(true);
    expect(first.conflict).toBe(false);
    expect(first.capabilityClass.hasEmbedding).toBe(true);

    const replay = await defineCapabilityClass(db.sql, base);
    expect(replay).toMatchObject({ created: false, conflict: false });
    const conflict = await defineCapabilityClass(db.sql, { ...base, description: 'changed without a new version' });
    expect(conflict).toMatchObject({ created: false, conflict: true });

    const got = await getCapabilityClass(db.sql, 'ws-classes', 'crm.email', '1.0.0');
    expect(got?.ref).toBe('crm.email@1.0.0');
    const found = await listCapabilityClasses(db.sql, 'ws-classes', { query: 'customer email' });
    expect(found.map((row) => row.ref)).toContain('crm.email@1.0.0');
    expect(await getCapabilityClass(db.sql, 'other-workspace', 'crm.email', '1.0.0')).toBeNull();
  });

  it('records every run but derives a provider binding only from a passing run', async () => {
    const workspaceId = 'ws-binding';
    await defineCapabilityClass(db.sql, {
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
    const failed = await recordProviderConformance(db.sql, { ...common, report: report(false) });
    expect(failed.binding).toBeNull();
    expect(await listProviderBindings(db.sql, workspaceId, 'crm.email', '1.0.0')).toEqual([]);

    await expect(db.sql`
      INSERT INTO harness_shared.capability_class_provider_bindings
        (workspace_id, class_id, class_version, provider_package, provider_version, conformance_run_id)
      VALUES (${workspaceId}, 'crm.email', '1.0.0', 'acme-crm', '2.0.0', ${failed.runId})
    `).rejects.toThrow(/capability_class_provider_run_fk/);

    await expect(recordProviderConformance(db.sql, {
      ...common,
      report: { ...report(true), providerPackage: 'spoofed-provider' },
    })).rejects.toThrow(/report identity does not match/);

    const passed = await recordProviderConformance(db.sql, { ...common, report: report(true) });
    expect(passed.binding).toMatchObject({
      classRef: 'crm.email@1.0.0',
      providerPackage: 'acme-crm',
      conformanceRunId: passed.runId,
      conformanceStatus: 'passed',
    });
    const providers = await listProviderBindings(db.sql, workspaceId, 'crm.email', '1.0.0');
    expect(providers).toHaveLength(1);
    expect(providers[0]?.conformanceRunId).toBe(passed.runId);

    await expect(db.sql`
      INSERT INTO harness_shared.capability_class_provider_bindings
        (workspace_id, class_id, class_version, provider_package, provider_version, conformance_run_id)
      VALUES (${workspaceId}, 'crm.email', '1.0.0', 'acme-crm', '2.0.1', ${passed.runId})
    `).rejects.toThrow(/capability_class_provider_run_fk/);

    await bindCapabilityProviderToPot(db.sql, {
      workspaceId,
      potSlug: 'sales-ops',
      classId: 'crm.email',
      classVersion: '1.0.0',
      providerPackage: 'acme-crm',
      providerVersion: '2.0.0',
      boundBy: 'operator-1',
    });
    const rows = await db.sql<{ provider_package: string; provider_version: string }[]>`
      SELECT provider_package, provider_version
        FROM harness_shared.pot_capability_class_bindings
       WHERE workspace_id = ${workspaceId} AND pot_slug = 'sales-ops'`;
    expect(rows).toEqual([{ provider_package: 'acme-crm', provider_version: '2.0.0' }]);

    const current = await getPotCapabilityProviderBinding(db.sql, {
      workspaceId,
      potSlug: 'sales-ops',
      classId: 'crm.email',
      classVersion: '1.0.0',
    });
    expect(current).toMatchObject({
      potSlug: 'sales-ops',
      classRef: 'crm.email@1.0.0',
      providerPackage: 'acme-crm',
      providerVersion: '2.0.0',
      conformanceRunId: passed.runId,
    });
    expect(await getPotCapabilityProviderBinding(db.sql, {
      workspaceId,
      potSlug: 'other-pot',
      classId: 'crm.email',
      classVersion: '1.0.0',
    })).toBeNull();
    expect(await getPotCapabilityProviderBinding(db.sql, {
      workspaceId,
      potSlug: 'sales-ops',
      classId: 'crm.email',
      classVersion: '1.0.0',
      includeInactiveProvider: true,
    })).toMatchObject({
      providerPackage: 'acme-crm',
      status: 'retired',
    });

    const candidates = await listActiveCapabilityProviderCandidates(
      db.sql,
      workspaceId,
      'crm.email',
      '1.0.0',
    );
    expect(candidates).toEqual([
      expect.objectContaining({
        providerPackage: 'acme-crm',
        passingStructuralRuns: 1,
        totalStructuralRuns: 2,
        activePotBindings: 1,
      }),
    ]);

    await db.sql.unsafe(
      "UPDATE harness_shared.capability_class_provider_bindings SET status = 'retired' " +
      "WHERE workspace_id = 'ws-binding' AND provider_package = 'acme-crm'",
    );
    expect(await getPotCapabilityProviderBinding(db.sql, {
      workspaceId,
      potSlug: 'sales-ops',
      classId: 'crm.email',
      classVersion: '1.0.0',
    })).toBeNull();
    expect(await listActiveCapabilityProviderCandidates(
      db.sql,
      workspaceId,
      'crm.email',
      '1.0.0',
    )).toEqual([]);

    const dependents = await listCapabilityProviderDependents(db.sql, {
      workspaceId,
      providerPackage: 'acme-crm',
      providerVersion: '2.0.0',
    });
    expect(dependents).toEqual([
      expect.objectContaining({
        potSlug: 'sales-ops',
        classRef: 'crm.email@1.0.0',
        providerPackage: 'acme-crm',
        providerVersion: '2.0.0',
      }),
    ]);
    expect(await listCapabilityProviderDependents(db.sql, {
      workspaceId,
      providerPackage: 'acme-crm',
      providerVersion: '9.9.9',
    })).toEqual([]);
    expect(await deletePotCapabilityProviderBinding(db.sql, {
      workspaceId,
      potSlug: 'sales-ops',
      classId: 'crm.email',
      classVersion: '1.0.0',
      expectedProviderPackage: 'acme-crm',
      expectedProviderVersion: '2.0.0',
    })).toBe(true);
    expect(await listCapabilityProviderDependents(db.sql, {
      workspaceId,
      providerPackage: 'acme-crm',
    })).toEqual([]);
  });
});
