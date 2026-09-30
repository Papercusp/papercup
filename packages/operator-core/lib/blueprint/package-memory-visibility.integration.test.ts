/** P-007 / D-021 against the real canonical store: identity-installed pack rows
 * are recalled only by wearers whose applied specification pins that exact
 * version, on both recall legs, while ordinary rows stay visible to everyone. */
import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Mem0Backend, type MemoryEntry } from '@papercusp/memory';
import { CanonicalVectorStore } from '../../../../libs/generic/memory/src/canonical-store';
import { CanonicalManagedWrites } from '../../../../libs/generic/memory/src/canonical-managed-writes';
import { EMBEDDER_DIM_SPECS } from '../../../../libs/generic/memory/src/embedder-dims';
import { MEMORY_VECTOR_STORAGE_PROFILES } from '../../../../libs/generic/memory/src/vec-write';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { pinPackageInput, resolveBlueprint } from '@papercusp/orchestrator/blueprint';
import { compileBlueprintWithPackages } from './compile-packages';
import { applySessionPackageResources, provisionSessionPackageResources,
  releaseSupersededSessionPackages } from './session-package-resources';
import { packageRecallEligibility, promoteIdentityPackageMemory, resolveWearerPackageResources,
  shapeIdentityPackageHits } from './package-memory-visibility';

let db: OrgTestDb;
let pool: Pool;
let selectedBackend: Mem0Backend;
vi.mock('../memory/backend', () => ({ getMemoryBackend: () => selectedBackend }));
const stores: CanonicalVectorStore[] = [];
const workspaceId = 'visibility-test';
const target = 'visibility-target';
const scope = 'harness:' + target;
const vector = Array(EMBEDDER_DIM_SPECS.local.targetDims).fill(0.1);
const hash = (s: string) => createHash('sha256').update(s).digest('hex');

beforeAll(async () => {
  db = await createOrgTestDb();
  pool = new Pool({ connectionString: db.adminDsn });
}, 180_000);
afterAll(async () => {
  await Promise.all(stores.map((store) => store.dispose()));
  await pool?.end();
  await db?.cleanup();
});

function writes() {
  return new CanonicalManagedWrites({ pool: async () => pool, schema: 'harness_shared',
    vecTable: 'memory_vec_local', dims: vector.length, embed: async () => vector });
}
function canonicalStore() {
  const url = new URL(db.adminDsn);
  const store = new CanonicalVectorStore({ host: url.hostname, port: Number(url.port),
    user: decodeURIComponent(url.username), password: decodeURIComponent(url.password), dbname: url.pathname.slice(1),
    schema: 'harness_shared', vecTable: 'memory_vec_local', embeddingModelDims: vector.length,
    embeddingProfile: EMBEDDER_DIM_SPECS.local, storageProfile: MEMORY_VECTOR_STORAGE_PROFILES.local });
  stores.push(store);
  return store;
}
/** Both production recall legs over the real store, so the eligibility control
 * crosses Mem0Backend's filter encoding into the canonical SQL. */
function recallBackend(store: CanonicalVectorStore) {
  return new Mem0Backend({ getClient: async () => ({}) as never, managedWrites: writes(),
    vectorSearch: (query, topK, filters) => store.search(query, topK, filters),
    lexicalSearch: (query, topK, filters) => store.lexicalSearch(query, topK, filters) });
}

describe('identity package recall visibility (real canonical store)', () => {
  it('admits exactly the applied pack version per wearer across upgrade, detach and reviewed promotion', async () => {
    const pack = (version: string) => pinPackageInput({ packageKind: 'knowledge-pack', ref: 'visibility-pack',
      revision: version, files: [], value: { manifest: { id: 'visibility-pack', version, title: 'Visibility',
        description: 'Test' }, items: [{ id: 'shared', title: 'Shared', text: 'shared ' + version,
        kind: 'reference', appliesTo: ['any'] }] } });
    const compile = (version: string | null) => compileBlueprintWithPackages(
      resolveBlueprint({ id: 'visibility-host', workItem: { kind: 'feature' }, spine: { edges: { DONE: { to: 'done' } } },
        bundles: version ? [{ kind: 'knowledge-pack' as const, ref: 'visibility-pack' }] : [] }),
      { workspaceId, harnessSlug: target, memoryTarget: { kind: 'harness', slug: target },
        knowledgeSelection: { shapes: [], domains: [] }, resolvePackage: async () => pack(version!) });
    const wear = async (ownerId: string, version: string | null, state: string) => {
      const artifact = await compile(version);
      const revision = { specificationRevision: artifact.specificationRevision, stateRevision: hash(state) };
      await provisionSessionPackageResources(db.adminSql, { ownerId, revision, artifacts: [artifact] });
      const { superseded } = await db.adminSql.begin((tx) =>
        applySessionPackageResources(tx, { ownerId, workspaceId, revision, artifact }));
      await releaseSupersededSessionPackages(db.adminSql, superseded);
    };
    const store = canonicalStore();
    const recall = recallBackend(store);
    const recallAs = async (ownerId: string) => {
      const pinned = await resolveWearerPackageResources(db.adminSql, { workspaceId, ownerId });
      const opts = { scope, limit: 50, vector, ...packageRecallEligibility(pinned) };
      const semantic = shapeIdentityPackageHits(await recall.search('shared', opts), pinned);
      const lexical = shapeIdentityPackageHits(await recall.searchLexical('shared', opts), pinned);
      const texts = (hits: MemoryEntry[]) => hits.map((hit) => hit.text).sort();
      expect(texts(lexical)).toEqual(texts(semantic)); // one eligibility rule on both legs
      return { texts: texts(semantic), hits: semantic };
    };
    const receipt = async (version: string) => (await db.adminSql<Array<{ phase: string }>>`
      SELECT phase FROM harness_shared.blueprint_package_resources
       WHERE workspace_id = ${workspaceId} AND item_key = 'shared' AND package_version = ${version}`)[0];
    selectedBackend = new Mem0Backend({ getClient: async () => null, managedWrites: writes() });

    // Ordinary (organic) memory in the same harness pool.
    const organicId = randomUUID();
    await writes().create(organicId, 'Shared organic note', { scope, verbatim: true, metadata: { source: 'agent' } });
    await db.adminSql`UPDATE harness_shared.memory_canonical SET state = 'active' WHERE id = ${organicId}`;
    const organic = 'Shared organic note';
    const v1 = 'Shared — shared 1.0.0';
    const v2 = 'Shared — shared 2.0.0';

    // Two wearers on different exact versions; both versions sit archived in ONE pool.
    await wear('wearer-a', '1.0.0', 'a1');
    await wear('wearer-b', '2.0.0', 'b1');
    const a = await recallAs('wearer-a');
    expect(a.texts).toEqual([organic, v1]);
    expect((await recallAs('wearer-b')).texts).toEqual([organic, v2]);
    // Counterexample: a non-wearer recalls no private pack row, and organic recall is not suppressed.
    expect((await recallAs('non-wearer')).texts).toEqual([organic]);
    expect(a.hits.find((hit) => hit.text === v1)!.metadata).toMatchObject({ source: 'pack',
      identity_package: { pack_id: 'visibility-pack', pack_version: '1.0.0', pack_item_id: 'shared', pinned: true } });
    expect(a.hits.find((hit) => hit.text === organic)!.metadata).not.toHaveProperty('identity_package');
    // Unfiltered list recall and a malformed control admit no archived row.
    const [listed] = await store.list({ user_id: scope }, 50);
    expect(listed.map((row) => row.payload.data)).toEqual([organic]);
    expect((await store.search(vector, 50, { user_id: scope, archived_eligible: 'not json' }))
      .map((row) => row.payload.data)).toEqual([organic]);

    // Upgrade: A moves to v2; v1 lost its last dependent and is gone.
    await wear('wearer-a', '2.0.0', 'a2');
    expect((await recallAs('wearer-a')).texts).toEqual([organic, v2]);
    expect(await receipt('1.0.0')).toMatchObject({ phase: 'deleted' });

    // Detach: B stops wearing; A still sees its own pin.
    await wear('wearer-b', null, 'b2');
    expect((await recallAs('wearer-b')).texts).toEqual([organic]);
    expect((await recallAs('wearer-a')).texts).toEqual([organic, v2]);

    // Reviewed promotion makes the row pool-wide and survives the last wearer's detach.
    const [{ id: promoted }] = await db.adminSql<Array<{ id: string }>>`SELECT id FROM harness_shared.memory_canonical
      WHERE payload->>'user_id' = ${scope} AND payload->>'pack_version' = '2.0.0'`;
    await expect(promoteIdentityPackageMemory(db.adminSql, { memoryId: promoted, reviewedBy: ' ', reason: 'useful' }))
      .rejects.toThrow(/reviewer and a reason/);
    expect(await promoteIdentityPackageMemory(db.adminSql, { memoryId: promoted, reviewedBy: 'reviewer', reason: 'useful' }))
      .toBe(true);
    expect(await promoteIdentityPackageMemory(db.adminSql, { memoryId: promoted, reviewedBy: 'reviewer', reason: 'again' }))
      .toBe(false);
    expect(await promoteIdentityPackageMemory(db.adminSql, { memoryId: organicId, reviewedBy: 'reviewer', reason: 'x' }))
      .toBe(false);
    const outsider = await recallAs('non-wearer');
    expect(outsider.texts).toEqual([organic, v2]);
    expect(outsider.hits.find((hit) => hit.text === v2)!.metadata).toMatchObject({
      identity_package: { pack_version: '2.0.0', pinned: false },
      identity_package_promotion: { reviewed_by: 'reviewer', reason: 'useful' } });
    await wear('wearer-a', null, 'a3');
    expect(await receipt('2.0.0')).toMatchObject({ phase: 'detached' });
    expect((await recallAs('wearer-a')).texts).toEqual([organic, v2]);
    expect(await resolveWearerPackageResources(db.adminSql, { workspaceId, ownerId: 'wearer-a' })).toEqual(new Set());
  });
});
