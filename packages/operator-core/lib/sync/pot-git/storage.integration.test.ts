/**
 * storage.integration.test.ts — the G-1 pot-git store against a REAL temp bare
 * repo (git on PATH, no network). Proves the per-device-namespace + shared-ODB
 * model end to end: init, write/read/delete namespaced refs, list namespaces +
 * their refs, the device→hex namespace mapping, and the path-safety guards.
 *
 * Run: cd packages/operator-core && npx vitest run --config vitest.integration.config.ts lib/sync/pot-git/storage.integration.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import {
  defaultRunGit,
  potGitRoot,
  hiveGitRepoPath,
  deviceNamespaceKey,
  namespaceRefPath,
  ensurePotGitRepo,
  writeNamespaceRef,
  readNamespaceRef,
  deleteNamespaceRef,
  listNamespaces,
  listNamespaceRefs,
  pathExists,
  sweepStalePackTmpFiles,
  noteFetchInFlight,
  FETCH_CEILING_MS_MIRROR,
  STALE_PACK_TMP_MAX_AGE_MS,
  STALE_SHALLOW_LOCK_MAX_AGE_MS,
} from './storage';
import { DEFAULT_FETCH_TIMEOUT_MS } from './fetch-transport';

/** A raw-32 Ed25519 pubkey as base64 (the wire form). */
function devicePubkey(): string {
  const { publicKey } = generateKeyPairSync('ed25519');
  const spki = (publicKey as KeyObject).export({ format: 'der', type: 'spki' }) as Buffer;
  return spki.subarray(spki.length - 32).toString('base64');
}

/** Mint a real commit with no stdin dependency: empty tree → commit-tree. */
async function mintCommit(repoPath: string, msg: string): Promise<string> {
  const tree = await defaultRunGit(['hash-object', '-w', '-t', 'tree', '/dev/null'], repoPath);
  expect(tree.code, tree.stderr).toBe(0);
  const emptyTree = tree.stdout.trim();
  const c = await defaultRunGit(
    ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit-tree', emptyTree, '-m', msg],
    repoPath,
  );
  expect(c.code, c.stderr).toBe(0);
  return c.stdout.trim();
}

describe('pot-git storage (real bare repo)', () => {
  let root: string;
  let repoPath: string;
  const devA = devicePubkey();
  const devB = devicePubkey();

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'hivegit-'));
    process.env.PAPERCUSP_HIVE_GIT_ROOT = root;
    repoPath = await ensurePotGitRepo('my-hive', 'repo-42');
  });

  afterAll(async () => {
    delete process.env.PAPERCUSP_HIVE_GIT_ROOT;
    await rm(root, { recursive: true, force: true });
  });

  it('ensurePotGitRepo makes a bare repo at the (hive, repo) path; idempotent', async () => {
    expect(repoPath).toBe(hiveGitRepoPath('my-hive', 'repo-42'));
    expect(repoPath.startsWith(potGitRoot())).toBe(true);
    const again = await ensurePotGitRepo('my-hive', 'repo-42'); // no throw, same path
    expect(again).toBe(repoPath);
    const head = await defaultRunGit(['rev-parse', '--is-bare-repository'], repoPath);
    expect(head.stdout.trim()).toBe('true');
  });

  it('uses distinct bare repos for different repo keys under the same hive', async () => {
    const repoA = await ensurePotGitRepo('my-hive', 'repo-a');
    const repoB = await ensurePotGitRepo('my-hive', 'repo-b');
    expect(repoA).toBe(hiveGitRepoPath('my-hive', 'repo-a'));
    expect(repoB).toBe(hiveGitRepoPath('my-hive', 'repo-b'));
    expect(repoA).not.toBe(repoB);
    const headA = await defaultRunGit(['rev-parse', '--is-bare-repository'], repoA);
    const headB = await defaultRunGit(['rev-parse', '--is-bare-repository'], repoB);
    expect(headA.stdout.trim()).toBe('true');
    expect(headB.stdout.trim()).toBe('true');
  });

  it('deviceNamespaceKey is raw-32 → 64 hex; namespaceRefPath composes; rejects bad input', () => {
    const hex = deviceNamespaceKey(devA);
    expect(hex).toMatch(/^[0-9a-f]{64}$/);
    expect(namespaceRefPath(devA, 'refs/heads/work')).toBe(`refs/namespaces/${hex}/refs/heads/work`);
    expect(() => deviceNamespaceKey('too-short')).toThrow(/raw-32/);
    expect(() => namespaceRefPath(devA, 'heads/work')).toThrow(/refs\//);
  });

  it('path-safety guards reject traversal in hive slug / repo key', () => {
    expect(() => hiveGitRepoPath('../evil', 'r')).toThrow(/unsafe/);
    expect(() => hiveGitRepoPath('h', 'a/b')).toThrow(/unsafe/);
    expect(() => hiveGitRepoPath('h', '..')).toThrow(/unsafe/);
  });

  it('write → read a namespaced ref; a missing ref reads null', async () => {
    const sha = await mintCommit(repoPath, 'A work 1');
    expect(await readNamespaceRef(repoPath, devA, 'refs/heads/work')).toBeNull();
    await writeNamespaceRef(repoPath, devA, 'refs/heads/work', sha);
    expect(await readNamespaceRef(repoPath, devA, 'refs/heads/work')).toBe(sha);
  });

  it('each device writes ONLY its own namespace; the ODB is shared (same sha, one store)', async () => {
    const shaA = await mintCommit(repoPath, 'A work 2');
    const shaB = await mintCommit(repoPath, 'B work 1');
    await writeNamespaceRef(repoPath, devA, 'refs/heads/work', shaA);
    await writeNamespaceRef(repoPath, devB, 'refs/heads/work', shaB);
    // Same ref name, different namespaces → no collision.
    expect(await readNamespaceRef(repoPath, devA, 'refs/heads/work')).toBe(shaA);
    expect(await readNamespaceRef(repoPath, devB, 'refs/heads/work')).toBe(shaB);
    // Both objects live in the ONE shared ODB of this bare repo.
    for (const s of [shaA, shaB]) {
      const cat = await defaultRunGit(['cat-file', '-e', s], repoPath);
      expect(cat.code).toBe(0);
    }
  });

  it('listNamespaces enumerates both devices; listNamespaceRefs strips the prefix', async () => {
    const ns = await listNamespaces(repoPath);
    expect(ns).toContain(deviceNamespaceKey(devA));
    expect(ns).toContain(deviceNamespaceKey(devB));
    await writeNamespaceRef(repoPath, devA, 'refs/rad/sigrefs', await mintCommit(repoPath, 'A sig'));
    const refs = await listNamespaceRefs(repoPath, devA);
    const names = refs.map((r) => r.ref);
    expect(names).toContain('refs/heads/work');
    expect(names).toContain('refs/rad/sigrefs');
    expect(names.every((n) => n.startsWith('refs/'))).toBe(true); // prefix stripped, normal ref names
  });

  it('CAS write refuses a stale expectedOld; delete is idempotent', async () => {
    const s1 = await mintCommit(repoPath, 'cas 1');
    const s2 = await mintCommit(repoPath, 'cas 2');
    await writeNamespaceRef(repoPath, devB, 'refs/heads/cas', s1);
    // wrong expectedOld → rejected
    await expect(writeNamespaceRef(repoPath, devB, 'refs/heads/cas', s2, defaultRunGit, s2)).rejects.toThrow();
    expect(await readNamespaceRef(repoPath, devB, 'refs/heads/cas')).toBe(s1);
    // correct expectedOld → moves
    await writeNamespaceRef(repoPath, devB, 'refs/heads/cas', s2, defaultRunGit, s1);
    expect(await readNamespaceRef(repoPath, devB, 'refs/heads/cas')).toBe(s2);
    // delete, then delete again (idempotent)
    await deleteNamespaceRef(repoPath, devB, 'refs/heads/cas');
    expect(await readNamespaceRef(repoPath, devB, 'refs/heads/cas')).toBeNull();
    await deleteNamespaceRef(repoPath, devB, 'refs/heads/cas'); // no throw
  });
});

describe('defaultRunGit timeoutMs override (github-bridge-ingress-timeout-too-short-2026-07-20, EI-18189246091367226)', () => {
  it('a custom timeoutMs kills the process at that budget, not the 60s default', async () => {
    // `hash-object --stdin` blocks reading stdin forever (we never write/close
    // it) — a controlled, deterministic "hang" to prove the override actually
    // shortens the kill budget instead of waiting out the 60s default.
    const start = Date.now();
    const res = await defaultRunGit(['hash-object', '--stdin'], '/tmp', { timeoutMs: 300 });
    const elapsedMs = Date.now() - start;
    expect(res.code).toBe(-1);
    expect(res.stderr).toContain('timed out');
    // Killed near the 300ms budget (SIGTERM at 300ms; well under the 60s default).
    expect(elapsedMs).toBeLessThan(15_000);
  }, 20_000);

  it('omitting timeoutMs still resolves promptly for a fast command (default unaffected)', async () => {
    const res = await defaultRunGit(['--version'], '/tmp');
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('git version');
  });
});

/**
 * EI-18745600910177355 — orphaned `index-pack` temp packs.
 *
 * Every SIGKILLed pot-git fetch (timeout ceiling, or a channel closing
 * mid-pack) leaves its partial `objects/pack/tmp_pack_*` behind, because
 * SIGKILL is uncatchable so index-pack's own cleanup never runs. Nothing else
 * removes them — `git gc` only prunes temp names it wrote itself. Measured on
 * the P-302 rig VM: 13 orphans totalling 21 GB in a store holding 0 refs and
 * 64 MB of real objects.
 */
describe('sweepStalePackTmpFiles (EI-18745600910177355: leaked partial packs)', () => {
  let root: string;
  let repo: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'hgsweep-'));
    process.env.PAPERCUSP_HIVE_GIT_ROOT = root;
    repo = await ensurePotGitRepo('hive-sweep', 'repo');
  });

  afterAll(async () => {
    delete process.env.PAPERCUSP_HIVE_GIT_ROOT;
    await rm(root, { recursive: true, force: true });
  });

  it('reclaims STALE temp packs, and leaves an in-flight fetch and real packs alone', async () => {
    const packDir = join(repo, 'objects', 'pack');
    await mkdir(packDir, { recursive: true });
    const write = async (name: string, bytes: number, ageMs: number): Promise<string> => {
      const p = join(packDir, name);
      await writeFile(p, Buffer.alloc(bytes, 1));
      const when = new Date(Date.now() - ageMs);
      await utimes(p, when, when);
      return p;
    };

    const stale = await write('tmp_pack_AuYuz6', 4096, 60 * 60_000); // an hour dead
    const staleIdx = await write('tmp_idx_AuYuz6', 512, 60 * 60_000);
    // Still inside the fetch ceiling — this one may be a LIVE transfer, ours or
    // another leg's, and pulling it would corrupt a fetch in progress.
    const inFlight = await write('tmp_pack_LiveNow', 4096, 5_000);
    // Not ours to touch, no matter how old.
    const realPack = await write('pack-dead0000000000000000000000000000beef.pack', 4096, 60 * 60_000);

    const res = await sweepStalePackTmpFiles(repo);

    expect(res.removed.sort()).toEqual(['tmp_idx_AuYuz6', 'tmp_pack_AuYuz6']);
    expect(res.bytesReclaimed).toBe(4096 + 512);
    expect(await pathExists(stale)).toBe(false);
    expect(await pathExists(staleIdx)).toBe(false);
    expect(await pathExists(inFlight)).toBe(true);
    expect(await pathExists(realPack)).toBe(true);
  });

  /**
   * WI-6189, live-caught on the P-302 rig: a stranded `shallow.lock` is worse
   * than a leaked pack. git takes it on every `--depth`/`--deepen` fetch, and a
   * SIGKILLed rung leaves it behind — after which EVERY shallow fetch fails
   * instantly with "Unable to create '…/shallow.lock': File exists". The
   * cold-join ladder then never advances again, on any tick, forever. On a link
   * that drops channels 23–36x/min that is the expected outcome, not a corner
   * case, so the sweep must clear it or the whole feature self-wedges in
   * production with every test still green.
   */
  it('clears a STRANDED shallow.lock (which permanently wedges the ladder), but not a live one', async () => {
    const lockPath = join(repo, 'shallow.lock');
    const setLock = async (ageMs: number): Promise<void> => {
      await writeFile(lockPath, 'deadbeef\n');
      const when = new Date(Date.now() - ageMs);
      await utimes(lockPath, when, when);
    };

    // A lock a killed fetch left behind an hour ago: reclaim it.
    await setLock(60 * 60_000);
    const swept = await sweepStalePackTmpFiles(repo);
    expect(swept.removed).toContain('shallow.lock');
    expect(await pathExists(lockPath)).toBe(false);

    // A lock a fetch may still be holding: leave it strictly alone.
    await setLock(5_000);
    const held = await sweepStalePackTmpFiles(repo);
    expect(held.removed).not.toContain('shallow.lock');
    expect(await pathExists(lockPath)).toBe(true);
    await rm(lockPath, { force: true });
  });

  /**
   * The two leaks MUST NOT share an age gate — pinning the exact live failure.
   *
   * On the rig 2026-07-26 a rung was SIGKILLed at 22:51Z and stranded the lock;
   * the 22:56Z tick then died instantly on `Unable to create shallow.lock`. Under
   * the packs' 15-min gate the store stays wedged until 23:06Z — ~3 ticks lost
   * per killed rung, on a link that kills rungs constantly. The previous test
   * passes under EITHER gate (1 h and 5 s sit outside both), so it could not have
   * caught this; this one fails the moment the lock is put back on the packs'
   * gate.
   */
  it('sweeps a stranded shallow.lock LONG before a same-age temp pack (separate gates)', async () => {
    // Between the two gates: past the fetch ceiling (so no live fetch can hold
    // the lock) but well inside the packs' 15 min. This is the 22:51→22:56 case.
    const betweenMs = (STALE_SHALLOW_LOCK_MAX_AGE_MS + STALE_PACK_TMP_MAX_AGE_MS) / 2;
    expect(STALE_SHALLOW_LOCK_MAX_AGE_MS).toBeLessThan(STALE_PACK_TMP_MAX_AGE_MS);

    const lockPath = join(repo, 'shallow.lock');
    const tmpPack = join(repo, 'objects', 'pack', 'tmp_pack_BetwEn');
    const when = new Date(Date.now() - betweenMs);
    await writeFile(lockPath, 'deadbeef\n');
    await writeFile(tmpPack, Buffer.alloc(64));
    await utimes(lockPath, when, when);
    await utimes(tmpPack, when, when);

    const res = await sweepStalePackTmpFiles(repo);

    // The wedging lock goes NOW…
    expect(res.removed).toContain('shallow.lock');
    expect(await pathExists(lockPath)).toBe(false);
    // …while the merely-wasteful temp pack is still left alone.
    expect(res.removed).not.toContain('tmp_pack_BetwEn');
    expect(await pathExists(tmpPack)).toBe(true);
    await rm(tmpPack, { force: true });
  });

  /**
   * `bootstrapFromPeer` derives `shallowLockMaxAgeMs` from ITS OWN fetch ceiling
   * rather than taking the default, so a caller running a non-default timeout
   * still gets a correct-by-construction gate. Two things must hold for that to
   * be safe, and neither is self-evident from reading one file.
   */
  it('derives the shallow.lock gate from the caller fetch ceiling, and mirrors it without drift', async () => {
    // (1) The mirrored ceiling cannot drift from the real one. storage.ts spells
    // the value out literally instead of importing it (fetch-transport already
    // imports storage, so importing back would close a module cycle) and its
    // comment promises THIS test as the drift guard.
    expect(FETCH_CEILING_MS_MIRROR).toBe(DEFAULT_FETCH_TIMEOUT_MS);

    // (2) An explicit override is actually honoured — a caller with a 10-min
    // ceiling must NOT have a 9-min-old lock (still plausibly live) pulled out
    // from under its in-flight fetch.
    const lockPath = join(repo, 'shallow.lock');
    const nineMin = new Date(Date.now() - 9 * 60_000);
    await writeFile(lockPath, 'deadbeef\n');
    await utimes(lockPath, nineMin, nineMin);

    const wide = await sweepStalePackTmpFiles(repo, { shallowLockMaxAgeMs: 10 * 60_000 });
    expect(wide.removed).not.toContain('shallow.lock');
    expect(await pathExists(lockPath)).toBe(true);

    const tight = await sweepStalePackTmpFiles(repo, { shallowLockMaxAgeMs: 60_000 });
    expect(tight.removed).toContain('shallow.lock');
    expect(await pathExists(lockPath)).toBe(false);
  });

  it('is a no-op — never a throw — on a repo with no pack directory at all', async () => {
    const res = await sweepStalePackTmpFiles(join(root, 'does-not-exist'));
    expect(res).toEqual({ removed: [], bytesReclaimed: 0 });
  });

  /**
   * WI-2141452, live-caught on the two-machine rig: a `git fetch` killed
   * mid-stream while writing `fetchPeerNamespace`'s wildcard refspec
   * (`+refs/namespaces/<hex>/*:refs/namespaces/<hex>/*`) can strand PER-REF
   * lock files nested under `refs/namespaces/<ns>/refs/**` — not just the
   * single root-level `shallow.lock` above. From then on EVERY fetch that
   * would touch that specific ref fails instantly with
   * "cannot lock ref … File exists", so these must be reclaimed too, and
   * kept namespace-distinct (two namespaces can each strand their own
   * `heads/staging.lock` with the identical basename — a basename-only sweep
   * would either miss one or misreport which namespace it came from).
   */
  it('clears STRANDED refs/namespaces/**/*.lock files, distinguishing namespaces, but leaves a live one alone', async () => {
    const nsA = 'aaaa1111';
    const nsB = 'bbbb2222';
    const lockA = join(repo, 'refs', 'namespaces', nsA, 'refs', 'heads', 'staging.lock');
    const lockB = join(repo, 'refs', 'namespaces', nsB, 'refs', 'heads', 'staging.lock');
    const liveLock = join(repo, 'refs', 'namespaces', nsA, 'refs', 'rad', 'sigrefs.lock');
    const write = async (p: string, ageMs: number): Promise<void> => {
      await mkdir(join(p, '..'), { recursive: true });
      await writeFile(p, 'deadbeef\n');
      const when = new Date(Date.now() - ageMs);
      await utimes(p, when, when);
    };

    await write(lockA, 60 * 60_000); // an hour dead
    await write(lockB, 60 * 60_000);
    await write(liveLock, 5_000); // a fetch may still be holding it

    const swept = await sweepStalePackTmpFiles(repo);

    expect(swept.removed).toContain(join('refs', 'namespaces', nsA, 'refs', 'heads', 'staging.lock'));
    expect(swept.removed).toContain(join('refs', 'namespaces', nsB, 'refs', 'heads', 'staging.lock'));
    expect(swept.removed).not.toContain(join('refs', 'namespaces', nsA, 'refs', 'rad', 'sigrefs.lock'));
    expect(await pathExists(lockA)).toBe(false);
    expect(await pathExists(lockB)).toBe(false);
    expect(await pathExists(liveLock)).toBe(true);
    await rm(join(repo, 'refs', 'namespaces'), { recursive: true, force: true });
  });

  it('never touches a refs/namespaces lock while a fetch is in flight on this repo, no matter how old', async () => {
    const lockPath = join(repo, 'refs', 'namespaces', 'ccccc333', 'refs', 'heads', 'work.lock');
    await mkdir(join(lockPath, '..'), { recursive: true });
    await writeFile(lockPath, 'deadbeef\n');
    const hourAgo = new Date(Date.now() - 60 * 60_000);
    await utimes(lockPath, hourAgo, hourAgo);

    const release = noteFetchInFlight(repo);
    try {
      const swept = await sweepStalePackTmpFiles(repo);
      expect(swept.removed).not.toContain(join('refs', 'namespaces', 'ccccc333', 'refs', 'heads', 'work.lock'));
      expect(await pathExists(lockPath)).toBe(true);
    } finally {
      release();
      await rm(join(repo, 'refs', 'namespaces'), { recursive: true, force: true });
    }
  });
});
