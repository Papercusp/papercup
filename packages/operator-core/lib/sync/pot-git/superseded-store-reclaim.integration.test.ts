/**
 * WI-10003689 recurrence guard: a pot-git store abandoned by a repoKey re-key is
 * reclaimed once it is idle past the grace period AND every tip it holds is already in
 * the live store, and is kept (with a reason) otherwise. Real temp bare repos, git on
 * PATH, no network.
 *
 * Measured 2026-09-28 on the Mac rig VM: `papercusp.git` (5.1G) sat beside the live
 * `gh-1223568103.git` for a day after the re-key and nothing would ever remove it.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SUPERSEDED_STORE_GRACE_MS,
  liveGcRepoKey,
  reclaimSupersededStores,
  supersededStoreCandidates,
} from './superseded-store-reclaim';

const cleanups: string[] = [];
afterAll(async () => {
  await Promise.all(cleanups.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});

const GIT = ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'init.defaultBranch=main'];
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', [...GIT, ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** The live repro: a joiner that adopted the owner's key; the bare slug is abandoned. */
const REKEYED = { slug: 'papercusp', pot_repo_key: 'gh-1223568103', pot_repo_key_source: 'peer' as const };

async function potFixture() {
  const root = await mkdtemp(join(tmpdir(), 'pot-git-reclaim-'));
  cleanups.push(root);
  const potDir = join(root, 'papercusp');
  await mkdir(potDir, { recursive: true });
  const repoPath = (_pot: string, key: string) => join(potDir, `${key}.git`);
  const work = join(root, 'work');
  await mkdir(work);
  git(work, 'init', '-q');
  const commit = async (msg: string) => {
    await writeFile(join(work, 'f.txt'), msg);
    git(work, 'add', 'f.txt');
    git(work, 'commit', '-q', '-m', msg);
    return git(work, 'rev-parse', 'HEAD');
  };
  const bare = (key: string) => {
    git(potDir, 'init', '-q', '--bare', `${key}.git`);
    return repoPath('papercusp', key);
  };
  const push = (store: string, ref: string) => git(work, 'push', '-q', store, `HEAD:${ref}`);
  return { potDir, repoPath, commit, bare, push };
}

const LATER = () => Date.now() + SUPERSEDED_STORE_GRACE_MS + 60_000;

describe('supersededStoreCandidates / liveGcRepoKey (pure)', () => {
  it('names the abandoned bare slug and maps a stale gc key to the live one', () => {
    expect(supersededStoreCandidates([REKEYED])).toEqual([
      { repoKey: 'papercusp', canonicalKey: 'gh-1223568103', entrySlug: 'papercusp' },
    ]);
    expect(liveGcRepoKey('papercusp', [REKEYED])).toBe('gh-1223568103');
    expect(liveGcRepoKey('gh-1223568103', [REKEYED])).toBe('gh-1223568103');
    expect(liveGcRepoKey('hive-canary', [REKEYED, { slug: 'hive-canary' }])).toBe('hive-canary');
  });

  it('never offers a key that is ANOTHER entry\'s live key', () => {
    // A member repo that is genuinely keyed 'papercusp' keeps its store, even though
    // 'papercusp' is also the home entry's abandoned alias. ('member' itself IS offered:
    // the member pinned off its own ladder, so its bare slug is ITS abandoned alias.)
    const member = { slug: 'member', pot_repo_key: 'papercusp' };
    expect(supersededStoreCandidates([REKEYED, member]).map((c) => c.repoKey)).toEqual(['member']);
    expect(liveGcRepoKey('papercusp', [REKEYED, member])).toBe('papercusp');
    expect(supersededStoreCandidates([{ slug: 'papercusp' }])).toEqual([]);
  });
});

describe('reclaimSupersededStores (real bare repos)', () => {
  it('reclaims an idle superseded store whose every tip is already in the live store', async () => {
    const f = await potFixture();
    const live = f.bare('gh-1223568103');
    const dead = f.bare('papercusp');
    await f.commit('one');
    f.push(dead, 'refs/namespaces/aa/refs/heads/main');
    f.push(live, 'refs/namespaces/aa/refs/heads/main');

    const out = await reclaimSupersededStores('papercusp', [REKEYED], { repoPath: f.repoPath, now: LATER });
    expect(out).toEqual([
      expect.objectContaining({ repoKey: 'papercusp', canonicalKey: 'gh-1223568103', action: 'reclaimed', reason: 'reclaimed' }),
    ]);
    expect(out[0].bytes).toBeGreaterThan(0);
    expect(existsSync(dead)).toBe(false);
    expect(existsSync(live)).toBe(true);
  });

  it('keeps a superseded store that holds a tip the live store lacks', async () => {
    const f = await potFixture();
    const live = f.bare('gh-1223568103');
    const dead = f.bare('papercusp');
    await f.commit('one');
    f.push(live, 'refs/heads/main');
    await f.commit('only-in-the-old-store');
    f.push(dead, 'refs/heads/main');

    const out = await reclaimSupersededStores('papercusp', [REKEYED], { repoPath: f.repoPath, now: LATER });
    expect(out).toEqual([expect.objectContaining({ action: 'retained', reason: 'tips-missing:1/1' })]);
    expect(existsSync(dead)).toBe(true);
  });

  it('keeps a superseded store written to within the grace period', async () => {
    const f = await potFixture();
    const live = f.bare('gh-1223568103');
    const dead = f.bare('papercusp');
    await f.commit('one');
    f.push(dead, 'refs/heads/main');
    f.push(live, 'refs/heads/main');

    const out = await reclaimSupersededStores('papercusp', [REKEYED], { repoPath: f.repoPath });
    expect(out).toEqual([expect.objectContaining({ action: 'retained', reason: 'within-grace' })]);
    expect(existsSync(dead)).toBe(true);
  });

  it('keeps a superseded store when the live store does not exist yet', async () => {
    const f = await potFixture();
    const dead = f.bare('papercusp');
    await f.commit('one');
    f.push(dead, 'refs/heads/main');

    const out = await reclaimSupersededStores('papercusp', [REKEYED], { repoPath: f.repoPath, now: LATER });
    expect(out).toEqual([expect.objectContaining({ action: 'retained', reason: 'canonical-store-missing' })]);
    expect(existsSync(dead)).toBe(true);
  });

  it('does nothing when there is no superseded store on disk', async () => {
    const f = await potFixture();
    f.bare('gh-1223568103');
    expect(await reclaimSupersededStores('papercusp', [REKEYED], { repoPath: f.repoPath, now: LATER })).toEqual([]);
  });
});
