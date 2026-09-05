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

function integrateMemberHeads(...args: Parameters<typeof integrateMemberHeadsUnderTest>) {
  const [repo, device, heads, opts] = args;
  return integrateMemberHeadsUnderTest(repo, device, heads, { ...hiveEffectFixture(), ...opts });
}
