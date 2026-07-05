/**
 * seed-provider-git — the git SeedProvider (plan hive-seed-bundle-2026-07-04 P-004;
 * design memo agent-insights/hive-seed-bundle-design).
 *
 * Carries the CODE (the dogfood superproject + its submodules) as `git bundle`s —
 * git's native, content-addressed checkpoint. A fresh install clones from the
 * bundle OFFLINE (pre-positioning the history), re-points `origin` at GitHub, and
 * a subsequent `git fetch` transfers only the delta objects. Auth continues to
 * flow through the user's `gh` credential helper exactly as clone-github.ts
 * documents — this provider never touches tokens.
 *
 * The seed payload is a DIRECTORY holding: `super.bundle`, `submodules/<name>.bundle`
 * for each submodule, and `index.json` mapping bundles → repo-relative paths + origin
 * URLs. `verify` gates on a content hash (the deep git object verification happens
 * natively when `restore`'s clone rejects a corrupt bundle → the restore outcome
 * carries the reason and the host cold-paths git).
 *
 * NOTE: the walkFiles/hashDir/dirSize helpers mirror seed-provider-corestore.ts;
 * a future cleanup can lift them into a shared seed-fs util.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readdir, readFile, writeFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { createHash } from 'node:crypto';
import {
  sealBytes,
  openBytes,
  SEED_CIPHER,
  type SeedProvider,
  type SeedStoreEntry,
  type SeedCutContext,
  type SeedCutOutput,
  type SeedRestoreContext,
  type SeedPayload,
  type SeedKeyRef,
  type VerifyResult,
} from '@papercusp/seed-bundle';

export const GIT_SEED_KIND = 'git';

/** Max stdout for a git call (bundle listings etc. stay small; blobs go to files). */
const GIT_MAX_BUFFER = 64 * 1024 * 1024;

const execFileP = promisify(execFile);

/** Local-file submodule bundles require this on modern git (file protocol is
 *  disabled for submodules by default for security). We only ever point at
 *  bundle files we just wrote, so enabling it for these calls is safe. */
const ALLOW_FILE = ['-c', 'protocol.file.allow=always'];

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileP('git', args, { cwd, maxBuffer: GIT_MAX_BUFFER });
  return stdout.trim();
}

/** Context for {@link createGitSeedProvider}.cut (build/release time). */
export interface GitCutContext {
  /** The source working tree to cut from (the owner's checkout). */
  readonly sourceRepoDir: string;
  /** Directory the bundles are written into — becomes the payload. */
  readonly stagingDir: string;
  /** The canonical origin URL a restored clone should point at (e.g. the GitHub repo). */
  readonly originUrl: string;
  /** `git bundle create` revision selector; default `--all`. Pass `HEAD` (+ a
   *  configured `--depth` upstream) for a shallow seed (P-006 Q-1). */
  readonly rev?: string;
  /** Encrypt the bundle bytes at rest (required for a PRIVATE repo shipped in a
   *  public installer). The key is delivered to the joiner only post-admission
   *  (via `keyRef`); it is NEVER in the installer. */
  readonly encryption?: { readonly key: Uint8Array; readonly keyRef: SeedKeyRef };
}

/** Context for {@link createGitSeedProvider}.restore (first-boot time). */
export interface GitRestoreContext {
  /** The fresh install's target checkout dir (must not already exist). */
  readonly targetRepoDir: string;
  /** Override the origin URL recorded in the seed (else the seed's own). */
  readonly originUrl?: string;
  /** The decryption key (resolved post-admission). REQUIRED iff the seed was cut
   *  with encryption; restore throws if the seed is encrypted and this is absent. */
  readonly decryptionKey?: Uint8Array;
}

interface GitSeedSubmodule {
  readonly path: string;
  readonly url: string;
  readonly bundle: string;
}
interface GitSeedIndex {
  readonly super: string;
  readonly originUrl: string;
  readonly submodules: GitSeedSubmodule[];
  /** True ⇒ every bundle file is encrypted at rest (decrypt before clone). */
  readonly encrypted: boolean;
}

async function walkFiles(root: string, dir: string = root, acc: string[] = []): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) await walkFiles(root, full, acc);
    else if (e.isFile()) acc.push(relative(root, full));
  }
  return acc;
}

async function hashDir(root: string): Promise<string> {
  const h = createHash('sha256');
  const rels = (await walkFiles(root)).sort();
  for (const rel of rels) {
    h.update(rel + '\0');
    h.update(await readFile(join(root, rel)));
  }
  return h.digest('hex');
}

async function dirSize(root: string): Promise<number> {
  let total = 0;
  for (const rel of await walkFiles(root)) total += (await stat(join(root, rel))).size;
  return total;
}

/** Enumerate submodules from `.gitmodules` (path + url pairs).
 *  SKIPS any submodule whose working tree is not checked out (no `<path>/.git`):
 *  `.gitmodules` can declare a submodule the source tree never initialized — e.g. a
 *  RETIRED one (`libs/zero-harness`) — and blindly `git bundle`-ing in a nonexistent
 *  cwd throws `spawn git ENOENT`, aborting the whole cut. An uninitialized submodule
 *  simply isn't seeded (a fresh member cold-clones it); data-safe by construction. */
async function readSubmodules(repoDir: string): Promise<Array<{ name: string; path: string; url: string }>> {
  if (!existsSync(join(repoDir, '.gitmodules'))) return [];
  const pathLines = await git(repoDir, ['config', '-f', '.gitmodules', '--get-regexp', 'path']).catch(() => '');
  const out: Array<{ name: string; path: string; url: string }> = [];
  for (const line of pathLines.split('\n').filter(Boolean)) {
    const [key, p] = line.split(/\s+/);
    const name = key.slice('submodule.'.length, -'.path'.length);
    // A checked-out submodule has a `.git` gitlink (file) or dir at its path; an
    // uninitialized/retired one has a missing or empty dir → skip it (with a warning)
    // rather than spawn git in a cwd that doesn't exist.
    if (!existsSync(join(repoDir, p, '.git'))) {
      console.warn(`[seed:git] skipping submodule '${name}' (${p}) — not checked out in ${repoDir}; a fresh member will cold-clone it.`);
      continue;
    }
    const url = await git(repoDir, ['config', '-f', '.gitmodules', `submodule.${name}.url`]).catch(() => '');
    out.push({ name, path: p, url });
  }
  return out;
}

export function createGitSeedProvider(): SeedProvider {
  return {
    kind: GIT_SEED_KIND,

    async cut(ctx: SeedCutContext): Promise<SeedCutOutput> {
      const { sourceRepoDir, stagingDir, originUrl, rev, encryption } = ctx as unknown as GitCutContext;
      await mkdir(join(stagingDir, 'submodules'), { recursive: true });
      const revSel = rev ?? '--all';
      await git(sourceRepoDir, ['bundle', 'create', join(stagingDir, 'super.bundle'), revSel]);

      const submodules: GitSeedSubmodule[] = [];
      for (const sub of await readSubmodules(sourceRepoDir)) {
        const bundleRel = join('submodules', sub.name.replace(/[/\\]/g, '__') + '.bundle');
        await git(join(sourceRepoDir, sub.path), ['bundle', 'create', join(stagingDir, bundleRel), revSel]);
        submodules.push({ path: sub.path, url: sub.url, bundle: bundleRel });
      }

      // Encrypt every bundle file in place (the CODE is the secret). index.json
      // stays plaintext — it holds only bundle filenames + the public origin URL.
      const bundleRels = ['super.bundle', ...submodules.map((s) => s.bundle)];
      if (encryption) {
        for (const rel of bundleRels) {
          const p = join(stagingDir, rel);
          await writeFile(p, sealBytes(encryption.key, await readFile(p)));
        }
      }

      const index: GitSeedIndex = { super: 'super.bundle', originUrl, submodules, encrypted: Boolean(encryption) };
      await writeFile(join(stagingDir, 'index.json'), JSON.stringify(index, null, 2));

      const hash = await hashDir(stagingDir);
      const sizeBytes = await dirSize(stagingDir);
      const entry: SeedStoreEntry = {
        kind: GIT_SEED_KIND,
        hash,
        sizeBytes,
        source: { type: 'resource', path: stagingDir },
        ...(encryption ? { encryption: { scheme: SEED_CIPHER, keyRef: encryption.keyRef } } : {}),
        meta: { originUrl, submodulePaths: submodules.map((s) => s.path), encrypted: Boolean(encryption) },
      };
      return { entry, payload: { path: stagingDir } };
    },

    async verify(entry: SeedStoreEntry, payload: SeedPayload): Promise<VerifyResult> {
      const path = (payload as { path?: string })?.path;
      if (!path || !existsSync(path)) return { ok: false, reason: `payload path missing: ${String(path)}` };
      if (!existsSync(join(path, 'index.json')) || !existsSync(join(path, 'super.bundle'))) {
        return { ok: false, reason: 'seed missing index.json or super.bundle' };
      }
      const hash = await hashDir(path);
      if (hash !== entry.hash) {
        return { ok: false, reason: `hash mismatch (expected ${entry.hash.slice(0, 12)}…, got ${hash.slice(0, 12)}…)` };
      }
      return { ok: true };
    },

    async restore(entry: SeedStoreEntry, payload: SeedPayload, ctx: SeedRestoreContext): Promise<void> {
      const { targetRepoDir, originUrl: originOverride, decryptionKey } = ctx as unknown as GitRestoreContext;
      const seedPath = (payload as { path: string }).path;
      const index = JSON.parse(await readFile(join(seedPath, 'index.json'), 'utf8')) as GitSeedIndex;
      const origin = originOverride ?? index.originUrl;

      if (index.encrypted && !decryptionKey) {
        throw new Error('git seed is encrypted but no decryption key was provided (resolve it post-admission)');
      }

      // Decrypt a bundle to a plaintext temp path (or return it as-is when
      // unencrypted). git can only clone from a plaintext bundle.
      const materialize = async (bundleRel: string): Promise<string> => {
        const sealedPath = join(seedPath, bundleRel);
        if (!index.encrypted) return sealedPath;
        const plain = openBytes(decryptionKey!, await readFile(sealedPath));
        const outPath = join(seedPath, '.decrypted', bundleRel);
        await mkdir(dirname(outPath), { recursive: true });
        await writeFile(outPath, plain);
        return outPath;
      };

      // Clone the superproject from its bundle (offline), then re-point origin.
      await execFileP('git', [...ALLOW_FILE, 'clone', await materialize(index.super), targetRepoDir], {
        maxBuffer: GIT_MAX_BUFFER,
      });
      if (origin) await git(targetRepoDir, ['remote', 'set-url', 'origin', origin]);

      // Restore each submodule from its bundle into the submodule working path.
      for (const sub of index.submodules) {
        const subTarget = join(targetRepoDir, sub.path);
        await execFileP('git', [...ALLOW_FILE, 'clone', await materialize(sub.bundle), subTarget], {
          maxBuffer: GIT_MAX_BUFFER,
        });
        if (sub.url) await git(subTarget, ['remote', 'set-url', 'origin', sub.url]);
      }
    },
  };
}
