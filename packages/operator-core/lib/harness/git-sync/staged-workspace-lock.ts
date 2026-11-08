import { join, relative } from 'node:path';
import { realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import pLimit from 'p-limit';
import { inspectWorkspaceLockSnapshot, assertWorkspaceLockInspection } from '../../../../../scripts/npm-install-safe.mjs';
import type { RunGit } from './run-git-sync';

const manifests = new Set(['package.json', 'package-lock.json', 'npm-shrinkwrap.json']);
const isManifest = (path: string) => !path.split('/').includes('node_modules') && manifests.has(path.split('/').at(-1)!);

interface SelectedInput {
  kind: 'blob' | 'gitlink'; path: string; mode: string; oid: string;
  owner: string; selectedOid: string; gitmodules?: string; sha256?: string;
}
interface Census { files: Map<string, string>; inputs: SelectedInput[] }

/** Existing production reader, exposing its selected identity and typed diagnostics. */
export function workspaceLockTreeInspector() {
  const trees = new Map<string, Promise<Census>>();
  const limit = pLimit(8);
  return async (runGit: RunGit, repoPath: string, oid: string, kind: 'commit' | 'tree' = 'tree') => {
    const run = async (args: string[], cwd: string) => {
      const out = await limit(() => runGit(args, cwd));
      if (out.code !== 0) throw new Error(`dependency tree read failed (${args[0]}): ${out.stderr || out.stdout}`);
      return out.stdout;
    };
    const selectedOid = (await run(['rev-parse', '--verify', `${oid}^{object}`], repoPath)).trim();
    const type = (await run(['cat-file', '-t', selectedOid], repoPath)).trim();
    if (type !== kind) throw new Error(`selected object type mismatch: expected ${kind}, got ${type}`);
    const treeOid = (await run(['rev-parse', '--verify', `${selectedOid}^{tree}`], repoPath)).trim();
    const collect = (source: string, ref: string): Promise<Census> => {
      const key = `${source}\0${ref}`;
      let pending = trees.get(key);
      if (!pending) {
        pending = (async () => {
          const files = new Map<string, string>();
          const inputs: SelectedInput[] = [];
          const rows = (await run(['ls-tree', '-r', '-z', ref], source)).split('\0').filter(Boolean);
          const moduleRow = rows.find(row => row.slice(row.indexOf('\t') + 1) === '.gitmodules');
          const mapped = new Set<string>();
          if (moduleRow) {
            const blob = moduleRow.slice(0, moduleRow.indexOf('\t')).split(' ')[2]!;
            const config = await limit(() => runGit(['config', '--blob', blob, '--get-regexp', '^submodule\\..*\\.path$'], source));
            if (config.code !== 0 && config.code !== 1) throw new Error(`unreadable selected .gitmodules: ${config.stderr}`);
            for (const row of config.stdout.split('\n').filter(Boolean)) mapped.add(row.slice(row.indexOf(' ') + 1));
          }
          await Promise.all(rows.map(async row => {
            const tab = row.indexOf('\t');
            const path = row.slice(tab + 1);
            const [mode, type, object] = row.slice(0, tab).split(' ');
            if (mode === '160000' && type === 'commit') {
              if (!mapped.has(path)) throw new Error(`unmapped selected gitlink ${path} @ ${object}`);
              inputs.push({ kind: 'gitlink', path, mode, oid: object!, owner: '', selectedOid: ref, gitmodules: '.gitmodules' });
              const child = join(source, path);
              // Missing submodules must not silently fall back to the enclosing repo.
              const top = (await run(['rev-parse', '--show-toplevel'], child)).trim();
              if (relative(await realpath(child), await realpath(top)) !== '') throw new Error(`unresolvable dependency gitlink ${path} @ ${object}`);
              const nested = await collect(child, object!);
              for (const [name, text] of nested.files) files.set(`${path}/${name}`, text);
              inputs.push(...nested.inputs.map(input => ({ ...input, path: `${path}/${input.path}`,
                owner: `${path}/${input.owner}`, ...(input.gitmodules ? { gitmodules: `${path}/${input.gitmodules}` } : {}) })));
            } else if (type === 'blob' && (isManifest(path) || path === '.gitmodules')) {
              const text = await run(['cat-file', 'blob', object!], source);
              files.set(path, text);
              inputs.push({ kind: 'blob', path, mode: mode!, oid: object!, owner: '', selectedOid: ref,
                sha256: createHash('sha256').update(text).digest('hex') });
            }
          }));
          return { files, inputs };
        })();
        trees.set(key, pending);
        // Missing objects may become available on a later pass; never cache a failure.
        void pending.catch(() => trees.delete(key));
      }
      return pending;
    };
    const { files, inputs } = await collect(repoPath, selectedOid);
    return { selectedOid, treeOid, kind, ...inspectWorkspaceLockSnapshot(repoPath, files, inputs) };
  };
}

/** An immutable census: a child checkout supplies objects, never its current manifest. */
export function workspaceLockTreeValidator() {
  const inspect = workspaceLockTreeInspector();
  return async (runGit: RunGit, repoPath: string, tree: string): Promise<void> => {
    const locks = await runGit(['ls-tree', '-z', tree, '--', 'package-lock.json', 'npm-shrinkwrap.json'], repoPath);
    if (locks.code !== 0) throw new Error(`dependency tree read failed (ls-tree): ${locks.stderr}`);
    if (!locks.stdout.trim()) return;
    // This established assertion accepts commit-ish inputs too. The new explicit
    // inspector remains strict; validate the exact peeled tree for this wrapper.
    const peeled = await runGit(['rev-parse', '--verify', `${tree}^{tree}`], repoPath);
    if (peeled.code !== 0 || !peeled.stdout.trim()) throw new Error(`dependency tree read failed (peel): ${peeled.stderr}`);
    assertWorkspaceLockInspection(await inspect(runGit, repoPath, peeled.stdout.trim()));
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
