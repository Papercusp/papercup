/**
 * portable-identity-packages P-009 / D-022 — a knowledge pack's doc items install as
 * journaled `doc-part` resources addressed `package:<resourceKey>`. Real PG, the real
 * session lifecycle: exact-version sharing across wearers, per-wearer visibility (the
 * guide read, the docs:search source, the transition's before/after keys), pristine
 * cleanup, edited-part preservation, and failed-preparation compensation.
 */
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { pinPackageInput, resolveBlueprint } from '@papercusp/orchestrator/blueprint';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { compileBlueprintWithPackages } from './compile-packages';
import { applySessionPackageResources, provisionSessionPackageResources, releaseSupersededSessionPackages,
  sessionPackageDocKeysForRevision } from './session-package-resources';
import { resolveWearerPackageDocKeys } from './package-memory-visibility';
import { PACKAGE_DOC_USER_OWNED, planKnowledgeDocResources, searchWearerPackageDocs } from './package-doc-resources';
import { readAddressedGuideParts } from '../doc-projection/addressed-project-guide';
import { guideAddressesForWearer } from '../doc-projection/guide-address';
import type { PackDocItem } from '../knowledge-packs/pack-format';

// A docs-only pack writes no memory, but the knowledge provisioner refuses a backend
// without fenced writes before its first row — so the stub only has to advertise them.
vi.mock('../memory/backend', () => ({ getMemoryBackend: () => ({ name: 'doc-only-stub', managedWrites: {} }) }));

let db: OrgTestDb;
beforeAll(async () => { db = await createOrgTestDb(); }, 180_000);
afterAll(async () => { await db?.cleanup(); });

const TARGET = 'doc-target';
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const DOCS: PackDocItem[] = [
  { id: 'first', title: 'Allocate migrations', section: 'Storage', kind: 'recipe', body: 'Run the migration allocator before writing SQL.' },
  { id: 'second', title: 'Runbook pointer', section: 'Workflow', kind: 'pointer', body: 'See the release runbook.' },
];
const partKey = (version: string, doc: string) => `pack:procedures@${version}:${doc}`;

function pin(version: string) {
  return pinPackageInput({ packageKind: 'knowledge-pack', ref: 'procedures', revision: version, files: [],
    value: { manifest: { id: 'procedures', version, title: 'Procedures', description: 'Test' }, items: [], docs: DOCS } });
}

type DocRow = { part_key: string; author: string | null; origin: string; body: string;
  client_scope: string[]; target_section: string | null; stack_scope: string[] };

function workspace(workspaceId: string) {
  const compile = (version: string | null) => compileBlueprintWithPackages(
    resolveBlueprint({ id: 'doc-host', workItem: { kind: 'feature' }, spine: { edges: { DONE: { to: 'done' } } },
      bundles: version ? [{ kind: 'knowledge-pack' as const, ref: 'procedures' }] : [] }),
    { workspaceId, harnessSlug: TARGET, memoryTarget: { kind: 'harness', slug: TARGET },
      knowledgeSelection: { shapes: [], domains: [] }, resolvePackage: async () => pin(version!) });
  const provision = async (ownerId: string, version: string | null, state: string) => {
    const artifact = await compile(version);
    const revision = { specificationRevision: artifact.specificationRevision, stateRevision: hash(state) };
    const { dependentId } = await provisionSessionPackageResources(db.adminSql, { ownerId, revision, artifacts: [artifact] });
    return { dependentId, input: { ownerId, workspaceId, revision, artifact } };
  };
  /** Activation commits the fence; post-commit cleanup of what it superseded follows, as in production. */
  const apply = async (prepared: Awaited<ReturnType<typeof provision>>) => {
    const { superseded } = await db.adminSql.begin((tx) => applySessionPackageResources(tx, prepared.input));
    await releaseSupersededSessionPackages(db.adminSql, superseded);
    return superseded;
  };
  const parts = () => db.adminSql<DocRow[]>`SELECT part_key, author, origin, body, client_scope, target_section, stack_scope
    FROM harness_shared.harness_doc_parts WHERE workspace_id = ${workspaceId} ORDER BY part_key`;
  /** Independent of any install: the keys the pin's doc items address, in doc order. */
  const keys = (version: string) =>
    planKnowledgeDocResources({ pin: pin(version), workspaceId, harnessSlug: TARGET }).map((p) => p.resourceKey);
  const wearerKeys = (ownerId: string) => resolveWearerPackageDocKeys(db.adminSql, { workspaceId, ownerId });
  const installations = (ownerId: string) => db.adminSql<Array<{ phase: string }>>`SELECT phase
    FROM harness_shared.blueprint_package_installations WHERE workspace_id = ${workspaceId} AND owner_id = ${ownerId}`;
  return { provision, apply, parts, keys, wearerKeys, installations };
}

describe('pack doc parts as journaled identity-package resources (P-009)', () => {
  it('shares one exact-version part across wearers, keeps versions distinct, and reaches only wearers', async () => {
    const ws = 'doc-share-test';
    const h = workspace(ws);
    const v1 = h.keys('1.0.0');
    const v2 = h.keys('2.0.0');
    expect(new Set([...v1, ...v2]).size).toBe(4);

    const a1 = await h.provision('wearer-a', '1.0.0', 'a1');
    // Prepared, not applied: the transition's `after` already holds the revision's keys; applied reads do not.
    expect(await sessionPackageDocKeysForRevision(db.adminSql, a1.input)).toEqual([...v1].sort());
    expect(await h.wearerKeys('wearer-a')).toEqual([]);
    expect(await h.apply(a1)).toEqual([]);
    await h.apply(await h.provision('wearer-b', '1.0.0', 'b1'));

    const rows = await h.parts();
    expect(rows.map((r) => r.part_key)).toEqual([partKey('1.0.0', 'first'), partKey('1.0.0', 'second')]);
    expect(rows[0]).toEqual({ part_key: partKey('1.0.0', 'first'), origin: 'identity-package',
      author: expect.stringMatching(/^blueprint-package-resource:/), client_scope: ['all'], target_section: 'Storage',
      stack_scope: [`package:${v1[0]}`], body: '**Allocate migrations**\n\nRun the migration allocator before writing SQL.' });
    expect(rows[1]!.stack_scope).toEqual([`package:${v1[1]}`]);
    expect(await h.wearerKeys('wearer-a')).toEqual([...v1].sort());
    expect(await h.wearerKeys('wearer-b')).toEqual([...v1].sort());
    expect(await h.wearerKeys('not-a-wearer')).toEqual([]);

    // The guide read: a package token matches in whichever harness installed the part;
    // a non-wearer's tokens (even in that very harness) reach nothing.
    const read = async (ownerId: string, harnessSlug: string) => (await readAddressedGuideParts({
      workspaceId: ws, harnessSlug, client: 'claude', sql: db.adminSql,
      tokens: guideAddressesForWearer({ role: 'su', layers: [], packageResources: await h.wearerKeys(ownerId) }),
    })).map((p) => p.part_key);
    expect(await read('wearer-a', 'another-harness')).toEqual(rows.map((r) => r.part_key));
    expect(await read('not-a-wearer', TARGET)).toEqual([]);

    // docs:search's pack-doc source is bounded by the same keys.
    expect(await searchWearerPackageDocs(db.adminSql, { workspaceId: ws, ownerId: 'wearer-a', query: 'migration allocator', limit: 5 }))
      .toEqual([expect.objectContaining({ partKey: partKey('1.0.0', 'first'), harnessSlug: TARGET, section: 'Storage',
        title: 'Allocate migrations', excerpt: 'Run the migration allocator before writing SQL.' })]);
    expect(await searchWearerPackageDocs(db.adminSql, { workspaceId: ws, ownerId: 'not-a-wearer', query: 'migration allocator', limit: 5 }))
      .toEqual([]);

    // A upgrades: v2 is a distinct pair of parts, visible to the transition before activation.
    const a2 = await h.provision('wearer-a', '2.0.0', 'a2');
    expect(await sessionPackageDocKeysForRevision(db.adminSql, a2.input)).toEqual([...v2].sort());
    expect(await h.wearerKeys('wearer-a')).toEqual([...v1].sort());
    expect(await h.apply(a2)).toEqual([{ workspaceId: ws, dependentId: a1.dependentId }]);
    expect(await h.wearerKeys('wearer-a')).toEqual([...v2].sort());
    // B still depends on v1, so A's release leaves both versions installed.
    expect((await h.parts()).map((r) => r.part_key)).toEqual([partKey('1.0.0', 'first'), partKey('1.0.0', 'second'),
      partKey('2.0.0', 'first'), partKey('2.0.0', 'second')]);

    // B detaches (no journaled package): nothing after, and the final release deletes the pristine v1 parts.
    const b2 = await h.provision('wearer-b', null, 'b2');
    expect(await sessionPackageDocKeysForRevision(db.adminSql, b2.input)).toEqual([]);
    await h.apply(b2);
    expect((await h.parts()).map((r) => r.part_key)).toEqual([partKey('2.0.0', 'first'), partKey('2.0.0', 'second')]);
    expect(await h.wearerKeys('wearer-b')).toEqual([]);
    // No artifact ⇒ the applied keys keep covering.
    expect(await sessionPackageDocKeysForRevision(db.adminSql, { ...a2.input, artifact: null })).toEqual([...v2].sort());
  });

  it('re-owns an edited part on final release instead of deleting it, and refuses to re-install over it', async () => {
    const ws = 'doc-edit-test';
    const h = workspace(ws);
    const [, secondKey] = h.keys('1.0.0');
    await h.apply(await h.provision('wearer-a', '1.0.0', 'a1'));
    await db.adminSql`UPDATE harness_shared.harness_doc_parts SET body = 'User-edited runbook pointer.'
      WHERE workspace_id = ${ws} AND part_key = ${partKey('1.0.0', 'second')}`;

    await h.apply(await h.provision('wearer-a', null, 'a2'));
    // The pristine part is gone; the edited one is the user's now, and keeps its (now unheld) address.
    expect(await h.parts()).toEqual([{ part_key: partKey('1.0.0', 'second'), body: 'User-edited runbook pointer.',
      author: PACKAGE_DOC_USER_OWNED, origin: `identity-package-detached:${secondKey}`, client_scope: ['all'],
      target_section: 'Workflow', stack_scope: [`package:${secondKey}`] }]);
    const [receipt] = await db.adminSql`SELECT phase, external_refs FROM harness_shared.blueprint_package_resources
      WHERE workspace_id = ${ws} AND resource_key = ${secondKey}`;
    expect(receipt).toMatchObject({ phase: 'detached', external_refs: [{ id: partKey('1.0.0', 'second'), disposition: 'changed' }] });
    expect(await h.wearerKeys('wearer-a')).toEqual([]);

    // A new install of the same exact version stops at the edited part and compensates
    // what it had already created: nothing is overwritten and nothing is left behind.
    await expect(h.provision('wearer-b', '1.0.0', 'b1')).rejects.toThrow(/edited; explicit review is required/);
    expect(await h.installations('wearer-b')).toEqual([{ phase: 'released' }]);
    expect((await h.parts()).map((r) => [r.part_key, r.author])).toEqual([[partKey('1.0.0', 'second'), PACKAGE_DOC_USER_OWNED]]);
  });

  it('compensates a preparation whose doc slot holds a part the package does not own, leaving that part untouched', async () => {
    const ws = 'doc-conflict-test';
    const h = workspace(ws);
    await db.adminSql`INSERT INTO harness_shared.harness_doc_parts
        (workspace_id, harness_slug, doc_id, part_key, kind, body, ordinal, origin, author, client_scope, target_section)
      VALUES (${ws}, ${TARGET}, 'claude-md', ${partKey('1.0.0', 'second')}, 'pointer', 'A local part.', 1, 'local',
        'someone-else', ${['all']}, 'Workflow')`;
    await expect(h.provision('wearer-a', '1.0.0', 'a1')).rejects.toThrow(/package-pin-conflict/);
    expect(await h.installations('wearer-a')).toEqual([{ phase: 'released' }]);
    expect(await h.parts()).toEqual([{ part_key: partKey('1.0.0', 'second'), body: 'A local part.', author: 'someone-else',
      origin: 'local', client_scope: ['all'], target_section: 'Workflow', stack_scope: [] }]);
    expect(await h.wearerKeys('wearer-a')).toEqual([]);
  });
});
