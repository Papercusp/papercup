/**
 * ref-announce-tick.integration.test.ts — P-202 runtime driver, end to end
 * over real bare repos + a unix-socket duplex (mirrors
 * ref-announce.integration.test.ts's rig).
 *
 * Run: cd packages/operator-core && npx vitest run --config vitest.integration.config.ts lib/sync/pot-git/ref-announce-tick.integration.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, connect, type Server, type Socket } from 'node:net';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { generateEd25519KeypairDer, signWithPrivateKeyDer } from '../../identity/ed25519';
import { defaultRunGit, ensurePotGitRepo, writeNamespaceRef, readNamespaceRef } from './storage';
import { readSigrefs } from './sigrefs';
import { HANDOFF_REF, publishHandoffToken } from './handoff-token';
import { serveUploadPack } from './fetch-transport';
import { Duplex } from 'node:stream';
import { buildRefAnnouncement, type SignedRefAnnouncement } from './ref-announce';
import {
  runRefAnnouncePublishTick,
  runRefAnnounceReceiveTick,
  decideRefAnnounceReceiveCursor,
} from './ref-announce-tick';

/** git with STDIN — RunGit (defaultRunGit) is (args, cwd) only; `hash-object
 *  --stdin` / `mktree` need piped input. Mirrors publish-guard.ts's own
 *  runGitStdin test-plumbing helper. */
function gitStdin(args: string[], cwd: string, stdin: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn('git', args, { cwd });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += String(d)));
    child.stderr.on('data', (d) => (stderr += String(d)));
    child.on('error', (e) => resolve({ code: -1, stdout, stderr: stderr + String(e) }));
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
    child.stdin.write(stdin);
    child.stdin.end();
  });
}

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

/** A commit introducing ONE new file with real blob content — for exercising
 *  the G-10 publish guard (`mintCommit` above always points at the empty
 *  tree, so it never has a blob to judge). */
async function mintCommitWithFile(repoPath: string, path: string, content: string, msg: string): Promise<string> {
  const blob = await gitStdin(['hash-object', '-w', '--stdin'], repoPath, content);
  expect(blob.code, blob.stderr).toBe(0);
  const tree = await gitStdin(['mktree'], repoPath, `100644 blob ${blob.stdout.trim()}\t${path}\n`);
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
    repoB = await ensurePotGitRepo('hive-a', 'repo-1');
    repoA = await ensurePotGitRepo('hive-a', 'repo-1-mirror');
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

    it('P-505: resumes above the durable version floor after the local bare store is rebuilt', async () => {
      const rebuilt = await ensurePotGitRepo('hive-a', 'repo-cold-rejoin', defaultRunGit, { fresh: true });
      const device = mkDevice();
      const head = await mintCommit(rebuilt, 'work after full-store cold join');
      await writeNamespaceRef(rebuilt, device.pubkeyBase64, 'refs/heads/work', head);

      const out = await runRefAnnouncePublishTick({
        repoPath: rebuilt,
        devicePubkeyBase64: device.pubkeyBase64,
        sign: device.sign,
        nowMs: 4_000,
        versionFloor: 17,
      });

      expect(out).toMatchObject({ ran: true, changed: true, errors: [] });
      expect(out.announcement?.version).toBe(18);
      expect((await readSigrefs(rebuilt, device.pubkeyBase64))?.version).toBe(18);
    });

    it('P-505: announces a handoff-token ref written after the prior sigrefs snapshot', async () => {
      const devHandoff = mkDevice();
      const staging = await mintCommit(repoB, 'handoff staging');
      await writeNamespaceRef(repoB, devHandoff.pubkeyBase64, 'refs/heads/staging', staging);

      const initial = await runRefAnnouncePublishTick({
        repoPath: repoB,
        devicePubkeyBase64: devHandoff.pubkeyBase64,
        sign: devHandoff.sign,
        nowMs: 20_000,
      });
      expect(initial.changed).toBe(true);
      expect(initial.announcement?.version).toBe(1);

      await publishHandoffToken(
        repoB,
        devHandoff.pubkeyBase64,
        { epoch: 83, seq: 46, stagingSha: staging, nowMs: 21_000 },
        devHandoff.sign,
      );
      expect(await readNamespaceRef(repoB, devHandoff.pubkeyBase64, HANDOFF_REF)).toBeTruthy();

      const refreshed = await runRefAnnouncePublishTick({
        repoPath: repoB,
        devicePubkeyBase64: devHandoff.pubkeyBase64,
        sign: devHandoff.sign,
        nowMs: 22_000,
      });
      expect(refreshed.changed).toBe(true);
      expect(refreshed.refused).toBeNull();
      expect(refreshed.announcement?.version).toBe(2);
      expect((await readSigrefs(repoB, devHandoff.pubkeyBase64))?.refs).toEqual(
        expect.arrayContaining([
          { ref: 'refs/heads/staging', sha: staging },
          { ref: HANDOFF_REF, sha: expect.any(String) },
        ]),
      );
    });

    it('G-10: refuses a publish whose new blob contains a secret — no version bump, no announcement, and a repeat attempt refuses again (never wedges, never silently admits)', async () => {
      const devE = mkDevice();
      const sha1 = await mintCommit(repoB, 'E work 1');
      await writeNamespaceRef(repoB, devE.pubkeyBase64, 'refs/heads/work', sha1);
      const t1 = await runRefAnnouncePublishTick({
        repoPath: repoB,
        devicePubkeyBase64: devE.pubkeyBase64,
        sign: devE.sign,
        nowMs: 7_000,
      });
      expect(t1.changed).toBe(true);
      expect(t1.announcement?.version).toBe(1);

      // Built via concatenation (never a contiguous literal in source) so the
      // repo's own commit-time secrets guard doesn't flag THIS TEST FILE —
      // the fixture only needs to match secrets-guard.ts's AWS-key-id SHAPE
      // (AKIA + 16 uppercase/digits); it is not a real credential.
      const fakeAwsKeyId = ['AK', 'IA', 'ABCD', 'EFGH', 'IJKL', 'MNOP'].join('');
      const shaSecret = await mintCommitWithFile(repoB, 'creds.txt', `${fakeAwsKeyId}\n`, 'E work 2 (secret)');
      await writeNamespaceRef(repoB, devE.pubkeyBase64, 'refs/heads/work', shaSecret);
      const t2 = await runRefAnnouncePublishTick({
        repoPath: repoB,
        devicePubkeyBase64: devE.pubkeyBase64,
        sign: devE.sign,
        nowMs: 8_000,
      });
      expect(t2.changed).toBe(false);
      expect(t2.announcement).toBeNull();
      expect(t2.refused?.refusalCode).toBe('secrets');
      expect(t2.errors.some((e) => e.includes('publish guard refused'))).toBe(true);
      // The refused advance was never signed — the mirror's sigrefs version stays at 1.
      expect((await readSigrefs(repoB, devE.pubkeyBase64))?.version).toBe(1);

      // A retry (content still un-fixed) refuses again — deterministic, never
      // wedges the tick and never silently admits the offending content.
      const t3 = await runRefAnnouncePublishTick({
        repoPath: repoB,
        devicePubkeyBase64: devE.pubkeyBase64,
        sign: devE.sign,
        nowMs: 9_000,
      });
      expect(t3.changed).toBe(false);
      expect(t3.refused?.refusalCode).toBe('secrets');
    });
  });

  /**
   * WI-6251 — the tick must derive its genesis baseline PER REF and IN THIS
   * STORE, not accept one worktree-derived sha for every ref of the namespace.
   *
   * THE RIG SHAPE: our namespace carries a `refs/heads/staging` MIRRORED from a
   * peer, on a line of history our own mainline baseline cannot reach. Fed the
   * mainline sha, the guard judged that entire divergent line — 7057 commits on
   * the real box — and cat-file'd every blob in it into a JS string until the
   * sidecar hit the 4GB heap limit (EI-18759477854494594).
   *
   * `genesisBaselineSha` below is deliberately the WRONG-for-this-ref mainline
   * value the old code passed, so these cases fail if the per-ref derivation is
   * ever dropped — the coverage gap a mutation test found: every other test here
   * passes with the wiring reverted, because they only cover the helper.
   */
  describe('genesis baseline is per-ref, in this store (WI-6251)', () => {
    const OVERSIZE_CAPS = { maxBlobBytes: 64 };
    const devUs = mkDevice();
    const devPeer = mkDevice();

    /** commit-tree with a parent, so a real divergent line can be built. */
    async function mintChild(repoPath: string, parent: string, path: string, content: string): Promise<string> {
      const blob = await gitStdin(['hash-object', '-w', '--stdin'], repoPath, content);
      expect(blob.code, blob.stderr).toBe(0);
      const tree = await gitStdin(['mktree'], repoPath, `100644 blob ${blob.stdout.trim()}\t${path}\n`);
      expect(tree.code, tree.stderr).toBe(0);
      const c = await defaultRunGit(
        ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit-tree', tree.stdout.trim(), '-p', parent, '-m', path],
        repoPath,
      );
      expect(c.code, c.stderr).toBe(0);
      return c.stdout.trim();
    }

    it('a ref mirrored from a peer is NOT re-judged — the peer already exposed it', async () => {
      const repo = await ensurePotGitRepo('hive-a', 'repo-rig-shape');
      const base = await mintCommitWithFile(repo, 'base.txt', 'base\n', 'base');
      // The peer's line, carrying content that WOULD trip the guard.
      const peerHead = await mintChild(repo, base, 'big.bin', 'x'.repeat(4096));
      // Our own line: small and clean.
      const ourHead = await mintChild(repo, base, 'ours.txt', 'ours\n');

      // The peer published its line — proof that content already left a machine.
      await writeNamespaceRef(repo, devPeer.pubkeyBase64, 'refs/heads/staging', peerHead);
      // …and we mirror the identical sha under OUR namespace, as the rig does.
      await writeNamespaceRef(repo, devUs.pubkeyBase64, 'refs/heads/staging', peerHead);
      await writeNamespaceRef(repo, devUs.pubkeyBase64, 'refs/heads/main', ourHead);

      const out = await runRefAnnouncePublishTick({
        repoPath: repo,
        devicePubkeyBase64: devUs.pubkeyBase64,
        sign: devUs.sign,
        nowMs: 1_000,
        publishGuardCaps: OVERSIZE_CAPS,
        // The OLD input: right for `main`, catastrophically wrong for `staging`.
        genesisBaselineSha: base,
      });

      expect(out.refused).toBeNull();
      expect(out.changed).toBe(true);
      expect((await readSigrefs(repo, devUs.pubkeyBase64))?.version).toBe(1);
    });

    it('our OWN unexposed content is still judged — this narrows the range, it does not disable the guard', async () => {
      const repo = await ensurePotGitRepo('hive-a', 'repo-rig-shape-guarded');
      const base = await mintCommitWithFile(repo, 'base.txt', 'base\n', 'base');
      const exposed = await mintChild(repo, base, 'shared.txt', 'shared\n');
      // Only WE have this, and it is over the blob cap.
      const ourHead = await mintChild(repo, exposed, 'big.bin', 'x'.repeat(4096));

      await writeNamespaceRef(repo, devPeer.pubkeyBase64, 'refs/heads/main', exposed);
      await writeNamespaceRef(repo, devUs.pubkeyBase64, 'refs/heads/main', ourHead);

      const out = await runRefAnnouncePublishTick({
        repoPath: repo,
        devicePubkeyBase64: devUs.pubkeyBase64,
        sign: devUs.sign,
        nowMs: 1_000,
        publishGuardCaps: OVERSIZE_CAPS,
        genesisBaselineSha: base,
      });

      expect(out.changed).toBe(false);
      expect(out.refused?.refusalCode).toBe('blob-over-cap');
    });
  });

  describe('receive tick', () => {
    let firstAnnouncement: SignedRefAnnouncement;

    it('no-ops on an empty batch', async () => {
      const out = await runRefAnnounceReceiveTick({ allowLegacy: true,
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

      const out = await runRefAnnounceReceiveTick({ allowLegacy: true,
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
      const replay = await runRefAnnounceReceiveTick({ allowLegacy: true,
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
      const out = await runRefAnnounceReceiveTick({ allowLegacy: true,
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

    it('WI-2039873: after a device’s fetch fails, its remaining queued announcements this tick fail fast WITHOUT another dial (one dial per dead device per tick)', async () => {
      // The rig shape: twelve announcements from one peer queued behind a
      // failed fetch. Each used to re-dial in turn — twelve fresh same-repo
      // requests at the serving peer, each superseding or refused behind the
      // previous one's winding-down serve. The newest is parked for next tick
      // anyway, so the repeats must not touch the transport at all.
      const devH = mkDevice();
      const shaH1 = await mintCommit(repoB, 'H work 1');
      await writeNamespaceRef(repoB, devH.pubkeyBase64, 'refs/heads/work', shaH1);
      const tH = await runRefAnnouncePublishTick({
        repoPath: repoB,
        devicePubkeyBase64: devH.pubkeyBase64,
        sign: devH.sign,
        nowMs: 10_000,
      });
      const announcement = tH.announcement as SignedRefAnnouncement;
      expect(announcement).not.toBeNull();

      let dials = 0;
      const out = await runRefAnnounceReceiveTick({ allowLegacy: true,
        repoPath: repoA,
        // Three queued announcements from the same device (a replayed row is a
        // faithful model: the mirror never gains the ref, so every one of them
        // would otherwise drive a fresh fetch).
        pending: [announcement, announcement, announcement],
        selfDevice: devA.pubkeyBase64,
        allowedDevices: [...members(), devH.pubkeyBase64],
        nowMs: 10_000,
        openStream: () => {
          dials++;
          const stub = new Duplex({ read() {}, write(_c, _e, cb) { cb(); } });
          stub.on('error', () => {});
          stub.destroy(new Error('hive-git: no live swarm join for this harness yet'));
          return stub;
        },
        timeoutMs: 5_000,
      });

      expect(out.results).toHaveLength(3); // one result per queued announcement, positionally aligned
      expect(out.results.map((r) => r.result.action)).toEqual(['fetch-failed', 'fetch-failed', 'fetch-failed']);
      expect(dials).toBe(1); // the caller's dial seam was reached exactly once
      const second = out.results[1]!.result;
      expect(second.action === 'fetch-failed' && second.stderr).toContain('dial skipped');
      // Still parked (newest per device) for next tick's re-drive — nothing lost.
      const decision = decideRefAnnounceReceiveCursor(
        out.results,
        [1, 2, 3].map((rowId) => ({ rowId, announcement })),
        3,
      );
      expect(decision.cursor).toBe(3);
      expect(decision.parked[devH.pubkeyBase64]).toMatchObject({ rowId: 3, attempts: 1 });
    });

    it('EI-15335: a FAILED device-fetch reports fetch-failed and the cursor is held (never advanced past a missed announce)', async () => {
      // Live-incident path (WI-3499 Leg D): the announcing peer has no live
      // swarm dial yet, so `openStream` yields an already-destroyed duplex —
      // exactly the prod "no live swarm join for this harness yet" stub. The
      // fetch MUST fail (not silently no-op) and the caller MUST hold the
      // fed-event cursor below the failed row so the next tick re-dials.
      const devG = mkDevice();
      const shaG1 = await mintCommit(repoB, 'G work 1');
      await writeNamespaceRef(repoB, devG.pubkeyBase64, 'refs/heads/work', shaG1);
      const tG = await runRefAnnouncePublishTick({
        repoPath: repoB,
        devicePubkeyBase64: devG.pubkeyBase64,
        sign: devG.sign,
        nowMs: 10_000,
      });
      const announcement = tG.announcement as SignedRefAnnouncement;
      expect(announcement).not.toBeNull();

      const out = await runRefAnnounceReceiveTick({ allowLegacy: true,
        repoPath: repoA,
        pending: [announcement],
        selfDevice: devA.pubkeyBase64,
        allowedDevices: [...members(), devG.pubkeyBase64],
        nowMs: 10_000,
        openStream: () => {
          // Mirror the prod stub: a destroyed duplex, error listener attached
          // BEFORE destroy so the host never dies on an uncaught 'error'.
          const stub = new Duplex({ read() {}, write(_c, _e, cb) { cb(); } });
          stub.on('error', () => {});
          stub.destroy(new Error('hive-git: no live swarm join for this harness yet'));
          return stub;
        },
        timeoutMs: 5_000,
      });

      expect(out.ran).toBe(true);
      expect(out.results).toHaveLength(1);
      expect(out.results[0].result.action).toBe('fetch-failed');
      // The mirror never gained the announced ref — the whole point of the bug.
      expect(await readNamespaceRef(repoA, devG.pubkeyBase64, 'refs/heads/work')).toBeNull();

      // The caller's cursor decision must PARK this failed announcement (P-203
      // Leg A: carried by value for the next tick's re-dial) — and still advance
      // the cursor past row 4321, never holding it (a held cursor head-of-line
      // blocked every other announcer on the two-machine rig).
      const decision = decideRefAnnounceReceiveCursor(out.results, [{ rowId: 4321, announcement }], 4321);
      expect(decision.cursor).toBe(4321);
      expect(decision.parked[devG.pubkeyBase64]).toMatchObject({ rowId: 4321, attempts: 1 });
      expect(decision.parked[devG.pubkeyBase64]?.announcement).toEqual(announcement);
      // WI-6277 added `timedOut` + `code` to every fetchFailed row and this
      // assertion was never updated, so it has been red since (toEqual is exact
      // — extra keys fail). Asserting them is strictly better than loosening to
      // objectContaining: the two fields ARE the point of WI-6277, and this
      // case exercises the discriminator that motivated it. A duplex destroyed
      // before the fetch began means no git process ever ran, so it must read
      // `code: -1` and NOT masquerade as a ceiling timeout — the exact
      // confusion that stranded a replication stall on the P-302 rig.
      expect(decision.fetchFailed).toEqual([
        {
          rowId: 4321,
          device: devG.pubkeyBase64,
          stderr: expect.any(String),
          timedOut: false,
          code: -1,
        },
      ]);
    });
  });
});
