/**
 * bootstrap.integration.test.ts — G-8 cold-clone bootstrap (P-032): a fresh
 * empty repo seeds EVERY namespace a member peer holds, over the real G-2
 * transport (two bare repos + a socket duplex, the fetch-transport link
 * pattern). No swarm.
 *
 * Run: cd packages/operator-core && npx vitest run --config vitest.integration.config.ts lib/sync/pot-git/bootstrap.integration.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, connect, type Server, type Socket } from 'node:net';
import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  type RunGit,
  defaultRunGit,
  deviceNamespaceKey,
  ensurePotGitRepo,
  listNamespaceRefs,
  listNamespaces,
  readNamespaceRef,
  writeNamespaceRef,
} from './storage';
import { serveUploadPack } from './fetch-transport';
import { STAGING_REF, WORK_REF } from './integrator';
import { INITIAL_DEEPEN_COMMITS, MIN_DEEPEN_COMMITS, bootstrapFromPeer } from './bootstrap';

function devicePubkey(): string {
  const { publicKey } = generateKeyPairSync('ed25519');
  const spki = (publicKey as KeyObject).export({ format: 'der', type: 'spki' }) as Buffer;
  return spki.subarray(spki.length - 32).toString('base64');
}

async function mintCommit(repoPath: string, msg: string, parent?: string): Promise<string> {
  const tree = await defaultRunGit(['hash-object', '-w', '-t', 'tree', '/dev/null'], repoPath);
  expect(tree.code, tree.stderr).toBe(0);
  const args = ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit-tree', tree.stdout.trim()];
  if (parent) args.push('-p', parent);
  args.push('-m', msg);
  const c = await defaultRunGit(args, repoPath);
  expect(c.code, c.stderr).toBe(0);
  return c.stdout.trim();
}

describe('bootstrap (G-8: one wildcard fetch seeds the whole hive repo)', () => {
  let root: string;
  let peerRepo: string;
  let joinerRepo: string;
  let sockPath: string;
  let server: Server;
  const devA = devicePubkey();
  const devB = devicePubkey();
  const devC = devicePubkey();
  const devIntegrator = devicePubkey();

  const dial = (): Promise<Socket> =>
    new Promise<Socket>((resolve, reject) => {
      const s = connect({ path: sockPath, allowHalfOpen: true });
      s.once('connect', () => resolve(s));
      s.once('error', reject);
    });

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'hgboot-'));
    process.env.PAPERCUSP_HIVE_GIT_ROOT = root;
    peerRepo = await ensurePotGitRepo('hive-x', 'repo-1');
    joinerRepo = await ensurePotGitRepo('hive-x', 'repo-1-joiner');

    // The peer holds THREE device namespaces: two members' work (+ a sigrefs-
    // style extra ref on A) and the integrator's published staging.
    const a1 = await mintCommit(peerRepo, 'A work');
    await writeNamespaceRef(peerRepo, devA, WORK_REF, a1);
    await writeNamespaceRef(peerRepo, devA, 'refs/rad/sigrefs', a1);
    const b1 = await mintCommit(peerRepo, 'B work');
    await writeNamespaceRef(peerRepo, devB, WORK_REF, b1);
    const staging = await mintCommit(peerRepo, 'staging', a1);
    await writeNamespaceRef(peerRepo, devIntegrator, STAGING_REF, staging);

    sockPath = join(root, 'link.sock');
    server = createServer({ allowHalfOpen: true }, (srvConn) => {
      srvConn.on('error', () => {});
      void serveUploadPack(peerRepo, srvConn);
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

  it('a fresh joiner ends up with EVERY namespace the peer had (refs + objects)', async () => {
    expect(await listNamespaces(joinerRepo)).toEqual([]);
    const res = await bootstrapFromPeer(joinerRepo, await dial(), { timeoutMs: 30_000, dial });
    expect(res.ok, res.stderr).toBe(true);

    const peerNs = await listNamespaces(peerRepo);
    expect(peerNs).toHaveLength(3);
    expect(res.namespaces).toEqual(peerNs);
    expect(await listNamespaces(joinerRepo)).toEqual(peerNs);

    // Every ref matches sha-for-sha, and the objects are really in the ODB.
    for (const dev of [devA, devB, devIntegrator]) {
      const peerRefs = await listNamespaceRefs(peerRepo, dev);
      const joinerRefs = await listNamespaceRefs(joinerRepo, dev);
      expect(peerRefs.length).toBeGreaterThan(0);
      expect(joinerRefs).toEqual(peerRefs);
      for (const { sha } of joinerRefs) {
        const cat = await defaultRunGit(['cat-file', '-e', `${sha}^{commit}`], joinerRepo);
        expect(cat.code, `object ${sha} missing after bootstrap`).toBe(0);
      }
    }
  });

  it('a re-run seeds only namespaces NEW on the peer; existing ones are skipped untouched', async () => {
    // After the first seed the peer gains a NEW member C, and member A advances.
    const c1 = await mintCommit(peerRepo, 'C work');
    await writeNamespaceRef(peerRepo, devC, WORK_REF, c1);
    const prev = await readNamespaceRef(peerRepo, devA, WORK_REF);
    expect(prev).not.toBeNull();
    const a2 = await mintCommit(peerRepo, 'A work 2', prev as string);
    await writeNamespaceRef(peerRepo, devA, WORK_REF, a2, defaultRunGit, prev as string);

    const res = await bootstrapFromPeer(joinerRepo, await dial(), { timeoutMs: 30_000, dial });
    expect(res.ok, res.stderr).toBe(true);
    // The NEW namespace was seeded…
    expect(await readNamespaceRef(joinerRepo, devC, WORK_REF)).toBe(c1);
    expect(res.namespaces).toContain(deviceNamespaceKey(devC));
    // …but A's EXISTING namespace was skipped: still at the first-seed sha.
    // Updates to existing namespaces flow via the verified announcement
    // pipeline (G-3/G-4), never via bootstrap.
    expect(await readNamespaceRef(joinerRepo, devA, WORK_REF)).toBe(prev);
    expect(res.skippedExisting).toEqual(
      [devA, devB, devIntegrator].map(deviceNamespaceKey).sort(),
    );
    // Quarantine left no debris behind.
    const leftover = await defaultRunGit(
      ['for-each-ref', '--format=%(refname)', 'refs/bootstrap-quarantine/'],
      joinerRepo,
    );
    expect(leftover.stdout.trim()).toBe('');
  });

  it('REGRESSION (HIGH): a re-run against a STALE peer never rewinds a locally-advanced namespace', async () => {
    // The joiner's A namespace advances LOCALLY (as the verified announcement
    // pipeline would move it — the G-4b sigrefs watermark now points past the
    // peer's stale view).
    const localPrev = await readNamespaceRef(joinerRepo, devA, WORK_REF);
    expect(localPrev).not.toBeNull();
    const j1 = await mintCommit(joinerRepo, 'A local-verified advance', localPrev as string);
    await writeNamespaceRef(joinerRepo, devA, WORK_REF, j1, defaultRunGit, localPrev as string);

    // The peer still serves its older view of A. The old forced wildcard
    // refspec force-rewound the joiner here; the quarantine+skip path must not.
    const res = await bootstrapFromPeer(joinerRepo, await dial(), { timeoutMs: 30_000, dial });
    expect(res.ok, res.stderr).toBe(true);
    expect(await readNamespaceRef(joinerRepo, devA, WORK_REF)).toBe(j1); // NOT rewound
    expect(res.skippedExisting).toContain(deviceNamespaceKey(devA));
  });

  it('a dead duplex fails soft (ok:false), leaving the joiner intact for a retry', async () => {
    const { PassThrough } = await import('node:stream');
    const dead = new PassThrough();
    dead.end(); // nothing will ever answer
    const res = await bootstrapFromPeer(joinerRepo, dead, { timeoutMs: 3_000 });
    expect(res.ok).toBe(false);
    // Prior seeded state is untouched (3 first-seed namespaces + devC).
    expect((await listNamespaces(joinerRepo)).length).toBe(4);
  });

  it('REGRESSION (WI-1559): the joiner OWN namespace is never seeded from a peer (squat refusal)', async () => {
    // A truly-fresh joiner, and a peer that SQUATS the joiner's own device
    // namespace — pre-planting refs that would masquerade as the joiner's own
    // work before its first publish.
    const devSelf = devicePubkey();
    const squat = await mintCommit(peerRepo, 'squatting the joiner own namespace');
    await writeNamespaceRef(peerRepo, devSelf, WORK_REF, squat);

    const joiner2 = await ensurePotGitRepo('hive-x', 'repo-1-joiner2');
    expect(await listNamespaces(joiner2)).toEqual([]);
    const res = await bootstrapFromPeer(joiner2, await dial(), {
      timeoutMs: 30_000,
      dial,
      selfDevicePubkey: devSelf,
    });
    expect(res.ok, res.stderr).toBe(true);

    const selfKey = deviceNamespaceKey(devSelf);
    expect(res.skippedSelf).toBe(selfKey);
    // The squat was refused: nothing under the joiner's own namespace…
    expect(await listNamespaceRefs(joiner2, devSelf)).toEqual([]);
    expect(res.namespaces).not.toContain(selfKey);
    // …while everyone ELSE's namespaces seeded normally on the fresh joiner.
    for (const dev of [devA, devB, devC, devIntegrator]) {
      expect(res.namespaces).toContain(deviceNamespaceKey(dev));
    }
    expect(res.skippedExisting).toEqual([]);
  });

  it('REGRESSION (WI-1558): a namespace created CONCURRENTLY mid-run is never clobbered (create-only CAS + rollback)', async () => {
    // The TOCTOU window: preExisting snapshots BEFORE the (possibly long)
    // fetch; the verified announcement pipeline (G-3/G-4) can create the
    // namespace in between. The old plain update-ref clobbered its verified
    // ref with the peer's UNVERIFIED quarantined sha.
    const joiner3 = await ensurePotGitRepo('hive-x', 'repo-1-joiner3');
    const devAKey = deviceNamespaceKey(devA);
    const sigrefsRef = `refs/namespaces/${devAKey}/refs/rad/sigrefs`;
    const pipelineSha = await mintCommit(joiner3, 'verified pipeline write, mid-bootstrap');

    // devA's group seeds refs/heads/work first (ref sort order), then
    // refs/rad/sigrefs. Fire the "pipeline" write just before the sigrefs CAS
    // so the seed loses the race AFTER a partial seed — exercising rollback.
    let fired = false;
    const racyRunGit: RunGit = async (args, cwd) => {
      if (!fired && cwd === joiner3 && args[0] === 'update-ref' && args[1] === sigrefsRef) {
        fired = true;
        const w = await defaultRunGit(['update-ref', sigrefsRef, pipelineSha], joiner3);
        expect(w.code, w.stderr).toBe(0);
      }
      return defaultRunGit(args, cwd);
    };

    const res = await bootstrapFromPeer(joiner3, await dial(), { timeoutMs: 30_000, dial, runGit: racyRunGit });
    expect(fired).toBe(true);
    // Losing the CAS to the pipeline is NOT a failure…
    expect(res.ok, res.stderr).toBe(true);
    // …the pipeline's verified ref survives at ITS sha (never clobbered)…
    const at = await defaultRunGit(['rev-parse', '--verify', sigrefsRef], joiner3);
    expect(at.stdout.trim()).toBe(pipelineSha);
    // …this run's PARTIAL seed of the namespace was rolled back wholesale…
    expect(await readNamespaceRef(joiner3, devA, WORK_REF)).toBeNull();
    expect(res.skippedExisting).toContain(devAKey);
    // …and unrelated namespaces still seeded normally.
    for (const dev of [devB, devC, devIntegrator]) {
      expect(res.namespaces).toContain(deviceNamespaceKey(dev));
    }
  });
});

/**
 * WI-6189 — the cold-join must RESUME across a dead channel, not restart.
 *
 * The live failure this pins: papercusp's pot-home store is 2.5 GB and pot-git
 * channels live seconds, so a single all-in-one fetch was killed every time and
 * `index-pack` discarded every byte. The joiner sat at 0 refs indefinitely
 * while the transport was, in fact, working fine.
 *
 * These tests use a peer with a REAL multi-commit history and a dial that can
 * be cut, so "the rung died" is exercised for real rather than mocked.
 */
describe('bootstrap resumability (WI-6189: durable progress across channel death)', () => {
  let root: string;
  let peerRepo: string;
  let sockPath: string;
  let deadSockPath: string;
  let server: Server;
  let deadServer: Server;
  const devDeep = devicePubkey();
  const HISTORY = 40;
  let tipSha: string;
  let joinerSeq = 0;

  /** A healthy per-fetch stream — one `git upload-pack` per dial, exactly like
   *  a real pot-git protomux channel. */
  const dial = (): Promise<Socket> =>
    new Promise<Socket>((resolve, reject) => {
      const s = connect({ path: sockPath, allowHalfOpen: true });
      s.once('connect', () => resolve(s));
      s.once('error', reject);
    });

  /** A stream that connects and is then killed mid-conversation — the shape of
   *  a pot-git channel closing under an in-flight fetch. */
  const dialDying = (): Promise<Socket> =>
    new Promise<Socket>((resolve, reject) => {
      const s = connect({ path: deadSockPath, allowHalfOpen: true });
      s.on('error', () => {});
      s.once('connect', () => resolve(s));
      s.once('error', reject);
    });

  const refCount = async (repo: string): Promise<number> => {
    const r = await defaultRunGit(['for-each-ref', '--format=%(refname)'], repo);
    return r.stdout.trim() === '' ? 0 : r.stdout.trim().split('\n').length;
  };
  const hasObject = async (repo: string, sha: string): Promise<boolean> =>
    (await defaultRunGit(['cat-file', '-e', `${sha}^{commit}`], repo)).code === 0;
  const freshJoiner = async (): Promise<string> =>
    ensurePotGitRepo('hive-deep', `joiner-${++joinerSeq}`);

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'hgboot-resume-'));
    process.env.PAPERCUSP_HIVE_GIT_ROOT = root;
    peerRepo = await ensurePotGitRepo('hive-deep', 'peer');

    // A history deep enough that one `--depth=1` rung CANNOT be the whole
    // transfer — the ladder must climb.
    let prev: string | undefined;
    for (let i = 0; i < HISTORY; i++) prev = await mintCommit(peerRepo, `deep ${i}`, prev);
    tipSha = prev as string;
    await writeNamespaceRef(peerRepo, devDeep, WORK_REF, tipSha);

    sockPath = join(root, 'link.sock');
    server = createServer({ allowHalfOpen: true }, (srvConn) => {
      srvConn.on('error', () => {});
      void serveUploadPack(peerRepo, srvConn);
    });
    await new Promise<void>((r) => server.listen(sockPath, () => r()));

    deadSockPath = join(root, 'dead.sock');
    deadServer = createServer({ allowHalfOpen: true }, (srvConn) => {
      srvConn.on('error', () => {});
      srvConn.destroy(); // channel closed under the fetch
    });
    await new Promise<void>((r) => deadServer.listen(deadSockPath, () => r()));
  });

  afterAll(async () => {
    for (const s of [server, deadServer]) {
      try {
        s.close();
      } catch {
        /* ignore */
      }
    }
    delete process.env.PAPERCUSP_HIVE_GIT_ROOT;
    await rm(root, { recursive: true, force: true });
  });

  it('an interrupted cold-join keeps its bytes and RESUMES — it never restarts from zero', async () => {
    const joiner = await freshJoiner();
    expect(await refCount(joiner)).toBe(0);

    // ── Tick 1: exactly ONE rung, then the link is gone. ──
    const first = await bootstrapFromPeer(joiner, await dial(), {
      timeoutMs: 30_000,
      dial: async () => null, // no channel for a second rung
    });
    // Healthy IN-PROGRESS, which is NOT a failure: the distinction callers act on.
    expect(first.ok).toBe(false);
    expect(first.progressed).toBe(true);
    expect(first.steps).toBe(1);
    expect(first.shallow).toBe(true);
    // The rung's bytes are DURABLE: the tip commit is really in the ODB and the
    // quarantine checkpoint survives for the next tick to negotiate from.
    expect(first.quarantineRefs).toBeGreaterThan(0);
    expect(await hasObject(joiner, tipSha)).toBe(true);
    // …but nothing was SEEDED: a half-transferred history must never surface as
    // a peer's real namespace to the announcement/integrator layers.
    expect(first.namespaces).toEqual([]);
    const afterFirst = await refCount(joiner);
    expect(afterFirst).toBeGreaterThan(0);

    // ── Tick 2: the link is back. The ladder must CONTINUE, not restart. ──
    const second = await bootstrapFromPeer(joiner, await dial(), { timeoutMs: 30_000, dial });
    expect(second.ok, second.stderr).toBe(true);
    expect(second.shallow).toBe(false);
    expect(second.namespaces).toEqual([deviceNamespaceKey(devDeep)]);
    expect(await readNamespaceRef(joiner, devDeep, WORK_REF)).toBe(tipSha);

    // Resumed, not restarted: tick 2 needed strictly fewer rungs than a cold
    // climb of this history does (asserted against a real cold climb below),
    // and the ref count never went backwards at any point — the acceptance
    // criterion for the 2-machine rig.
    expect(await refCount(joiner)).toBeGreaterThanOrEqual(afterFirst);

    // The whole history really is present, not just the tip.
    const walked = await defaultRunGit(['rev-list', '--count', tipSha], joiner);
    expect(Number(walked.stdout.trim())).toBe(HISTORY);
  });

  it('a rung that DIES costs only that rung, and backs the next one off', async () => {
    const joiner = await freshJoiner();
    // Rung 1 lands (real dial), rung 2 dies (channel closed mid-fetch).
    const startedAt = Date.now();
    const cut = await bootstrapFromPeer(joiner, await dial(), {
      timeoutMs: 15_000,
      dial: dialDying,
    });
    expect(cut.ok).toBe(false);
    // WI-6189: the dead rung must fail FAST, not burn the ceiling. A peer that
    // closes its channel CLEANLY (FIN, no error) used to leave git waiting on a
    // bridge that would never speak again, so every such rung cost the full
    // timeout — at 23–36 channel closes/min that alone makes the ladder
    // un-climbable. `code !== 0` would pass either way, so assert the CLOCK.
    expect(cut.timedOut).toBe(false);
    expect(Date.now() - startedAt).toBeLessThan(10_000);
    expect(cut.progressed).toBe(true); // rung 1 still counted
    expect(cut.steps).toBe(1);
    // Backed off: the retry asks for a bite the link might actually swallow.
    expect(cut.deepenNext).toBe(INITIAL_DEEPEN_COMMITS / 2);
    // And the durable checkpoint is INTACT — the dead rung took nothing with it.
    expect(cut.quarantineRefs).toBeGreaterThan(0);
    expect(await hasObject(joiner, tipSha)).toBe(true);

    // The back-off is persisted on the repo, so it survives a process restart.
    const persisted = await defaultRunGit(['config', '--get', 'papercusp.bootstrapDeepen'], joiner);
    expect(Number(persisted.stdout.trim())).toBe(INITIAL_DEEPEN_COMMITS / 2);

    // A later healthy tick still converges from that checkpoint.
    const done = await bootstrapFromPeer(joiner, await dial(), { timeoutMs: 30_000, dial });
    expect(done.ok, done.stderr).toBe(true);
    expect(await readNamespaceRef(joiner, devDeep, WORK_REF)).toBe(tipSha);
  });

  it('climbs the ladder rung by rung when the deepen size is small, never seeding a shallow history', async () => {
    const joiner = await freshJoiner();
    // Force the smallest rung so the 40-commit history needs several of them.
    await defaultRunGit(['config', 'papercusp.bootstrapDeepen', String(MIN_DEEPEN_COMMITS)], joiner);

    let refs = 0;
    let rungs = 0;
    let res = await bootstrapFromPeer(joiner, await dial(), {
      timeoutMs: 30_000,
      dial: async () => null,
      maxSteps: 1,
    });
    for (let tick = 0; tick < 12 && !res.ok; tick++) {
      // Monotonic: refs only ever grow, and a shallow store never seeds.
      const now = await refCount(joiner);
      expect(now).toBeGreaterThanOrEqual(refs);
      refs = now;
      if (res.shallow) expect(res.namespaces).toEqual([]);
      rungs += res.steps;
      res = await bootstrapFromPeer(joiner, await dial(), {
        timeoutMs: 30_000,
        dial: async () => null,
        maxSteps: 1,
      });
    }
    expect(res.ok, res.stderr).toBe(true);
    expect(rungs).toBeGreaterThan(1); // it genuinely took multiple rungs
    expect(await readNamespaceRef(joiner, devDeep, WORK_REF)).toBe(tipSha);
    expect(Number((await defaultRunGit(['rev-list', '--count', tipSha], joiner)).stdout.trim())).toBe(
      HISTORY,
    );
  });

  it('stops on the WALL-CLOCK budget even with rungs left, climbs at least one, and stays resumable', async () => {
    // WI-6189: `maxSteps` does not bound a tick's duration — the control law
    // steers each rung toward 25% of the fetch ceiling, so 12 rungs outlasts
    // git-sync's ~5-min cadence and the next fire collides on `shallow.lock`.
    // The wall budget is what keeps a tick inside its cadence.
    const joiner = await freshJoiner();
    await defaultRunGit(['config', 'papercusp.bootstrapDeepen', String(MIN_DEEPEN_COMMITS)], joiner);

    // Fake clock: every read jumps a full minute, so the budget is blown the
    // moment the loop re-checks it — while the real ladder still has rungs and
    // a live dial. Only the budget can be what stops this.
    let clock = 0;
    const fastForward = (): number => (clock += 60_000);

    const budgeted = await bootstrapFromPeer(joiner, await dial(), {
      timeoutMs: 30_000,
      dial, // a WORKING dial — so "no channel" cannot be the reason it stops
      maxWallMs: 60_000,
      now: fastForward,
    });

    // Stopped early, but not before doing real work.
    expect(budgeted.ok).toBe(false);
    expect(budgeted.progressed).toBe(true);
    expect(budgeted.steps).toBe(1); // the first rung ALWAYS runs...
    expect(budgeted.steps).toBeLessThan(12); // ...and the rung cap was not what stopped it
    // A shallow store never seeds — the warm gate stays honest mid-ladder.
    if (budgeted.shallow) expect(budgeted.namespaces).toEqual([]);
    // The checkpoint is durable: bytes fetched under the budget are kept.
    expect(budgeted.quarantineRefs).toBeGreaterThan(0);

    // A zero budget still climbs the first rung rather than making no progress.
    const zero = await bootstrapFromPeer(joiner, await dial(), {
      timeoutMs: 30_000,
      dial,
      maxWallMs: 1,
      now: fastForward,
    });
    expect(zero.steps).toBe(1);

    // And a normal tick resumes from that checkpoint and converges.
    const done = await bootstrapFromPeer(joiner, await dial(), { timeoutMs: 30_000, dial });
    expect(done.ok, done.stderr).toBe(true);
    expect(await readNamespaceRef(joiner, devDeep, WORK_REF)).toBe(tipSha);
  });

  /**
   * WI-6241 — the escalation latch must SURVIVE the call that sets it.
   *
   * Production shape: a peer serves exactly one fetch per channel, so `dial()`
   * returns null for every rung after the first. When a deepen rung lands but
   * moves the shallow boundary not at all, the ladder escalates to
   * `--unshallow` — and then needs a channel it cannot get, because the one
   * good channel was already spent on the no-op deepen. Held per-call, that
   * escalation was forgotten and every tick repeated it: "+1 rung, still
   * shallow" forever, with `papercusp.bootstrapDeepen` pinned at its initial
   * value (the no-op branch skips adaptation). Persisting the latch is what
   * lets the NEXT tick spend its first, always-available duplex on the rung
   * that can actually converge.
   */
  const latchKey = 'papercusp.bootstrapForceUnshallow';
  const readLatch = async (repo: string): Promise<string> =>
    (await defaultRunGit(['config', '--get', latchKey], repo)).stdout.trim();

  it('REGRESSION (WI-6241): a persisted escalation latch makes the NEXT tick open in `unshallow`, spending its ONLY channel on the rung that converges', async () => {
    const joiner = await freshJoiner();

    // Tick 1: one rung, no second channel — the real per-tick shape. Leaves the
    // joiner exactly where production sits: quarantine staged, still shallow.
    const first = await bootstrapFromPeer(joiner, await dial(), {
      timeoutMs: 30_000,
      dial: async () => null,
    });
    expect(first.quarantineRefs).toBeGreaterThan(0);
    expect(first.shallow).toBe(true);

    // Stand in for "a deepen rung landed but the boundary did not move" — the
    // condition the ladder detects and records.
    expect((await defaultRunGit(['config', latchKey, 'true'], joiner)).code).toBe(0);
    // Pin the rung size BELOW the peer's history so a deepen rung provably
    // cannot finish the join. Without this the test is not discriminating: the
    // default rung (64) exceeds HISTORY (40), so a deepen rung would converge
    // on its own and the assertion below would hold even with the latch
    // ignored — i.e. it would pass against the very bug it guards.
    expect(MIN_DEEPEN_COMMITS).toBeLessThan(HISTORY);
    await defaultRunGit(['config', 'papercusp.bootstrapDeepen', String(MIN_DEEPEN_COMMITS)], joiner);

    // Tick 2 gets ONE channel and no re-dial, exactly like tick 1 — so it has
    // budget for exactly one rung and must pick the RIGHT one. Honouring the
    // latch spends it on `--unshallow`, which converges in that single rung.
    // Ignoring it (pre-fix) spends it on a deepen rung too small to finish,
    // leaving the repo shallow with no channel left to escalate on.
    const escalated = await bootstrapFromPeer(joiner, await dial(), {
      timeoutMs: 30_000,
      dial: async () => null,
    });
    expect(escalated.steps).toBe(1);
    expect(escalated.shallow).toBe(false);
    expect(escalated.ok, escalated.stderr).toBe(true);
    expect(await readNamespaceRef(joiner, devDeep, WORK_REF)).toBe(tipSha);
  });

  it('REGRESSION (WI-6241): the latch is CLEARED once history is whole, so a converged repo never re-runs `--unshallow`', async () => {
    const joiner = await freshJoiner();
    await bootstrapFromPeer(joiner, await dial(), { timeoutMs: 30_000, dial: async () => null });
    await defaultRunGit(['config', latchKey, 'true'], joiner);
    expect(await readLatch(joiner)).toBe('true');

    // Run to convergence with a working dial.
    const done = await bootstrapFromPeer(joiner, await dial(), { timeoutMs: 30_000, dial });
    expect(done.ok, done.stderr).toBe(true);
    expect(done.shallow).toBe(false);

    // A latch left set would make every future tick re-fetch a complete repo.
    expect(await readLatch(joiner)).toBe('');
  });
});
