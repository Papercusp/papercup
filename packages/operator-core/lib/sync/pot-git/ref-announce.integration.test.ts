/**
 * ref-announce.integration.test.ts — G-3 end to end (P-027): announcement-driven
 * fetch against REAL bare repos over a unix-socket duplex (the fetch-transport
 * rig), covering the happy path, the relay-tamper mismatch, and the fences.
 *
 *   B publishes + sigrefs + announce → A handles: fetch → sigrefs accepted →
 *   heads reconcile → A mirrors B. Replay → stale-version. Tampered relay head
 *   → mismatch flagged. Forged announce → bad-signature.
 *
 * Run: cd packages/operator-core && npx vitest run --config vitest.integration.config.ts lib/sync/pot-git/ref-announce.integration.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, connect, type Server, type Socket } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { generateEd25519KeypairDer, signWithPrivateKeyDer } from '../../identity/ed25519';
import {
  defaultRunGit,
  ensurePotGitRepo,
  readNamespaceRef,
  writeNamespaceRef,
} from './storage';
import { buildSigrefs, readSigrefs, SIGREFS_REF } from './sigrefs';
import { serveUploadPack } from './fetch-transport';
import {
  buildRefAnnouncement,
  handleRefAnnouncement,
  type SignedRefAnnouncement,
} from './ref-announce';

function mkDevice(): { pubkeyBase64: string; sign: (bytes: Buffer) => Promise<Buffer> } {
  const { privateKeyDer, pubkeyBase64 } = generateEd25519KeypairDer();
  return { pubkeyBase64, sign: async (bytes: Buffer) => signWithPrivateKeyDer(privateKeyDer, bytes) };
}

async function mintCommit(repoPath: string, msg: string): Promise<string> {
  const tree = await defaultRunGit(['hash-object', '-w', '-t', 'tree', '/dev/null'], repoPath);
  expect(tree.code, tree.stderr).toBe(0);
  const c = await defaultRunGit(
    ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit-tree', tree.stdout.trim(), '-m', msg],
    repoPath,
  );
  expect(c.code, c.stderr).toBe(0);
  return c.stdout.trim();
}

describe('pot-git ref announcements (announcement-driven fetch, real repos)', () => {
  let root: string;
  let serverRepo: string; // device B's repo (also the relay we fetch FROM)
  let mirrorRepo: string; // device A's local mirror
  let sockPath: string;
  let server: Server;
  const devA = mkDevice();
  const devB = mkDevice();
  const members = () => [devA.pubkeyBase64, devB.pubkeyBase64];
  let now = 1_000;

  const dial = (): Promise<Socket> =>
    new Promise((resolve, reject) => {
      const s = connect({ path: sockPath, allowHalfOpen: true });
      s.once('connect', () => resolve(s));
      s.once('error', reject);
    });

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'hgannounce-'));
    process.env.PAPERCUSP_HIVE_GIT_ROOT = root;
    serverRepo = await ensurePotGitRepo('hive-a', 'repo-1');
    mirrorRepo = await ensurePotGitRepo('hive-a', 'repo-1-mirror');
    sockPath = join(root, 'link.sock');
    server = createServer({ allowHalfOpen: true }, (srvConn) => {
      srvConn.on('error', () => {});
      void serveUploadPack(serverRepo, srvConn);
    });
    await new Promise<void>((r) => server.listen(sockPath, () => r()));
  });

  afterAll(async () => {
    try {
      server.close();
    } catch {
      /* ignore */
    }
    delete process.env.PAPERCUSP_HIVE_GIT_ROOT;
    await rm(root, { recursive: true, force: true });
  });

  let firstAnnouncement: SignedRefAnnouncement;

  it('announce → fetch → accepted sigrefs → mirrored, reconciled heads', async () => {
    const sha1 = await mintCommit(serverRepo, 'B work 1');
    await writeNamespaceRef(serverRepo, devB.pubkeyBase64, 'refs/heads/work', sha1);
    await buildSigrefs(serverRepo, devB.pubkeyBase64, devB.sign, { nowMs: now });
    firstAnnouncement = await buildRefAnnouncement(serverRepo, devB.pubkeyBase64, devB.sign, { nowMs: now });
    expect(firstAnnouncement.version).toBe(1);

    const r = await handleRefAnnouncement(mirrorRepo, firstAnnouncement, {
      selfDevice: devA.pubkeyBase64,
      allowedDevices: members(),
      nowMs: now,
      openStream: dial,
      timeoutMs: 30_000,
    });
    expect(r.action).toBe('fetched');
    if (r.action !== 'fetched') return;
    expect(r.sigrefs).toMatchObject({ accepted: true });
    expect(r.mismatches).toEqual([]);
    expect(await readNamespaceRef(mirrorRepo, devB.pubkeyBase64, 'refs/heads/work')).toBe(sha1);
    expect((await readSigrefs(mirrorRepo, devB.pubkeyBase64))?.version).toBe(1);
  });

  it('replaying the same announcement is fenced by the mirror watermark', async () => {
    const r = await handleRefAnnouncement(mirrorRepo, firstAnnouncement, {
      selfDevice: devA.pubkeyBase64,
      allowedDevices: members(),
      nowMs: ++now,
      openStream: dial,
    });
    expect(r).toMatchObject({ action: 'rejected', reason: 'stale-version' });
  });

  it('a second advance announces and fetches incrementally', async () => {
    const sha2 = await mintCommit(serverRepo, 'B work 2');
    await writeNamespaceRef(serverRepo, devB.pubkeyBase64, 'refs/heads/work', sha2);
    await buildSigrefs(serverRepo, devB.pubkeyBase64, devB.sign, { nowMs: ++now });
    const ann = await buildRefAnnouncement(serverRepo, devB.pubkeyBase64, devB.sign, { nowMs: now });
    expect(ann.version).toBe(2);

    const r = await handleRefAnnouncement(mirrorRepo, ann, {
      selfDevice: devA.pubkeyBase64,
      allowedDevices: members(),
      nowMs: now,
      openStream: dial,
      timeoutMs: 30_000,
    });
    expect(r.action).toBe('fetched');
    if (r.action !== 'fetched') return;
    expect(r.sigrefs).toMatchObject({ accepted: true });
    expect(r.mismatches).toEqual([]);
    expect(await readNamespaceRef(mirrorRepo, devB.pubkeyBase64, 'refs/heads/work')).toBe(sha2);
  });

  it('flags a relay-tampered head the device never signed (G-4 contract)', async () => {
    // B signs its snapshot at v3, then the RELAY (server repo) moves B's head
    // to a commit B never signed — the announcement + sigrefs are authentic,
    // the served head is not.
    await buildSigrefs(serverRepo, devB.pubkeyBase64, devB.sign, { nowMs: ++now });
    const ann = await buildRefAnnouncement(serverRepo, devB.pubkeyBase64, devB.sign, { nowMs: now });
    const rogue = await mintCommit(serverRepo, 'relay-injected');
    await writeNamespaceRef(serverRepo, devB.pubkeyBase64, 'refs/heads/work', rogue);

    const r = await handleRefAnnouncement(mirrorRepo, ann, {
      selfDevice: devA.pubkeyBase64,
      allowedDevices: members(),
      nowMs: now,
      openStream: dial,
      timeoutMs: 30_000,
    });
    expect(r.action).toBe('fetched');
    if (r.action !== 'fetched') return;
    expect(r.sigrefs).toMatchObject({ accepted: true });
    expect(r.mismatches).toHaveLength(1);
    expect(r.mismatches[0].ref).toBe('refs/heads/work');
    expect(r.mismatches[0].actual).toBe(rogue);
    // Restore the served head to the signed one for any later legs.
    await writeNamespaceRef(serverRepo, devB.pubkeyBase64, 'refs/heads/work', r.mismatches[0].expected);
  });

  it('rejects a forged announcement and a non-member device without fetching', async () => {
    const outsider = mkDevice();
    const sigrefsOid = await readNamespaceRef(serverRepo, devB.pubkeyBase64, SIGREFS_REF);
    expect(sigrefsOid).toBeTruthy();
    // Forged: outsider signs an announcement claiming to be B.
    const forged = await buildRefAnnouncement(serverRepo, devB.pubkeyBase64, outsider.sign, { nowMs: ++now });
    const rf = await handleRefAnnouncement(mirrorRepo, { ...forged, version: 99 }, {
      allowedDevices: members(),
      nowMs: now,
      openStream: () => {
        throw new Error('must not open a stream for a rejected announcement');
      },
    });
    expect(rf).toMatchObject({ action: 'rejected', reason: 'bad-signature' });
    // Non-member: outsider announces as itself.
    await writeNamespaceRef(serverRepo, outsider.pubkeyBase64, 'refs/heads/work', await mintCommit(serverRepo, 'x'));
    await buildSigrefs(serverRepo, outsider.pubkeyBase64, outsider.sign, { nowMs: now });
    const alien = await buildRefAnnouncement(serverRepo, outsider.pubkeyBase64, outsider.sign, { nowMs: now });
    const ra = await handleRefAnnouncement(mirrorRepo, alien, {
      allowedDevices: members(),
      nowMs: now,
      openStream: () => {
        throw new Error('must not open a stream for a rejected announcement');
      },
    });
    expect(ra).toMatchObject({ action: 'rejected', reason: 'wrong-device' });
  });

  it('defers over-budget bursts without consuming the fence', async () => {
    const cfg = { windowMs: 60_000, maxPerWindow: 1 };
    const sha4 = await mintCommit(serverRepo, 'B work 4');
    await writeNamespaceRef(serverRepo, devB.pubkeyBase64, 'refs/heads/work', sha4);
    await buildSigrefs(serverRepo, devB.pubkeyBase64, devB.sign, { nowMs: ++now });
    const ann = await buildRefAnnouncement(serverRepo, devB.pubkeyBase64, devB.sign, { nowMs: now });

    // Budget exhausted by a prior take in this window → deferred, mirror unchanged.
    const before = (await readSigrefs(mirrorRepo, devB.pubkeyBase64))?.version;
    const r1 = await handleRefAnnouncement(mirrorRepo, ann, {
      allowedDevices: members(),
      budget: { state: { windowStartMs: now, count: 1 }, config: cfg },
      nowMs: now,
      openStream: () => {
        throw new Error('must not fetch over budget');
      },
    });
    expect(r1).toMatchObject({ action: 'rejected', reason: 'over-budget' });
    expect((await readSigrefs(mirrorRepo, devB.pubkeyBase64))?.version).toBe(before);

    // Next window: the same announcement now lands (the sweep semantics).
    const r2 = await handleRefAnnouncement(mirrorRepo, ann, {
      allowedDevices: members(),
      budget: { state: r1.budgetState, config: cfg },
      nowMs: now + cfg.windowMs,
      openStream: dial,
      timeoutMs: 30_000,
    });
    expect(r2.action).toBe('fetched');
    expect(await readNamespaceRef(mirrorRepo, devB.pubkeyBase64, 'refs/heads/work')).toBe(sha4);
  });
});
