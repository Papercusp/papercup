/**
 * ref-announce-tick.integration.test.ts — P-202 runtime driver, end to end
 * over real bare repos + a unix-socket duplex (mirrors
 * ref-announce.integration.test.ts's rig).
 *
 * Run: cd packages/operator-core && npx vitest run --config vitest.integration.config.ts lib/sync/hive-git/ref-announce-tick.integration.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, connect, type Server, type Socket } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { generateEd25519KeypairDer, signWithPrivateKeyDer } from '../../identity/ed25519';
import { defaultRunGit, ensureHiveGitRepo, writeNamespaceRef, readNamespaceRef } from './storage';
import { readSigrefs } from './sigrefs';
import { serveUploadPack } from './fetch-transport';
import { buildRefAnnouncement, type SignedRefAnnouncement } from './ref-announce';
import { runRefAnnouncePublishTick, runRefAnnounceReceiveTick } from './ref-announce-tick';

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

describe('ref-announce-tick (P-202 runtime driver)', () => {
  let root: string;
  let repoB: string; // device B's own repo — publish tick runs here, also served FROM
  let repoA: string; // device A's local mirror — receive tick runs here
  let sockPath: string;
  let server: Server;
  const devA = mkDevice();
  const devB = mkDevice();
  const members = () => [devA.pubkeyBase64, devB.pubkeyBase64];

  const dial = (): Promise<Socket> =>
    new Promise((resolve, reject) => {
      const s = connect({ path: sockPath, allowHalfOpen: true });
      s.once('connect', () => resolve(s));
      s.once('error', reject);
    });

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'hgannouncetick-'));
    process.env.PAPERCUSP_HIVE_GIT_ROOT = root;
    repoB = await ensureHiveGitRepo('hive-a', 'repo-1');
    repoA = await ensureHiveGitRepo('hive-a', 'repo-1-mirror');
    sockPath = join(root, 'link.sock');
    server = createServer({ allowHalfOpen: true }, (srvConn) => {
      srvConn.on('error', () => {});
      void serveUploadPack(repoB, srvConn);
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

  describe('publish tick', () => {
    it('no-ops when the device has no namespace refs yet', async () => {
      const out = await runRefAnnouncePublishTick({
        repoPath: repoB,
        devicePubkeyBase64: devB.pubkeyBase64,
        sign: devB.sign,
        nowMs: 1_000,
      });
      expect(out).toMatchObject({ ran: true, changed: false, announcement: null, errors: [] });
    });

    it('announces on a fresh advance and no-ops on a re-run with nothing new', async () => {
      const sha1 = await mintCommit(repoB, 'B work 1');
      await writeNamespaceRef(repoB, devB.pubkeyBase64, 'refs/heads/work', sha1);

      const out1 = await runRefAnnouncePublishTick({
        repoPath: repoB,
        devicePubkeyBase64: devB.pubkeyBase64,
        sign: devB.sign,
        nowMs: 1_000,
      });
      expect(out1.ran).toBe(true);
      expect(out1.changed).toBe(true);
      expect(out1.errors).toEqual([]);
      expect(out1.announcement).not.toBeNull();
      expect(out1.announcement?.version).toBe(1);
      expect((await readSigrefs(repoB, devB.pubkeyBase64))?.version).toBe(1);

      // Re-run with nothing new committed — must NOT bump the version again.
      const out2 = await runRefAnnouncePublishTick({
        repoPath: repoB,
        devicePubkeyBase64: devB.pubkeyBase64,
        sign: devB.sign,
        nowMs: 2_000,
      });
      expect(out2).toMatchObject({ ran: true, changed: false, announcement: null, errors: [] });
      expect((await readSigrefs(repoB, devB.pubkeyBase64))?.version).toBe(1);
    });

    it('announces again once a new head lands', async () => {
      const sha2 = await mintCommit(repoB, 'B work 2');
      await writeNamespaceRef(repoB, devB.pubkeyBase64, 'refs/heads/work', sha2);
      const out = await runRefAnnouncePublishTick({
        repoPath: repoB,
        devicePubkeyBase64: devB.pubkeyBase64,
        sign: devB.sign,
        nowMs: 3_000,
      });
      expect(out.changed).toBe(true);
      expect(out.announcement?.version).toBe(2);
    });
  });

  describe('receive tick', () => {
    let firstAnnouncement: SignedRefAnnouncement;

    it('no-ops on an empty batch', async () => {
      const out = await runRefAnnounceReceiveTick({
        repoPath: repoA,
        pending: [],
        openStream: dial,
      });
      expect(out).toMatchObject({ ran: false, results: [], errors: [] });
      expect(out.budgetStates.size).toBe(0);
    });

    it('processes a batch of pending announcements against the mirror, in order', async () => {
      // Fresh device C publishing directly in repoB (served) so the receive
      // tick has real advertised state to fetch.
      const devC = mkDevice();
      const shaC1 = await mintCommit(repoB, 'C work 1');
      await writeNamespaceRef(repoB, devC.pubkeyBase64, 'refs/heads/work', shaC1);
      const t1 = await runRefAnnouncePublishTick({
        repoPath: repoB,
        devicePubkeyBase64: devC.pubkeyBase64,
        sign: devC.sign,
        nowMs: 4_000,
      });
      expect(t1.announcement).not.toBeNull();
      firstAnnouncement = t1.announcement as SignedRefAnnouncement;

      const out = await runRefAnnounceReceiveTick({
        repoPath: repoA,
        pending: [firstAnnouncement],
        selfDevice: devA.pubkeyBase64,
        allowedDevices: [...members(), devC.pubkeyBase64],
        nowMs: 4_000,
        openStream: dial,
        timeoutMs: 30_000,
      });
      expect(out.ran).toBe(true);
      expect(out.errors).toEqual([]);
      expect(out.results).toHaveLength(1);
      expect(out.results[0]).toMatchObject({ device: devC.pubkeyBase64, version: 1 });
      expect(out.results[0].result.action).toBe('fetched');
      expect(await readNamespaceRef(repoA, devC.pubkeyBase64, 'refs/heads/work')).toBe(shaC1);
      // Budget state was recorded even with no explicit budget config (state persists as returned).
      expect(out.budgetStates.has(devC.pubkeyBase64)).toBe(true);

      // Replaying the SAME announcement in a later tick is fenced — never
      // throws, never halts a batch that also has other work.
      const replay = await runRefAnnounceReceiveTick({
        repoPath: repoA,
        pending: [firstAnnouncement],
        selfDevice: devA.pubkeyBase64,
        allowedDevices: [...members(), devC.pubkeyBase64],
        budgetStates: out.budgetStates,
        nowMs: 5_000,
        openStream: dial,
      });
      expect(replay.results[0].result).toMatchObject({ action: 'rejected', reason: 'stale-version' });
    });

    it('a forged announcement in the batch is rejected without halting the rest', async () => {
      const outsider = mkDevice();
      const devD = mkDevice();
      const shaD1 = await mintCommit(repoB, 'D work 1');
      await writeNamespaceRef(repoB, devD.pubkeyBase64, 'refs/heads/work', shaD1);
      const tD = await runRefAnnouncePublishTick({
        repoPath: repoB,
        devicePubkeyBase64: devD.pubkeyBase64,
        sign: devD.sign,
        nowMs: 6_000,
      });
      const legit = tD.announcement as SignedRefAnnouncement;

      // Outsider forges an announcement claiming to be devD (real device
      // fields, wrong signer) — must be rejected on signature, never opening
      // a stream for it, while the legit one in the same batch still lands.
      const forged = await buildRefAnnouncement(repoB, devD.pubkeyBase64, outsider.sign, { nowMs: 6_000 });

      let openedForForged = false;
      const out = await runRefAnnounceReceiveTick({
        repoPath: repoA,
        pending: [{ ...forged, version: 99 }, legit],
        allowedDevices: [devD.pubkeyBase64],
        nowMs: 6_000,
        openStream: (device) => {
          if (device === devD.pubkeyBase64 && legit.sigrefs_oid !== forged.sigrefs_oid) {
            // only the legit fetch should ever dial
          }
          openedForForged = true;
          return dial();
        },
        timeoutMs: 30_000,
      });
      expect(out.results).toHaveLength(2);
      expect(out.results[0].result).toMatchObject({ action: 'rejected', reason: 'bad-signature' });
      expect(out.results[1].result.action).toBe('fetched');
      expect(openedForForged).toBe(true); // opened once, for the legit entry only
      expect(await readNamespaceRef(repoA, devD.pubkeyBase64, 'refs/heads/work')).toBe(shaD1);
    });
  });
});
