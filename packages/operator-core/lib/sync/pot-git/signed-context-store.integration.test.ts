import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, connect, type Server, type Socket } from 'node:net';
import { createFreshPgDb, type FreshPgDb } from '../../../test/_pg-helpers';
import { generateEd25519KeypairDer, signWithPrivateKeyDer } from '../../identity/ed25519';
import { defaultRunGit, ensurePotGitRepo, writeNamespaceRef, readNamespaceRef } from './storage';
import { resolveStoreProtocolContext } from './signed-context-store';
import { storeGenerationOrdinal, type SignedSnapshotFloor } from './signed-context';
import { buildSigrefs, SIGREFS_REF } from './sigrefs';
import { buildRefAnnouncement, acceptRefAnnouncement, type SignedRefAnnouncement } from './ref-announce';
import { runRefAnnounceReceiveTick, runRefAnnouncePublishTick } from './ref-announce-tick';
import { serveUploadPack } from './fetch-transport';

describe('P-513 persisted store generation and physical Git receiver', () => {
  let db: FreshPgDb, root: string, producer: string, receiver: string, server: Server;
  let previousRoot: string | undefined;
  const scope = { hive_id: 'one-federated-hive-public-key', repo_key: 'gh-42' };
  const key = generateEd25519KeypairDer();
  const sign = async (bytes: Buffer) => signWithPrivateKeyDer(key.privateKeyDer, bytes);
  const resolve = () => resolveStoreProtocolContext({ sql: db.sql, slug: 'local-a', workspaceId: 'w', repoPath: producer, scope, device: key.pubkeyBase64 });
  const dial = () => new Promise<Socket>((resolve, reject) => {
    const socket = connect({ path: join(root, 'peer.sock'), allowHalfOpen: true });
    socket.once('connect', () => resolve(socket));
    socket.once('error', reject);
  });
  beforeAll(async () => {
    db = await createFreshPgDb('signed-store-generation');
    await db.sql`CREATE SCHEMA IF NOT EXISTS harness_shared`;
    await db.sql`CREATE TABLE harness_shared.routines (install_slug text, workspace_id text, target_role text, metadata jsonb)`;
    await db.sql`INSERT INTO harness_shared.routines VALUES ('local-a','w','system:git-sync','{"unrelated":true}'), ('local-a','other','system:git-sync','{}')`;
    root = await mkdtemp(join(tmpdir(), 'signed-generation-'));
    previousRoot = process.env.PAPERCUSP_HIVE_GIT_ROOT;
    process.env.PAPERCUSP_HIVE_GIT_ROOT = root;
    producer = await ensurePotGitRepo('local-hive-a', 'local-a');
    receiver = await ensurePotGitRepo('renamed-local-hive-b', 'local-b');
    server = createServer({ allowHalfOpen: true }, (socket) => { socket.on('error', () => {}); void serveUploadPack(producer, socket); });
    await new Promise<void>((resolve) => server.listen(join(root, 'peer.sock'), resolve));
  }, 180_000);
  afterAll(async () => {
    server?.close();
    if (previousRoot === undefined) delete process.env.PAPERCUSP_HIVE_GIT_ROOT; else process.env.PAPERCUSP_HIVE_GIT_ROOT = previousRoot;
    await db?.cleanup();
    if (root) await rm(root, { recursive: true, force: true });
  });
  async function publish(): Promise<SignedRefAnnouncement> {
    const context = await resolve();
    const tree = await defaultRunGit(['hash-object', '-w', '-t', 'tree', '/dev/null'], producer);
    const commit = await defaultRunGit(['-c','user.name=test','-c','user.email=test@example.invalid','commit-tree',tree.stdout.trim(),'-m','generation fixture'], producer);
    expect(commit.code, commit.stderr).toBe(0);
    await writeNamespaceRef(producer, key.pubkeyBase64, 'refs/heads/work', commit.stdout.trim());
    await buildSigrefs(producer, key.pubkeyBase64, sign, { nowMs: 1, context });
    return buildRefAnnouncement(producer, key.pubkeyBase64, sign, { nowMs: 1, context });
  }
  async function receive(ann: SignedRefAnnouncement, replayFloors: Record<string, SignedSnapshotFloor>) {
    return runRefAnnounceReceiveTick({ repoPath: receiver, pending: [ann], allowedDevices: [key.pubkeyBase64], expectedContext: scope, replayFloors, openStream: dial, nowMs: 10, timeoutMs: 30_000 });
  }

  it('serializes simultaneous first initialization, survives restart, and preserves other metadata/workspaces', async () => {
    const contexts = await Promise.all([resolve(), resolve(), resolve()]);
    expect(contexts.every((c) => c.store_generation === contexts[0]!.store_generation)).toBe(true);
    expect(storeGenerationOrdinal(contexts[0]!.store_generation)).toBe(1);
    expect(await resolve()).toEqual(contexts[0]);
    const rows = await db.sql`SELECT workspace_id, metadata FROM harness_shared.routines ORDER BY workspace_id`;
    expect(rows[0]!.metadata).toEqual({});
    expect(rows[1]!.metadata.unrelated).toBe(true);
  });

  it('fetches a scoped snapshot across different local names, persists a floor and rejects replay after restart', async () => {
    const ann = await publish();
    const out = await receive(ann, {});
    expect(out.results[0]!.result).toMatchObject({ action: 'fetched', sigrefs: { accepted: true }, mismatches: [] });
    await db.sql`UPDATE harness_shared.routines SET metadata = metadata || jsonb_build_object('accepted', ${db.sql.json(out.replayFloors)}) WHERE workspace_id='w'`;
    const rows = await db.sql`SELECT metadata->'accepted' AS accepted FROM harness_shared.routines WHERE workspace_id='w'`;
    const resumed = await receive(ann, rows[0]!.accepted);
    expect(resumed.results[0]!.result).toMatchObject({ action: 'rejected', reason: 'stale-version' });
  });

  it('recreates the real producer store at sequence one without admitting the old generation', async () => {
    const old = await publish();
    const first = await receive(old, {});
    await rm(producer, { recursive: true, force: true });
    producer = await ensurePotGitRepo('local-hive-a', 'local-a');
    const next = await publish();
    expect(next.version).toBe(1);
    expect(storeGenerationOrdinal(next.store_generation)).toBe(2);
    const accepted = await receive(next, first.replayFloors);
    expect(accepted.results[0]!.result).toMatchObject({ action: 'fetched', sigrefs: { accepted: true } });
    const resumed = JSON.parse(JSON.stringify(accepted.replayFloors)) as Record<string, SignedSnapshotFloor>;
    expect(acceptRefAnnouncement(old, { priorVersion: 1, replayFloor: resumed[key.pubkeyBase64], expectedContext: scope })).toMatchObject({ ok: false, reason: 'stale-generation' });
  });

  it('does not let overwritten mirror refs replace the durable accepted floor', async () => {
    const ann = await publish();
    const accepted = await receive(ann, {});
    const poisoned = await buildSigrefs(producer, key.pubkeyBase64, sign, { nowMs: 10, version: 999 });
    expect(poisoned.v).toBe(1);
    await defaultRunGit(['fetch', producer, '+refs/namespaces/*:refs/namespaces/*'], receiver);
    const after = await receive(ann, accepted.replayFloors);
    expect(after.results[0]!.result).toMatchObject({ action: 'rejected', reason: 'stale-version' });
    expect(after.replayFloors).toEqual(accepted.replayFloors);
  });

  it('re-signs unchanged refs when the stored snapshot predates the scoped protocol', async () => {
    const context = await resolve();
    const priorOid = await readNamespaceRef(producer, key.pubkeyBase64, SIGREFS_REF);
    const out = await runRefAnnouncePublishTick({ repoPath: producer, devicePubkeyBase64: key.pubkeyBase64, sign, nowMs: 20, context });
    expect(out.errors).toEqual([]);
    expect(out.announcement).toMatchObject({ v: 2, version: 1, store_generation: context.store_generation });
    expect(out.announcement?.sigrefs_oid).not.toBe(priorOid);
  });

  it('refuses signing when its durable routine owner is missing', async () => {
    await expect(resolveStoreProtocolContext({ sql: db.sql, slug: 'absent', workspaceId: 'w', repoPath: producer, scope, device: key.pubkeyBase64 })).rejects.toThrow('expected one durable');
  });
});
