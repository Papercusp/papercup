import { hiveEffectFixture } from './hive-effect-authority.fixture';
/**
 * integrator.integration.test.ts — G-5 staging integration against a REAL temp
 * bare repo (git on PATH, no network). Builds member namespaces with distinct
 * work lines and proves the merge-queue policy: first head seeds staging,
 * fast-forwards advance it, a clean divergence produces a real merge commit
 * (containing both parents), a conflicting divergence is SKIPPED + reported, and
 * a re-run with no new work is a no-op (idempotent).
 *
 * Run: cd packages/operator-core && npx vitest run --config vitest.integration.config.ts lib/sync/pot-git/integrator.integration.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import { defaultRunGit, ensurePotGitRepo, deviceNamespaceKey, writeNamespaceRef } from './storage';
import { WORK_REF, integrateMemberHeads as integrateMemberHeadsUnderTest, readStaging, collectMemberHeads } from './integrator';

function dev(): string {
  const { publicKey } = generateKeyPairSync('ed25519');
  const spki = (publicKey as KeyObject).export({ format: 'der', type: 'spki' }) as Buffer;
  return spki.subarray(spki.length - 32).toString('base64');
}

/** Write files → tree (via an isolated index) → commit (optionally on a parent)
 *  in the bare repo. Uses execFileSync with GIT_INDEX_FILE so each build gets a
 *  clean, private index. */
async function commit(repo: string, files: Record<string, string>, parent?: string): Promise<string> {
  const { execFileSync } = await import('node:child_process');
  const dir = await mkdtemp(join(tmpdir(), 'mk-'));
  try {
    const env = { ...process.env, GIT_INDEX_FILE: join(dir, 'index') };
    for (const [name, content] of Object.entries(files)) {
      const f = join(dir, 'blob');
      await writeFile(f, content, 'utf8');
      const sha = execFileSync('git', ['hash-object', '-w', f], { cwd: repo, encoding: 'utf8' }).trim();
      execFileSync('git', ['update-index', '--add', '--cacheinfo', `100644,${sha},${name}`], { cwd: repo, env });
    }
    const tree = execFileSync('git', ['write-tree'], { cwd: repo, env, encoding: 'utf8' }).trim();
    const args = ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit-tree', tree, '-m', 'c'];
    if (parent) args.push('-p', parent);
    const c = await defaultRunGit(args, repo);
    expect(c.code, c.stderr).toBe(0);
    return c.stdout.trim();
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function contains(repo: string, staging: string, sha: string): Promise<boolean> {
  const r = await defaultRunGit(['merge-base', '--is-ancestor', sha, staging], repo);
  return r.code === 0;
}

describe('pot-git integrator (real bare repo)', () => {
  let root: string;
  let repo: string;
  const integ = dev();
  const devA = dev();
  const devB = dev();
  const devC = dev();

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'integ-it-'));
    process.env.PAPERCUSP_HIVE_GIT_ROOT = root;
    repo = await ensurePotGitRepo('hive-i', 'repo-1');
  });
  afterAll(async () => {
    delete process.env.PAPERCUSP_HIVE_GIT_ROOT;
    await rm(root, { recursive: true, force: true });
  });

  it('seeds staging from the first head, then fast-forwards a descendant', async () => {
    const base = await commit(repo, { 'a.txt': 'a1' });
    const next = await commit(repo, { 'a.txt': 'a1', 'b.txt': 'b1' }, base);
    await writeNamespaceRef(repo, devA, WORK_REF, base);
    const r1 = await integrateMemberHeads(repo, integ, [{ deviceHex: deviceNamespaceKey(devA), sha: base }]);
    expect(r1.advanced).toBe(true);
    expect(r1.staging).toBe(base);
    // Advance A; re-integrate → fast-forward.
    await writeNamespaceRef(repo, devA, WORK_REF, next, defaultRunGit, base);
    const r2 = await integrateMemberHeads(repo, integ, [{ deviceHex: deviceNamespaceKey(devA), sha: next }]);
    expect(r2.advanced).toBe(true);
    expect(r2.staging).toBe(next);
    expect(await readStaging(repo, integ)).toBe(next);
  });

  it('re-integrating the same head-set is a no-op (idempotent)', async () => {
    const cur = await readStaging(repo, integ);
    const r = await integrateMemberHeads(repo, integ, [{ deviceHex: deviceNamespaceKey(devA), sha: cur! }]);
    expect(r.advanced).toBe(false);
    expect(r.staging).toBe(cur);
  });

  it('merges a clean divergence into a real merge commit containing both parents', async () => {
    // Self-contained on a FRESH integrator: two members fork a common root and
    // edit DIFFERENT files → a real 3-way merge (not unrelated histories).
    const integ2 = dev();
    const devA2 = dev();
    const devB2 = dev();
    const rootC = await commit(repo, { 'r.txt': 'r0' });
    const aHead = await commit(repo, { 'r.txt': 'r0', 'a2.txt': 'a2' }, rootC);
    const bHead = await commit(repo, { 'r.txt': 'r0', 'b2.txt': 'b2' }, rootC);
    await writeNamespaceRef(repo, devA2, WORK_REF, aHead);
    await writeNamespaceRef(repo, devB2, WORK_REF, bHead);
    const r = await integrateMemberHeads(repo, integ2, [
      { deviceHex: deviceNamespaceKey(devA2), sha: aHead },
      { deviceHex: deviceNamespaceKey(devB2), sha: bHead },
    ]);
    expect(r.advanced).toBe(true);
    expect(r.integrated).toEqual(expect.arrayContaining([deviceNamespaceKey(devA2), deviceNamespaceKey(devB2)]));
    expect(r.skippedConflicts).toEqual([]);
    // The new staging is a merge commit reachable from BOTH forks.
    expect(await contains(repo, r.staging!, aHead)).toBe(true);
    expect(await contains(repo, r.staging!, bHead)).toBe(true);
  });

  it('WI-10004249: folds the accepted staging floor back in when own-head publish rewound the base', async () => {
    // The incident shape: the integrator accepted S1 = merge(H0, M). Own-head
    // publish then overwrote ns/<integrator>/refs/heads/staging with the local
    // worktree head H1, which descends from H0 but never received S1. Without
    // the floor, the next staging is not a descendant of S1 → receivers reject
    // it as non-FF and canonical freezes.
    const integ3 = dev();
    const self = dev();
    const member = dev();
    const h0 = await commit(repo, { 's.txt': 's0' });
    const m1 = await commit(repo, { 's.txt': 's0', 'm.txt': 'm1' }, h0);
    await writeNamespaceRef(repo, self, WORK_REF, h0);
    const first = await integrateMemberHeads(repo, integ3, [
      { deviceHex: deviceNamespaceKey(self), sha: h0 },
      { deviceHex: deviceNamespaceKey(member), sha: m1 },
    ]);
    const accepted = first.staging!;
    expect(await contains(repo, accepted, m1)).toBe(true);

    const h1 = await commit(repo, { 's.txt': 's1' }, h0);
    // Own-head publish rewinds the integrator's staging ref to the local head.
    await writeNamespaceRef(repo, integ3, 'refs/heads/staging', h1, undefined, accepted);
    const heads = [
      { deviceHex: deviceNamespaceKey(self), sha: h1 },
      { deviceHex: deviceNamespaceKey(member), sha: m1 },
    ];

    // Control: without the floor the result is NOT a fast-forward of what was accepted.
    const noFloor = await integrateMemberHeads(repo, integ3, heads);
    expect(await contains(repo, noFloor.staging!, accepted)).toBe(false);
    expect(noFloor.floorRestored).toBe(false);

    await writeNamespaceRef(repo, integ3, 'refs/heads/staging', h1, undefined, noFloor.staging ?? undefined);
    const withFloor = await integrateMemberHeads(repo, integ3, heads, { floorSha: accepted });
    expect(withFloor.floorRestored).toBe(true);
    expect(withFloor.advanced).toBe(true);
    expect(await contains(repo, withFloor.staging!, accepted)).toBe(true);
    expect(await contains(repo, withFloor.staging!, h1)).toBe(true);
    expect(withFloor.skippedConflicts).toEqual([]);

    // Already containing the floor is a no-op for the floor leg.
    const again = await integrateMemberHeads(repo, integ3, heads, { floorSha: accepted });
    expect(again.floorRestored).toBe(false);
    expect(again.advanced).toBe(false);
  });

  it('skips + reports a conflicting head; other members still integrate', async () => {
    const staging = (await readStaging(repo, integ))!;
    // C conflicts on a.txt (staging has a.txt='a1'); D-like clean edit via devC? Use
    // devC as the conflicter and re-add A cleanly (already contained).
    const conflict = await commit(repo, { 'a.txt': 'DIFFERENT-a' });
    await writeNamespaceRef(repo, devC, WORK_REF, conflict);
    // A clean new member (reuse devA advanced with a non-conflicting file).
    const aHead = (await collectMemberHeads(repo, [devA]))[0].sha;
    const aClean = await commit(repo, { 'a.txt': 'a1', 'b.txt': 'b1', 'd.txt': 'd1' }, aHead);
    await writeNamespaceRef(repo, devA, WORK_REF, aClean, defaultRunGit, aHead);
    const r = await integrateMemberHeads(repo, integ, [
      { deviceHex: deviceNamespaceKey(devA), sha: aClean },
      { deviceHex: deviceNamespaceKey(devC), sha: conflict },
    ]);
    expect(r.skippedConflicts.some((s) => s.deviceHex === deviceNamespaceKey(devC))).toBe(true);
    expect(r.integrated).toContain(deviceNamespaceKey(devA));
    void staging;
  });

  it('collectMemberHeads reads work heads, skipping members with none', async () => {
    const noWork = dev();
    const heads = await collectMemberHeads(repo, [devA, noWork]);
    expect(heads.map((h) => h.deviceHex)).toContain(deviceNamespaceKey(devA));
    expect(heads.map((h) => h.deviceHex)).not.toContain(deviceNamespaceKey(noWork));
  });
});

/**
 * WI-10003731 — per-host escalation files committed into a shared pot repo made
 * every member head content-conflict with staging, so the integrator parked it
 * forever (P-505 physical drill 2026-09-28: tower staging vs VM head conflicted
 * on exactly `.papercusp/state/escalations/{github-bridge,origin-freshness-watchdog}.md`).
 * Each case gets its own repo so the staging lineage is exactly what it builds.
 */
describe('pot-git integrator — retired per-host state conflicts (WI-10003731)', () => {
  const ESC = '.papercusp/state/escalations';
  let root: string;
  let n = 0;
  const integ = dev();
  const tower = dev();
  const vm = dev();
  const hex = (d: string) => deviceNamespaceKey(d);

  async function freshRepo(): Promise<string> {
    n += 1;
    return ensurePotGitRepo('hive-hl', `repo-${n}`);
  }
  async function show(repo: string, rev: string, path: string): Promise<string | null> {
    const r = await defaultRunGit(['show', `${rev}:${path}`], repo);
    return r.code === 0 ? r.stdout : null;
  }

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'integ-hl-'));
    process.env.PAPERCUSP_HIVE_GIT_ROOT = root;
  });
  afterAll(async () => {
    delete process.env.PAPERCUSP_HIVE_GIT_ROOT;
    await rm(root, { recursive: true, force: true });
  });

  it('integrates a head whose ONLY conflicts are per-host state files, keeping staging\'s copy', async () => {
    const repo = await freshRepo();
    const base = await commit(repo, {
      'app.txt': 'v1',
      [`${ESC}/github-bridge.md`]: 'base verdict\n',
      [`${ESC}/origin-freshness-watchdog.md`]: 'base verdict\n',
    });
    const towerHead = await commit(repo, {
      'app.txt': 'v1',
      'tower.txt': 'tower work\n',
      [`${ESC}/github-bridge.md`]: 'tower verdict\n',
      [`${ESC}/origin-freshness-watchdog.md`]: 'tower verdict\n',
    }, base);
    const seeded = await integrateMemberHeads(repo, integ, [{ deviceHex: hex(tower), sha: towerHead }]);
    expect(seeded.staging).toBe(towerHead);

    const vmHead = await commit(repo, {
      'app.txt': 'v1',
      'vm-work.txt': 'real vm work\n',
      [`${ESC}/github-bridge.md`]: 'vm verdict\n',
      [`${ESC}/origin-freshness-watchdog.md`]: 'vm verdict\n',
    }, base);
    const r = await integrateMemberHeads(repo, integ, [{ deviceHex: hex(vm), sha: vmHead }]);

    expect(r.skippedConflicts).toEqual([]);
    expect(r.advanced).toBe(true);
    expect(r.integrated).toEqual([hex(vm)]);
    expect(r.resolvedHostLocalState).toHaveLength(1);
    expect(r.resolvedHostLocalState[0]).toMatchObject({ deviceHex: hex(vm), sha: vmHead });
    expect([...r.resolvedHostLocalState[0].paths].sort()).toEqual([
      `${ESC}/github-bridge.md`,
      `${ESC}/origin-freshness-watchdog.md`,
    ]);
    // Both lines are in staging; staging's per-host copy won; the member's real work landed.
    expect(await contains(repo, r.staging!, vmHead)).toBe(true);
    expect(await contains(repo, r.staging!, towerHead)).toBe(true);
    expect(await show(repo, r.staging!, `${ESC}/github-bridge.md`)).toBe('tower verdict\n');
    expect(await show(repo, r.staging!, `${ESC}/origin-freshness-watchdog.md`)).toBe('tower verdict\n');
    expect(await show(repo, r.staging!, 'vm-work.txt')).toBe('real vm work\n');
    expect(await show(repo, r.staging!, 'tower.txt')).toBe('tower work\n');
    expect(await readStaging(repo, integ)).toBe(r.staging);

    // Idempotent: the integrated head is now contained → a re-run is a no-op.
    const again = await integrateMemberHeads(repo, integ, [{ deviceHex: hex(vm), sha: vmHead }]);
    expect(again.advanced).toBe(false);
    expect(again.resolvedHostLocalState).toEqual([]);
  });

  it('still parks a head when a REAL file conflicts alongside per-host state, naming every path', async () => {
    const repo = await freshRepo();
    const base = await commit(repo, { 'app.txt': 'v1\n', [`${ESC}/git-sync.md`]: 'base\n' });
    const towerHead = await commit(repo, { 'app.txt': 'tower edit\n', [`${ESC}/git-sync.md`]: 'tower\n' }, base);
    await integrateMemberHeads(repo, integ, [{ deviceHex: hex(tower), sha: towerHead }]);
    const vmHead = await commit(repo, { 'app.txt': 'vm edit\n', [`${ESC}/git-sync.md`]: 'vm\n' }, base);

    const r = await integrateMemberHeads(repo, integ, [{ deviceHex: hex(vm), sha: vmHead }]);

    expect(r.advanced).toBe(false);
    expect(r.integrated).toEqual([]);
    expect(r.resolvedHostLocalState).toEqual([]);
    expect(r.skippedConflicts).toHaveLength(1);
    expect(r.skippedConflicts[0]).toMatchObject({ deviceHex: hex(vm), sha: vmHead });
    expect(r.skippedConflicts[0].error).toBeUndefined();
    expect([...r.skippedConflicts[0].paths].sort()).toEqual(['.papercusp/state/escalations/git-sync.md', 'app.txt']);
  });

  it('parks a modify/delete on a per-host state path (-X ours cannot resolve it) and reports the path', async () => {
    const repo = await freshRepo();
    const base = await commit(repo, { 'app.txt': 'v1\n', [`${ESC}/green-stall.md`]: 'base\n' });
    // Staging DELETED the escalation file; the member MODIFIED it.
    const towerHead = await commit(repo, { 'app.txt': 'v1\n', 'tower.txt': 't\n' }, base);
    await integrateMemberHeads(repo, integ, [{ deviceHex: hex(tower), sha: towerHead }]);
    const vmHead = await commit(repo, { 'app.txt': 'v1\n', [`${ESC}/green-stall.md`]: 'vm\n' }, base);

    const r = await integrateMemberHeads(repo, integ, [{ deviceHex: hex(vm), sha: vmHead }]);

    expect(r.advanced).toBe(false);
    expect(r.resolvedHostLocalState).toEqual([]);
    expect(r.skippedConflicts).toEqual([
      { deviceHex: hex(vm), sha: vmHead, paths: [`${ESC}/green-stall.md`] },
    ]);
  });
});

function integrateMemberHeads(...args: Parameters<typeof integrateMemberHeadsUnderTest>) {
  const [repo, device, heads, opts] = args;
  return integrateMemberHeadsUnderTest(repo, device, heads, { ...hiveEffectFixture(), ...opts });
}
