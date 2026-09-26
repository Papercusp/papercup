import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Mem0Backend, HybridBackend, LexicalLegBackend, NoopBackend } from '@papercusp/memory';
import { CanonicalVectorStore } from '../../../../libs/generic/memory/src/canonical-store';
import { CanonicalManagedWrites } from '../../../../libs/generic/memory/src/canonical-managed-writes';
import { EMBEDDER_DIM_SPECS } from '../../../../libs/generic/memory/src/embedder-dims';
import { MEMORY_VECTOR_STORAGE_PROFILES } from '../../../../libs/generic/memory/src/vec-write';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { packageMemoryDriver } from './package-memory-driver';
import { preparePackageResource, releasePackageResource, type PackageResourceAddress } from './package-resource-receipts';

let db: OrgTestDb;
let pool: Pool;
const stores: CanonicalVectorStore[] = [];
const scope = 'harness:managed-write-tests';
const vector = Array(EMBEDDER_DIM_SPECS.local.targetDims).fill(0.1);
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const opts = { scope, verbatim: true, metadata: { package_id: 'test', private: true } };

beforeAll(async () => {
  db = await createOrgTestDb();
  const draft = new URL('../../../../libs/papercusp/libs/db/sql/1231-memory-managed-write-fences.sql.DRAFT', import.meta.url);
  // Draft verification before arming; afterwards the migrated fixture owns it.
  if (existsSync(draft)) await db.adminSql.unsafe(readFileSync(draft, 'utf8'));
  pool = new Pool({ connectionString: db.adminDsn });
}, 180_000);
afterAll(async () => {
  await Promise.all(stores.map((store) => store.dispose()));
  await pool?.end();
  await db?.cleanup();
});

function writes(embed = async () => vector) {
  return new CanonicalManagedWrites({ pool: async () => pool, schema: 'harness_shared',
    vecTable: 'memory_vec_local', dims: vector.length, embed });
}
function backend(managedWrites = writes()) {
  return new Mem0Backend({ getClient: async () => null, managedWrites });
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
function address(name: string): PackageResourceAddress {
  return { workspaceId: 'managed-write-test', memoryScope: scope, packageKind: 'knowledge-pack',
    packageRef: name, packageVersion: '1', packageHash: hash(name), resourceKind: 'memory',
    itemKey: 'one', installedHash: hash('text') };
}

describe('real canonical backend package resources', () => {
  it('creates once under concurrent retries and keeps prepared content out of lexical/vector/list recall', async () => {
    const key = randomUUID();
    const store = canonicalStore();
    const managed = store.managedWrites(async () => vector);
    const [a, b] = await Promise.all([managed.create(key, 'hidden unique fruit', opts), managed.create(key, 'hidden unique fruit', opts)]);
    expect(a).toEqual(b);
    expect(a).toEqual([{ id: key, fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) }]);
    expect(await db.adminSql`SELECT id FROM harness_shared.memory_canonical WHERE id = ${key}`).toHaveLength(1);
    expect(await store.search(vector, 20, { user_id: scope })).toEqual([]);
    expect(await store.lexicalSearch('hidden unique fruit', 20, { user_id: scope })).toEqual([]);
    const [listed] = await store.list({ user_id: scope }, 20);
    expect(listed).toEqual([]);
    await expect(managed.create(key, 'replacement', opts)).rejects.toThrow(/different content/);
    await expect(managed.cancel(key, 'another-scope')).rejects.toThrow(/scope mismatch/);
  });

  it('fences cancellation before create, during a delayed embed, and after hard deletion', async () => {
    const pre = randomUUID();
    await writes().cancel(pre, scope);
    await expect(writes().create(pre, 'late arrival', opts)).rejects.toThrow(/canceled/);
    let enter!: () => void;
    let finish!: (value: number[]) => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    const delayed = writes(async () => { enter(); return new Promise<number[]>((resolve) => { finish = resolve; }); });
    const key = randomUUID();
    const result = delayed.create(key, 'late embed', opts).catch((error) => error);
    await entered;
    await writes().cancel(key, scope);
    finish(vector);
    expect(await result).toMatchObject({ message: 'managed memory write canceled' });
    expect(await writes().recover(key, scope)).toEqual([]);
    expect(await db.adminSql`SELECT id FROM harness_shared.memory_canonical WHERE id = ${key}`).toHaveLength(0);
    const deleted = randomUUID();
    const [ref] = await writes().create(deleted, 'privacy deletion', opts);
    await canonicalStore().delete(deleted);
    expect(await writes().create(deleted, 'privacy deletion', opts)).toEqual([{ ...ref, disposition: 'absent' }]);
    expect(await writes().recover(deleted, scope)).toEqual([{ ...ref, disposition: 'absent' }]);
  });

  it('preserves edited content and original fingerprints, and atomically removes only pristine rows', async () => {
    const store = canonicalStore();
    const managed = store.managedWrites(async () => vector);
    const key = randomUUID();
    const [original] = await managed.create(key, 'user will edit', opts);
    await store.updatePayload(key, { data: 'user-owned revision', access: 'still-private' });
    expect(await writes().recover(key, scope)).toEqual([{ ...original, disposition: 'changed' }]);
    expect(await managed.removeIfUnchanged(original!, scope)).toBe('changed');
    expect((await store.get(key))?.payload.data).toBe('user-owned revision');
    const cleanKey = randomUUID();
    const [clean] = await managed.create(cleanKey, 'pristine', opts);
    await expect(managed.removeIfUnchanged({ ...clean!, fingerprint: hash('forged') }, scope)).rejects.toThrow(/receipt mismatch/);
    expect(await managed.removeIfUnchanged(clean!, scope)).toBe('removed');
    expect(await managed.removeIfUnchanged(clean!, scope)).toBe('absent');
    expect(await db.adminSql`SELECT memory_id FROM harness_shared.memory_vec_local WHERE memory_id = ${cleanKey}`).toHaveLength(0);
    await expect(managed.create(cleanKey, 'pristine', opts)).rejects.toThrow(/canceled/);
    // The durable fence must not become a hidden copy of the deleted body.
    const fence = await db.adminSql`SELECT * FROM harness_shared.memory_managed_writes WHERE write_key = ${cleanKey}`;
    expect(JSON.stringify(fence)).not.toContain('pristine');
  });

  it('rolls back canonical and receipt writes together when the vector insert fails', async () => {
    const key = randomUUID();
    const broken = new CanonicalManagedWrites({ pool: async () => pool, schema: 'harness_shared',
      vecTable: 'no_such_vector_table', dims: vector.length, embed: async () => vector });
    await expect(broken.create(key, 'transactional write', opts)).rejects.toThrow(/no_such_vector_table/);
    expect(await db.adminSql`SELECT id FROM harness_shared.memory_canonical WHERE id = ${key}`).toHaveLength(0);
    expect(await writes().recover(key, scope)).toEqual([]);
    expect(await writes().create(key, 'transactional write', opts)).toHaveLength(1);
  });

  it('the package journal cancels an uncertain in-flight backend write before reporting cleanup complete', async () => {
    let enter!: () => void;
    let finish!: (value: number[]) => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    const managed = writes(async () => { enter(); return new Promise<number[]>((resolve) => { finish = resolve; }); });
    const driver = packageMemoryDriver(backend(managed), 'text', opts);
    const input = address('uncertain-late');
    let pending!: Promise<unknown>;
    const ambiguous = { ...driver, create: async (key: string) => {
      pending = driver.create(key).catch((error) => error);
      await entered;
      throw new Error('caller timed out while embedding');
    } };
    await expect(preparePackageResource(db.adminSql, input, 'late-install', ambiguous)).rejects.toThrow(/timed out/);
    const receipt = await releasePackageResource(db.adminSql, input, 'late-install', driver);
    expect(receipt?.phase).toBe('deleted');
    finish(vector);
    expect(await pending).toMatchObject({ message: 'managed memory write canceled' });
    expect(await driver.recover(receipt!.write_key)).toEqual([]);
  });

  it('recovers a real child process killed after backend commit but before the package receipt', async () => {
    const driver = packageMemoryDriver(backend(), 'text', opts);
    const input = address('process-kill');
    const moduleUrl = new URL('../../../../libs/generic/memory/src/canonical-managed-writes.ts', import.meta.url).href;
    const killed = { ...driver, create: async (key: string) => {
      const code = `import { Pool } from 'pg';
        import { CanonicalManagedWrites } from ${JSON.stringify(moduleUrl)};
        const pool = new Pool({ connectionString: process.env.MANAGED_TEST_DSN });
        const w = new CanonicalManagedWrites({ pool: async () => pool, schema: 'harness_shared',
          vecTable: 'memory_vec_local', dims: ${vector.length}, embed: async () => Array(${vector.length}).fill(0.1) });
        await w.create(${JSON.stringify(key)}, 'text', ${JSON.stringify(opts)});
        process.kill(process.pid, 'SIGKILL');`;
      await new Promise<void>((resolve, reject) => {
        const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code],
          { env: { ...process.env, MANAGED_TEST_DSN: db.adminDsn }, stdio: ['ignore', 'ignore', 'pipe'],
            signal: AbortSignal.timeout(20_000) });
        let stderr = '';
        child.stderr.on('data', (chunk) => { stderr += String(chunk); });
        child.on('error', reject);
        child.on('exit', (code, signal) => signal === 'SIGKILL' ? resolve() : reject(new Error(`child ${code}/${signal}: ${stderr}`)));
      });
      throw new Error('process died before receipt commit');
    } };
    await expect(preparePackageResource(db.adminSql, input, 'killed-install', killed)).rejects.toThrow(/process died/);
    const restarted = packageMemoryDriver(backend(), 'text', opts);
    const recovered = await preparePackageResource(db.adminSql, input, 'killed-install', restarted);
    expect(recovered.phase).toBe('ready');
    expect(recovered.external_refs).toHaveLength(1);
    expect(await releasePackageResource(db.adminSql, input, 'killed-install', restarted)).toMatchObject({ phase: 'deleted' });
  }, 30_000);

  it('shares the PG hybrid resource, and refuses an unfenced separate projection before writing', async () => {
    const pg = backend();
    const shared = new HybridBackend(new LexicalLegBackend(pg), pg);
    expect(shared.managedWrites).toBe(pg.managedWrites);
    const driver = packageMemoryDriver(shared, 'text', opts);
    const input = address('hybrid-shared');
    const first = await preparePackageResource(db.adminSql, input, 'wearer-a', driver);
    const second = await preparePackageResource(db.adminSql, input, 'wearer-b', driver);
    expect(first.external_refs).toEqual(second.external_refs);
    expect(await releasePackageResource(db.adminSql, input, 'wearer-a', driver)).toMatchObject({ phase: 'ready' });
    expect(await releasePackageResource(db.adminSql, input, 'wearer-b', driver)).toMatchObject({ phase: 'deleted' });
    const separate = new HybridBackend(new NoopBackend(), pg);
    const ordinary = vi.spyOn(pg, 'remember');
    expect(() => packageMemoryDriver(separate, 'text', opts)).toThrow(/does not support fenced/);
    expect(ordinary).not.toHaveBeenCalled();
  });
});
