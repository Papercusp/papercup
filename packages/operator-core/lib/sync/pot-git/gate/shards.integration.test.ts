/**
 * shards.integration.test.ts — DG-2 (P-045) against a REAL temp git repo:
 * tree-based workspace discovery at a sha, and the inputsHash invariants —
 * deterministic; UNCHANGED across commits that don't touch a shard's inputs;
 * CHANGED when they do (own dir, a transitive dep dir, a root input file);
 * gitlink boundaries fall back to the submodule pointer OID.
 *
 * Run: cd packages/operator-core && npx vitest run --config vitest.integration.config.ts lib/sync/hive-git/gate/shards.integration.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultRunGit } from '../storage';
import {
  buildShardManifest,
  buildShardManifestAtSha,
  discoverWorkspacesAtSha,
  shardInputsHash,
  shardId,
} from './shards';

async function git(repo: string, ...args: string[]): Promise<string> {
  const r = await defaultRunGit(['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], repo);
  expect(r.code, `git ${args.join(' ')}: ${r.stderr}`).toBe(0);
  return r.stdout.trim();
}

async function commitAll(repo: string, msg: string): Promise<string> {
  await git(repo, 'add', '-A');
  await git(repo, 'commit', '-q', '-m', msg, '--allow-empty');
  return git(repo, 'rev-parse', 'HEAD');
}

function pkgJson(name: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ name, version: '0.0.0', ...extra }, null, 2);
}

describe('gate shards (real git repo)', () => {
  let repo: string;
  let sha1: string;

  beforeAll(async () => {
    repo = await mkdtemp(join(tmpdir(), 'gate-shards-'));
    await git(repo, 'init', '-q');
    // root: two workspace patterns + one explicit dir
    await writeFile(
      join(repo, 'package.json'),
      pkgJson('root', { workspaces: ['pkgs/*', 'libs/c'] }),
    );
    await writeFile(join(repo, 'package-lock.json'), '{"lockfileVersion":3}\n');
    await mkdir(join(repo, 'pkgs/a/src'), { recursive: true });
    await mkdir(join(repo, 'pkgs/b'), { recursive: true });
    await mkdir(join(repo, 'libs/c'), { recursive: true });
    await mkdir(join(repo, 'pkgs/not-a-ws'), { recursive: true });
    await writeFile(
      join(repo, 'pkgs/a/package.json'),
      pkgJson('@t/a', {
        dependencies: { '@t/b': '*', 'left-pad': '1.0.0' },
        scripts: { test: 'vitest run', 'test:integration': 'vitest run --config i.ts' },
      }),
    );
    await writeFile(join(repo, 'pkgs/a/src/index.ts'), 'export const a = 1;\n');
    await writeFile(
      join(repo, 'pkgs/b/package.json'),
      pkgJson('@t/b', { dependencies: { '@t/c': '*' }, scripts: { test: 'vitest run' } }),
    );
    await writeFile(join(repo, 'pkgs/b/b.ts'), 'export const b = 1;\n');
    await writeFile(
      join(repo, 'libs/c/package.json'),
      pkgJson('@t/c', { scripts: { test: 'vitest run' } }),
    );
    await writeFile(join(repo, 'libs/c/c.ts'), 'export const c = 1;\n');
    // a dir under the pattern with NO package.json — must not become a workspace
    await writeFile(join(repo, 'pkgs/not-a-ws/readme.md'), 'nope\n');
    sha1 = await commitAll(repo, 'base');
  });

  afterAll(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it('discovers workspaces from the COMMITTED tree, expanding patterns + explicit dirs', async () => {
    const { workspaces, unreadableWorkspaces } = await discoverWorkspacesAtSha(repo, sha1);
    expect(workspaces.map((w) => w.name).sort()).toEqual(['@t/a', '@t/b', '@t/c']);
    expect(unreadableWorkspaces).toEqual([]);
    const a = workspaces.find((w) => w.name === '@t/a')!;
    expect(a.dir).toBe('pkgs/a');
    expect(a.hasUnit).toBe(true);
    expect(a.hasIntegration).toBe(true);
    expect(a.deps).toContain('@t/b');
  });

  it('manifest at sha: shards + closure; inputsHash is deterministic', async () => {
    const { manifest, inputsHashByShardId } = await buildShardManifestAtSha(repo, sha1);
    expect(manifest.shards.map((s) => s.shardId)).toEqual([
      shardId('@t/a', 'integration'),
      shardId('@t/a', 'unit'),
      shardId('@t/b', 'unit'),
      shardId('@t/c', 'unit'),
    ]);
    const aUnit = manifest.shards.find((s) => s.shardId === shardId('@t/a', 'unit'))!;
    expect(aUnit.inputDirs).toEqual(['libs/c', 'pkgs/a', 'pkgs/b']);
    // recompute → identical (pure function of (sha, shard))
    for (const s of manifest.shards) {
      expect(await shardInputsHash(repo, sha1, s)).toBe(inputsHashByShardId[s.shardId]);
      expect(inputsHashByShardId[s.shardId]).toMatch(/^[0-9a-f]{64}$/);
    }
    // distinct shards hash distinctly (domain includes shardId)
    expect(new Set(Object.values(inputsHashByShardId)).size).toBe(manifest.shards.length);
  });

  it('inputsHash changes IFF a shard input changes (the incremental-gate invariant)', async () => {
    const { manifest, inputsHashByShardId: at1 } = await buildShardManifestAtSha(repo, sha1);
    const byId = (id: string) => manifest.shards.find((s) => s.shardId === id)!;
    const aU = byId(shardId('@t/a', 'unit'));
    const bU = byId(shardId('@t/b', 'unit'));
    const cU = byId(shardId('@t/c', 'unit'));

    // (1) touch a file OUTSIDE every workspace → NO shard hash changes
    await writeFile(join(repo, 'UNRELATED.md'), 'docs only\n');
    const sha2 = await commitAll(repo, 'unrelated');
    for (const s of [aU, bU, cU]) {
      expect(await shardInputsHash(repo, sha2, s)).toBe(at1[s.shardId]);
    }

    // (2) touch libs/c → c changes, b changes (b→c), a changes (a→b→c)
    await writeFile(join(repo, 'libs/c/c.ts'), 'export const c = 2;\n');
    const sha3 = await commitAll(repo, 'c change');
    expect(await shardInputsHash(repo, sha3, cU)).not.toBe(at1[cU.shardId]);
    expect(await shardInputsHash(repo, sha3, bU)).not.toBe(at1[bU.shardId]);
    expect(await shardInputsHash(repo, sha3, aU)).not.toBe(at1[aU.shardId]);

    // (3) touch pkgs/a only → a changes; b and c KEEP their sha3 hashes
    const at3 = {
      b: await shardInputsHash(repo, sha3, bU),
      c: await shardInputsHash(repo, sha3, cU),
      a: await shardInputsHash(repo, sha3, aU),
    };
    await writeFile(join(repo, 'pkgs/a/src/index.ts'), 'export const a = 2;\n');
    const sha4 = await commitAll(repo, 'a change');
    expect(await shardInputsHash(repo, sha4, aU)).not.toBe(at3.a);
    expect(await shardInputsHash(repo, sha4, bU)).toBe(at3.b);
    expect(await shardInputsHash(repo, sha4, cU)).toBe(at3.c);

    // (4) root lockfile change → EVERY shard changes (external dep pins moved)
    await writeFile(join(repo, 'package-lock.json'), '{"lockfileVersion":3,"x":1}\n');
    const sha5 = await commitAll(repo, 'lockfile');
    expect(await shardInputsHash(repo, sha5, aU)).not.toBe(await shardInputsHash(repo, sha4, aU));
    expect(await shardInputsHash(repo, sha5, bU)).not.toBe(await shardInputsHash(repo, sha4, bU));
    expect(await shardInputsHash(repo, sha5, cU)).not.toBe(await shardInputsHash(repo, sha4, cU));
  });

  it('same trees ⇒ same inputsHash across DIFFERENT shas (verdict reuse across staging advances)', async () => {
    const head = await git(repo, 'rev-parse', 'HEAD');
    const { manifest } = await buildShardManifestAtSha(repo, head);
    const cU = manifest.shards.find((s) => s.shardId === shardId('@t/c', 'unit'))!;
    const before = await shardInputsHash(repo, head, cU);
    const empty = await commitAll(repo, 'empty advance'); // new sha, identical tree
    expect(empty).not.toBe(head);
    expect(await shardInputsHash(repo, empty, cU)).toBe(before);
  });

  it('a gitlink boundary falls back to the submodule pointer OID (change-complete, loud discovery)', async () => {
    // Fabricate a gitlink without a real submodule: point it at an existing
    // commit oid. Capture TWO DISTINCT commits up front (the pointer move
    // below must actually change the index).
    const target = await git(repo, 'rev-parse', 'HEAD');
    const other = await git(repo, 'rev-parse', 'HEAD~1');
    expect(other).not.toBe(target);
    await git(repo, 'update-index', '--add', '--cacheinfo', `160000,${target},pkgs/sub`);
    await git(repo, 'commit', '-q', '-m', 'add gitlink');
    const shaG = await git(repo, 'rev-parse', 'HEAD');

    // Discovery reports the gitlink workspace as unreadable — not silently dropped.
    const { unreadableWorkspaces } = await discoverWorkspacesAtSha(repo, shaG);
    expect(unreadableWorkspaces.length).toBe(1);
    expect(unreadableWorkspaces[0].dir).toBe('pkgs/sub');
    expect(unreadableWorkspaces[0].reason).toContain(target);

    // A shard whose input dir is INSIDE the gitlink hashes via the pointer OID:
    const fake = { shardId: 'fake::unit', inputDirs: ['pkgs/sub/inner'] };
    const h1 = await shardInputsHash(repo, shaG, fake);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
    // Move the gitlink pointer → the hash changes.
    await git(repo, 'update-index', '--add', '--cacheinfo', `160000,${other},pkgs/sub`);
    await git(repo, 'commit', '-q', '-m', 'move gitlink');
    const shaG2 = await git(repo, 'rev-parse', 'HEAD');
    const h2 = await shardInputsHash(repo, shaG2, fake);
    expect(h2).not.toBe(h1);
  });

  it('an ABSENT input dir hashes as absent and its appearance changes the hash', async () => {
    const head = await git(repo, 'rev-parse', 'HEAD');
    const ghost = { shardId: 'ghost::unit', inputDirs: ['pkgs/ghost'] };
    const before = await shardInputsHash(repo, head, ghost);
    await mkdir(join(repo, 'pkgs/ghost'), { recursive: true });
    await writeFile(join(repo, 'pkgs/ghost/package.json'), pkgJson('@t/ghost'));
    const after = await shardInputsHash(repo, await commitAll(repo, 'ghost appears'), ghost);
    expect(after).not.toBe(before);
  });

  it('pure manifest from discovered metas equals the buildShardManifestAtSha manifest', async () => {
    const { workspaces, unreadableWorkspaces } = await discoverWorkspacesAtSha(repo, sha1);
    const viaPure = buildShardManifest(workspaces, { unreadableWorkspaces });
    const { manifest } = await buildShardManifestAtSha(repo, sha1);
    expect(JSON.stringify(viaPure)).toBe(JSON.stringify(manifest));
  });
});
