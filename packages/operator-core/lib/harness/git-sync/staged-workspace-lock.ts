import { dirname, join, relative, sep } from 'node:path';
import { realpath } from 'node:fs/promises';
import pLimit from 'p-limit';
import { assertRootLockManifestMatches } from '../../../../../scripts/npm-install-safe.mjs';
import { expandWorkspaces } from '../../../../../scripts/assert-workspace-links.mjs';
import type { RunGit } from './run-git-sync';

const manifests = new Set(['package.json', 'package-lock.json', 'npm-shrinkwrap.json']);
const isManifest = (path: string) => !path.split('/').includes('node_modules') && manifests.has(path.split('/').at(-1)!);

/** An immutable census: a child checkout supplies objects, never its current manifest. */
export function workspaceLockTreeValidator() {
  const trees = new Map<string, Promise<Map<string, string>>>();
  const limit = pLimit(8);
  return async (runGit: RunGit, repoPath: string, tree: string): Promise<void> => {
    const run = async (args: string[], cwd: string) => {
      const out = await limit(() => runGit(args, cwd));
      if (out.code !== 0) throw new Error(`dependency tree read failed (${args[0]}): ${out.stderr || out.stdout}`);
      return out.stdout;
    };
    // A repository without a root npm lock has no workspace mirror to audit.
    const locks = await run(['ls-tree', '-z', tree, '--', 'package-lock.json', 'npm-shrinkwrap.json'], repoPath);
    if (!locks.trim()) return;
    const collect = (source: string, ref: string): Promise<Map<string, string>> => {
      const key = `${source}\0${ref}`;
      let pending = trees.get(key);
      if (!pending) {
        pending = (async () => {
          const files = new Map<string, string>();
          const rows = (await run(['ls-tree', '-r', '-z', ref], source)).split('\0').filter(Boolean);
          await Promise.all(rows.map(async row => {
            const tab = row.indexOf('\t');
            const path = row.slice(tab + 1);
            const [mode, type, object] = row.slice(0, tab).split(' ');
            if (mode === '160000' && type === 'commit') {
              const child = join(source, path);
              // Missing submodules must not silently fall back to the enclosing repo.
              const top = (await run(['rev-parse', '--show-toplevel'], child)).trim();
              if (relative(await realpath(child), await realpath(top)) !== '') throw new Error(`unresolvable dependency gitlink ${path} @ ${object}`);
              for (const [name, text] of await collect(child, object!)) files.set(`${path}/${name}`, text);
            } else if (type === 'blob' && isManifest(path)) {
              files.set(path, await run(['cat-file', 'blob', object!], source));
            }
          }));
          return files;
        })();
        trees.set(key, pending);
        // Missing objects may become available on a later pass; never cache a failure.
        void pending.catch(() => trees.delete(key));
      }
      return pending;
    };
    const files = await collect(repoPath, tree);
    const name = (path: string) => relative(repoPath, path).split(sep).join('/');
    const directories = [...files.keys()].filter(path => path.endsWith('/package.json')).map(dirname);
    // The shared comparator formats JSON read failures as ordinary drift. Keep
    // the original error and its selected metadata population: fixture manifests
    // outside that population must not become new publication requirements.
    let metadataError: Error | undefined;
    try {
      assertRootLockManifestMatches(repoPath, {
        existsSync: (path: string) => files.has(name(path)),
        readJson: (path: string) => {
          try {
            return JSON.parse(files.get(name(path))!);
          } catch (error) {
            metadataError ??= new Error(`unreadable dependency metadata ${name(path)}: ${error}`);
            throw metadataError;
          }
        },
        expandWorkspaces: (patterns: string[], root: string) => expandWorkspaces(patterns, root, { directories }),
      });
    } catch (error) {
      throw metadataError ?? error;
    }
    if (metadataError) throw metadataError;
  };
}

/** Guard the exact private index, retaining unrelated staged source on a refusal. */
export async function guardStagedWorkspaceLock(
  runGit: RunGit,
  repoPath: string,
  validate = workspaceLockTreeValidator(),
): Promise<{ ok: true; held: string[]; heldProviders?: string[]; reason?: string } | { ok: false; error: string }> {
  const diff = await runGit(['diff', '--cached', '--raw', '--no-abbrev', '--no-renames', '-z', 'HEAD'], repoPath);
  if (diff.code !== 0) return { ok: false, error: `dependency index census failed: ${diff.stderr}` };
  const records = diff.stdout.split('\0');
  const dependencyPaths: string[] = [];
  const gitlinks: Array<{ path: string; ref: string }> = [];
  for (let i = 0; i + 1 < records.length; i += 2) {
    const path = records[i + 1]!;
    const modes = records[i]!.slice(1).split(' ').slice(0, 2);
    if (isManifest(path) || modes.includes('160000')) dependencyPaths.push(path);
    if (modes[1] === '160000') gitlinks.push({ path, ref: records[i]!.slice(1).split(' ')[3]! });
  }
  if (dependencyPaths.length === 0) return { ok: true, held: [] };
  const tree = await runGit(['write-tree'], repoPath);
  if (tree.code !== 0) return { ok: false, error: `dependency index tree failed: ${tree.stderr}` };
  try {
    await validate(runGit, repoPath, tree.stdout.trim());
    return { ok: true, held: [] };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    // Only a measured metadata disagreement supports deferral. Missing objects,
    // unreadable repositories and invalid JSON are unknown, not a safe old tree.
    if (!reason.startsWith('NPM_INSTALL_SAFE_WORKSPACE_LOCK_DRIFT:')) return { ok: false, error: reason };
    // The native importer guard matches files, not directory prefixes. Enumerate
    // the withheld gitlink's immutable source population, including nested pins,
    // so a named import cannot escape through a newer child checkout.
    const heldProviders: string[] = [];
    const collectProviders = async (source: string, ref: string, prefix: string): Promise<void> => {
      const rows = await runGit(['ls-tree', '-r', '-z', ref], source);
      if (rows.code !== 0) throw new Error(`held dependency source census failed: ${rows.stderr}`);
      for (const row of rows.stdout.split('\0').filter(Boolean)) {
        const tab = row.indexOf('\t');
        const path = row.slice(tab + 1);
        const [mode, type, object] = row.slice(0, tab).split(' ');
        if (mode === '160000' && type === 'commit') {
          await collectProviders(join(source, path), object!, `${prefix}/${path}`);
        } else if (type === 'blob' && (/\.(?:[cm]?[jt]sx?)$/i.test(path) || path === 'package.json')) {
          heldProviders.push(`${prefix}/${path}`);
        }
      }
    };
    try {
      for (const link of gitlinks) await collectProviders(join(repoPath, link.path), link.ref, link.path);
    } catch (censusError) {
      return { ok: false, error: `${censusError instanceof Error ? censusError.message : censusError}; ${reason}` };
    }
    // This runner is bound to the candidate's private index. Never edit the checkout.
    const reset = await runGit(['reset', '-q', 'HEAD', '--', ...dependencyPaths], repoPath);
    if (reset.code !== 0) return { ok: false, error: `dependency index hold failed: ${reset.stderr}; ${reason}` };
    const retainedTree = await runGit(['write-tree'], repoPath);
    if (retainedTree.code !== 0) return { ok: false, error: `retained dependency tree failed: ${retainedTree.stderr}` };
    try {
      await validate(runGit, repoPath, retainedTree.stdout.trim());
    } catch (retainedError) {
      return { ok: false, error: `dependency deferral did not restore a coherent tree: ${retainedError instanceof Error ? retainedError.message : retainedError}` };
    }
    return { ok: true, held: dependencyPaths, heldProviders, reason };
  }
}
