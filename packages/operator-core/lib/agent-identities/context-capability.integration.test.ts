/** portable-identity-packages P-004 / PORTABLE-P-004@1 — a declared context
 * capability (class@major + verb) resolves, through the real registry tables and
 * the real identity binder, to ONE exact-version conformed provider with its
 * contract output schema and explicit sync execution kind. Counterexamples: an
 * unknown class, an unbound class, an async provider and an output that fails
 * the pinned schema never bind silently. */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import type { Sql } from 'postgres';
import { layerContentHash } from '@papercusp/orchestrator/blueprint';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { bindSelectedIdentityOutputArtifact, bindSelectedIdentityOutputs } from './source';

const pg = vi.hoisted(() => ({ sql: null as Sql | null }));
vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: pg.sql }),
}));

const WS = 'ctx-capability-ws';
const POT = 'ctx-capability-pot';
const OUTPUT_SCHEMA = {
  type: 'object',
  properties: { notes: { type: 'string' } },
  required: ['notes'],
  additionalProperties: false,
};

describe('context capability contributions (real PG + real binder)', () => {
  let db: OrgTestDb;
  let root: string;

  async function registerClass(id: string, version: string, opts: {
    outputSchema?: Record<string, unknown>; provider?: string; kind?: string; latency?: string; bindPot?: boolean;
  } = {}) {
    const sql = db.adminSql;
    const verbs = { read: { inputSchema: { type: 'object' },
      ...(opts.outputSchema ? { outputSchema: opts.outputSchema } : {}) } };
    await sql`
      INSERT INTO harness_shared.capability_class_registry
        (workspace_id, id, version, title, description, interface_verbs)
      VALUES (${WS}, ${id}, ${version}, ${id}, 'context fixture', ${JSON.stringify(verbs)}::jsonb)`;
    if (!opts.provider) return;
    const run = `run-${id}-${version}`;
    const kind = opts.kind ?? 'tool';
    const latency = opts.latency ?? 'sync';
    await sql`
      INSERT INTO harness_shared.capability_class_conformance_runs
        (id, workspace_id, class_id, class_version, provider_package, provider_version,
         registry_revision, verb_bindings, structural_passed, report, provider_kind, latency_class)
      VALUES (${run}, ${WS}, ${id}, ${version}, ${opts.provider}, '1.0.0',
        'registry-1', ${sql.json({ read: `${opts.provider}:read` })}, true, '{}'::jsonb, ${kind}, ${latency})`;
    await sql`
      INSERT INTO harness_shared.capability_class_provider_bindings
        (workspace_id, class_id, class_version, provider_package, provider_version,
         conformance_run_id, provider_kind, latency_class)
      VALUES (${WS}, ${id}, ${version}, ${opts.provider}, '1.0.0', ${run}, ${kind}, ${latency})`;
    if (opts.bindPot === false) return;
    await sql`
      INSERT INTO harness_shared.pot_capability_class_bindings
        (workspace_id, pot_slug, class_id, class_version, provider_package, provider_version,
         provider_kind, latency_class)
      VALUES (${WS}, ${POT}, ${id}, ${version}, ${opts.provider}, '1.0.0', ${kind}, ${latency})`;
  }

  function writeIdentity(identityId: string, contributions: Array<Record<string, unknown>>) {
    const dir = join(root, 'home', 'blueprints', identityId);
    mkdirSync(join(dir, 'prompts'), { recursive: true });
    const identity = { id: identityId, extends: 'base', version: '1.0.0', slots: [{ slot: 'domain' }], contributions };
    writeFileSync(join(dir, 'blueprint.yaml'), stringifyYaml({
      ...identity, attestation: { contentHash: layerContentHash(identity), signedBy: 'approved-publisher' },
    }));
  }

  const context = (id: string, ref: string, availability: 'required' | 'optional' = 'required') => ({
    id, purpose: 'resource', source: 'provider', refresh: 'turn', inputKind: 'capability-provider',
    ref, verb: 'read', producerRef: ref, availability,
  });
  const bind = (identityId: string, outputs: Array<{ contributionId: string; value: unknown }>) =>
    bindSelectedIdentityOutputArtifact({
      identityId, outputs,
      scope: { workspace: WS, harness: POT, sink: 'turn-start' },
      observedAt: '2026-09-29T16:00:00.000Z',
    });

  beforeAll(async () => {
    db = await createOrgTestDb();
    pg.sql = db.adminSql;
    root = mkdtempSync(join(tmpdir(), 'context-capability-'));
    vi.stubEnv('PAPERCUSP_HOME', join(root, 'home'));
    // Two stable versions the pot selected: the major pins the newest one.
    await registerClass('context.notes', '1.0.0', { outputSchema: OUTPUT_SCHEMA, provider: 'notes-old' });
    await registerClass('context.notes', '1.2.0', { outputSchema: OUTPUT_SCHEMA, provider: 'notes-tool' });
    await registerClass('context.unbound', '1.0.0', { outputSchema: OUTPUT_SCHEMA, provider: 'lonely', bindPot: false });
    await registerClass('context.slow', '1.0.0', { outputSchema: OUTPUT_SCHEMA, provider: 'slow-op', kind: 'operation', latency: 'async' });
    await registerClass('context.shapeless', '1.0.0', { provider: 'shapeless-tool' });
  }, 180_000);

  afterAll(async () => {
    vi.unstubAllEnvs();
    pg.sql = null;
    if (root) rmSync(root, { recursive: true, force: true });
    await db?.cleanup();
  });

  it('pins class@major to the exact conformed sync provider and binds schema-valid output with provenance', async () => {
    writeIdentity('ctx-happy', [context('notes', 'context.notes@1')]);
    const json = JSON.stringify({ notes: 'standup at 10' });
    const bound = await bind('ctx-happy', [{ contributionId: 'notes', value: json }]);

    expect(bound.artifact.inputs).toContainEqual({
      kind: 'capability-provider',
      ref: 'context.notes@1.2.0',
      providerPackage: 'notes-tool',
      providerVersion: '1.0.0',
      conformanceRunId: 'run-context.notes-1.2.0',
      registryRevision: expect.any(String),
      verbBindings: { read: 'notes-tool:read' },
      context: {
        requestedRef: 'context.notes@1', verb: 'read', providerKind: 'tool', latencyClass: 'sync',
        outputSchema: OUTPUT_SCHEMA,
      },
    });
    expect(bound.artifact.provenance).toContainEqual(expect.objectContaining({
      path: 'contribution.notes',
      sourceRef: 'capability-provider:context.notes@1#read',
      sourceRevision: 'context.notes@1.2.0:tool/sync:1.0.0@run-context.notes-1.2.0',
      producerRef: 'context.notes@1',
    }));
    const delivered = bound.capabilityOutputs.find((entry) => entry.contributionId === 'notes');
    expect(delivered).toBeDefined();
    expect(JSON.parse(delivered!.text)).toMatchObject({
      provenance: { classRef: 'context.notes@1.2.0', providerRef: 'notes-tool@1.0.0', identityRef: 'ctx-happy' },
      value: { notes: 'standup at 10' },
    });
    expect(bound.contributions).toContainEqual({
      contributionId: 'notes', producerRef: 'context.notes@1', status: 'bound',
      outputRevision: createHash('sha256').update(delivered!.text).digest('hex'),
      classRef: 'context.notes@1.2.0', providerRef: 'notes-tool@1.0.0',
    });
    // The public receipt carries the pin, never the live output bytes.
    const receipt = await bindSelectedIdentityOutputs({
      identityId: 'ctx-happy', outputs: [{ contributionId: 'notes', value: json }],
      scope: { workspace: WS, harness: POT, sink: 'turn-start' }, observedAt: '2026-09-29T16:00:00.000Z',
    });
    expect(receipt).not.toHaveProperty('artifact');
    expect(receipt).not.toHaveProperty('capabilityOutputs');
    expect(receipt.contributions[0]).toMatchObject({ status: 'bound', classRef: 'context.notes@1.2.0' });
  }, 120_000);

  it('refuses an output that fails the pinned contract schema instead of binding it', async () => {
    writeIdentity('ctx-mismatch', [context('notes', 'context.notes@1')]);
    await expect(bind('ctx-mismatch', [{ contributionId: 'notes', value: JSON.stringify({ notes: 42 }) }]))
      .rejects.toThrow(/output refused: schema-mismatch/);
    writeIdentity('ctx-mismatch-optional', [context('notes', 'context.notes@1', 'optional')]);
    const optional = await bind('ctx-mismatch-optional',
      [{ contributionId: 'notes', value: JSON.stringify({ notes: 'x', extra: true }) }]);
    expect(optional.contributions).toContainEqual(expect.objectContaining({
      contributionId: 'notes', status: 'omitted:unavailable', outputRevision: null,
      errorRef: 'capability-output:schema-mismatch',
    }));
    expect(optional.capabilityOutputs).toEqual([]);
  }, 120_000);

  it.each([
    ['an unknown class', 'context.missing@1', /class-unknown/],
    ['a class the pot never bound', 'context.unbound@1', /class-unbound/],
    ['an async operation provider', 'context.slow@1', /operation-unavailable/],
    ['a contract verb without an output schema', 'context.shapeless@1', /output-schema-missing/],
  ])('refuses to compile a required context capability for %s', async (_label, ref, code) => {
    const identityId = `ctx-refuse-${ref.split('@')[0]!.replace('.', '-')}`;
    writeIdentity(identityId, [context('ctx', ref)]);
    await expect(bind(identityId, [{ contributionId: 'ctx', value: JSON.stringify({ notes: 'n' }) }]))
      .rejects.toThrow(code);
  }, 120_000);

  it('records an optional unbindable class as an explicit unavailable omission, never a pin', async () => {
    writeIdentity('ctx-optional-unbound', [
      context('notes', 'context.notes@1'),
      context('extra', 'context.unbound@1', 'optional'),
    ]);
    const bound = await bind('ctx-optional-unbound', [
      { contributionId: 'notes', value: JSON.stringify({ notes: 'ok' }) },
      { contributionId: 'extra', value: JSON.stringify({ notes: 'should not bind' }) },
    ]);
    expect(bound.artifact.inputs.some((entry) => entry.kind === 'capability-provider' &&
      entry.ref.startsWith('context.unbound@'))).toBe(false);
    expect(bound.artifact.provenance).toContainEqual(expect.objectContaining({
      path: 'contribution.extra', decision: 'omitted:unavailable',
      sourceRevision: 'capability-class:class-unbound',
    }));
    expect(bound.contributions).toContainEqual(expect.objectContaining({
      contributionId: 'extra', status: 'omitted:unavailable', errorRef: 'capability-class:not-pinned',
    }));
    expect(bound.capabilityOutputs.map((entry) => entry.contributionId)).toEqual(['notes']);
  }, 120_000);
});
