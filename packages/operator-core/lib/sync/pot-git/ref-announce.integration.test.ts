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

    const r = await handleRefAnnouncement(mirrorRepo, firstAnnouncement, { allowLegacy: true,
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
    const r = await handleRefAnnouncement(mirrorRepo, firstAnnouncement, { allowLegacy: true,
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

    const r = await handleRefAnnouncement(mirrorRepo, ann, { allowLegacy: true,
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

    const r = await handleRefAnnouncement(mirrorRepo, ann, { allowLegacy: true,
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
    const rf = await handleRefAnnouncement(mirrorRepo, { ...forged, version: 99 }, { allowLegacy: true,
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
    const ra = await handleRefAnnouncement(mirrorRepo, alien, { allowLegacy: true,
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
    const r1 = await handleRefAnnouncement(mirrorRepo, ann, { allowLegacy: true,
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
    const r2 = await handleRefAnnouncement(mirrorRepo, ann, { allowLegacy: true,
      allowedDevices: members(),
      budget: { state: r1.budgetState, config: cfg },
      nowMs: now + cfg.windowMs,
      openStream: dial,
      timeoutMs: 30_000,
    });
    expect(r2.action).toBe('fetched');
    expect(await readNamespaceRef(mirrorRepo, devB.pubkeyBase64, 'refs/heads/work')).toBe(sha4);
  });

  it('EI-18752434722211671: an openStream that never resolves fails soft instead of hanging the receive', async () => {
    // `timeoutMs` used to bound only the FETCH; the `await opts.openStream()`
    // immediately before it was unbounded. `openStream` is caller-supplied
    // code that dials a live peer (and, in git-sync-action, reads Postgres
    // first) — on the P-302 rig it reached a protomux channel that neither
    // opened nor closed, so this await never settled and the whole DBOS
    // git-sync fire wedged, holding its dedup pin for hours.
    const sha5 = await mintCommit(serverRepo, 'B work 5');
    await writeNamespaceRef(serverRepo, devB.pubkeyBase64, 'refs/heads/work', sha5);
    await buildSigrefs(serverRepo, devB.pubkeyBase64, devB.sign, { nowMs: ++now });
    const ann = await buildRefAnnouncement(serverRepo, devB.pubkeyBase64, devB.sign, { nowMs: now });
    const mirroredBefore = (await readSigrefs(mirrorRepo, devB.pubkeyBase64))?.version;
    expect(mirroredBefore).toBeLessThan(ann.version); // the fetch is genuinely needed

    let dialed = false;
    const t0 = Date.now();
    const r = await handleRefAnnouncement(mirrorRepo, ann, { allowLegacy: true,
      allowedDevices: members(),
      nowMs: now,
      openStream: () => {
        dialed = true;
        return new Promise<never>(() => {}); // never settles — the live hang
      },
      timeoutMs: 250,
    });
    const elapsed = Date.now() - t0;

    expect(dialed).toBe(true);
    expect(r.action).toBe('fetch-failed'); // pre-fix: never reached at all
    if (r.action !== 'fetch-failed') return;
    expect(r.stderr).toContain('openStream did not resolve');
    expect(elapsed).toBeLessThan(10_000);
    // The version fence was NOT consumed — the next tick re-dials this same
    // announcement rather than leaving a permanent namespace-mirror gap.
    expect((await readSigrefs(mirrorRepo, devB.pubkeyBase64))?.version).toBe(mirroredBefore);
  });

  /**
   * WI-6418 — THE CONVERGENCE PROPERTY, end to end against real git.
   *
   * Everything else about this bug was previously proven only in isolation:
   * the serve-side admission rule discards nothing (a pure unit test over
   * `resolveServeAdmission`), and the coalescer opens one session (a pure unit
   * test over a stub). Neither runs a transfer, so neither can answer the only
   * question a release actually turns on — DOES THE REPO END UP MIRRORED.
   *
   * The failure this guards is not "slow". It is "never finishes at any
   * throughput": ~12+ staggered git-sync routines drive a fetch for the same
   * repo roughly every ~15s in aggregate, while a multi-GB cold join needs
   * ~175s. Each drive used to open its own session, and the serve side then
   * destroyed (pre-WI-6412) or refused (post-WI-6412) the transfer already in
   * progress. The ceiling is a PERIOD, not a RATE — which is why the size of
   * the repo is deliberately NOT what this test varies. Concurrency during a
   * single in-flight transfer reproduces it at any scale.
   */
  it('WI-6418: concurrent drives open ONE session, report no failure, and the repo still converges', async () => {
    const sha6 = await mintCommit(serverRepo, 'B work 6');
    await writeNamespaceRef(serverRepo, devB.pubkeyBase64, 'refs/heads/work', sha6);
    await buildSigrefs(serverRepo, devB.pubkeyBase64, devB.sign, { nowMs: ++now });
    const ann = await buildRefAnnouncement(serverRepo, devB.pubkeyBase64, devB.sign, { nowMs: now });
    const mirroredBefore = (await readSigrefs(mirrorRepo, devB.pubkeyBase64))?.version;
    expect(mirroredBefore).toBeLessThan(ann.version); // the fetch is genuinely needed

    let dials = 0;
    const countingDial = (): Promise<Socket> => {
      dials += 1;
      return dial();
    };

    // Six drivers racing for the same repo, exactly as the staggered routines do.
    const drives = await Promise.all(
      Array.from({ length: 6 }, () =>
        handleRefAnnouncement(mirrorRepo, ann, { allowLegacy: true,
          selfDevice: devA.pubkeyBase64,
          allowedDevices: members(),
          nowMs: now,
          openStream: countingDial,
          timeoutMs: 30_000,
        }),
      ),
    );

    // 1. ONE session. Pre-fix this was 6, and every one of them landed on a
    //    serve that was already streaming to this same channel.
    expect(dials).toBe(1);
    expect(drives.filter((d) => d.action === 'fetched')).toHaveLength(1);
    expect(drives.filter((d) => d.action === 'already-in-flight')).toHaveLength(5);

    // 2. NOTHING is reported as a failure. This is the half that keeps the
    //    livelock from re-forming: a collapsed duplicate that surfaced as
    //    `fetch-failed` would have the driver log a phantom transport error
    //    against a perfectly healthy stream and re-dial it next tick.
    expect(drives.some((d) => d.action === 'fetch-failed')).toBe(false);

    // 3. AND IT CONVERGED. The point of the whole exercise — not "one session
    //    was opened", but "the objects arrived".
    expect(await readNamespaceRef(mirrorRepo, devB.pubkeyBase64, 'refs/heads/work')).toBe(sha6);
    expect((await readSigrefs(mirrorRepo, devB.pubkeyBase64))?.version).toBe(ann.version);
  });

  it('WI-6418: a collapsed duplicate does NOT consume the version fence', async () => {
    // The coalescer must not cost us an announcement. If a skipped drive
    // advanced the mirror watermark, the announce it declined to fetch would
    // never be retried — reintroducing EI-15335's silent permanent namespace
    // gap through a new door.
    const sha7 = await mintCommit(serverRepo, 'B work 7');
    await writeNamespaceRef(serverRepo, devB.pubkeyBase64, 'refs/heads/work', sha7);
    await buildSigrefs(serverRepo, devB.pubkeyBase64, devB.sign, { nowMs: ++now });
    const ann = await buildRefAnnouncement(serverRepo, devB.pubkeyBase64, devB.sign, { nowMs: now });

    // Hold one drive open on a dial that never settles, so a SECOND drive is
    // guaranteed to be the collapsed one, then let the holder time out. Merely
    // creating `holder` first is not enough: both calls perform async git reads
    // before entering the coalescer, so the second call can otherwise win that
    // race and legitimately fetch. The seam barrier proves which call owns it.
    let markHolderEntered!: () => void;
    const holderEntered = new Promise<void>((resolve) => {
      markHolderEntered = resolve;
    });
    const holder = handleRefAnnouncement(mirrorRepo, ann, { allowLegacy: true,
      allowedDevices: members(),
      nowMs: now,
      openStream: () => {
        markHolderEntered();
        return new Promise<never>(() => {});
      },
      timeoutMs: 300,
    });
    await holderEntered;
    const collapsed = await handleRefAnnouncement(mirrorRepo, ann, { allowLegacy: true,
      allowedDevices: members(),
      nowMs: now,
      openStream: dial,
      timeoutMs: 30_000,
    });
    expect(collapsed.action).toBe('already-in-flight');
    await holder;

    // The fence is intact, so a later tick can still mirror this announcement.
    const retried = await handleRefAnnouncement(mirrorRepo, ann, { allowLegacy: true,
      allowedDevices: members(),
      nowMs: now,
      openStream: dial,
      timeoutMs: 30_000,
    });
    expect(retried.action).toBe('fetched');
    expect(await readNamespaceRef(mirrorRepo, devB.pubkeyBase64, 'refs/heads/work')).toBe(sha7);
  });
});
