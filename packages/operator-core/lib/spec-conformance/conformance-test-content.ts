/** Immutable Git inputs, judged by the SAME closure policy as passing-task reuse. */
import { createHash } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, matchesGlob, relative, resolve } from 'node:path';
import {
  passingTaskVerdictDependencyProvenance,
  passingTaskVerdictSharedInputProvenance,
  type ResolvedDependencyClosureProof,
} from '../../../../scripts/lib/passing-task-verdict-cache.mjs';
import { STANDALONE_PACKAGE_DIRS } from '../../../../scripts/lib/test-runner-classes.mjs';
import { nextForkSlot, runGitBatch } from '../git-batch';
import { execFileViaSidecar } from '../fleet/git-via-sidecar';
import { getBuildInfo } from '../build-info';
import { measureBootOperatorArtifact, operatorArtifactSource } from '../release/operator-artifact';
import * as moduleRepository from '../module-repo-root';

const SHA = /^[a-f0-9]{7,40}$/i;
const FULL_SHA = /^[a-f0-9]{40}$/i;
const GIT_ENV_TO_CLEAR = [
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_COMMON_DIR',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
] as const;
type Repository = { cwd: string; gitDir?: string };
type Entry = { repo: Repository; oid: string; mode: string; type: string };
type ContentCache = {
  trees: Map<string, Promise<Buffer>>;
  submodules: Map<string, Promise<Repository>>;
  blobs: Map<string, string>;
  blobLoads: Promise<void>;
};
type Snapshot = {
  files: Map<string, Entry>; texts: Map<string, string>; unscanned: string[];
  cache: ContentCache;
  inputs?: Promise<DependencyInputs>;
  proofs: Map<string, Promise<ResolvedDependencyClosureProof>>;
};
type DependencyInputs = {
  workspaces: Map<string, { dir: string; deps: string[] }>;
  trackedScan: { files: string[]; unscannedPresent: string[] };
  shared: ReturnType<typeof passingTaskVerdictSharedInputProvenance>;
};
export type TestContentEquivalence = (input: {
  file: string; recordedSha: string; currentSha: string;
}) => Promise<{ equivalent: boolean; reason: string }>;

function immutableGitEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_NO_REPLACE_OBJECTS: '1' };
  for (const key of GIT_ENV_TO_CLEAR) delete env[key];
  return env;
}

async function git(repo: Repository, args: string[]): Promise<Buffer> {
  await nextForkSlot();
  // Yield between fallback forks, and use the maintained small-process route
  // on serving hosts. Traversing immutable submodule pins must not repeatedly
  // copy the background host's page tables just to read Git metadata.
  const result = await execFileViaSidecar('git', ['--no-replace-objects',
    ...(repo.gitDir ? ['--git-dir', repo.gitDir, '--work-tree', repo.cwd] : []), ...args], {
    cwd: repo.cwd, timeoutMs: 15_000, maxBuffer: 64 * 1024 * 1024,
    env: immutableGitEnvironment(), subsystem: 'conformance-test-content',
  });
  return Buffer.from(result.stdout, 'utf8');
}

async function submoduleRepository(root: string, parent: Repository, ref: string,
  local: string, path: string, oid: string): Promise<Repository> {
  const candidates = new Set<string>();
  const checkout = resolve(root, path);
  try {
    // Check the marker first: rev-parse alone could climb to the superproject.
    await lstat(resolve(checkout, '.git'));
    candidates.add((await git({ cwd: checkout }, ['rev-parse', '--absolute-git-dir'])).toString().trim());
  } catch { /* An archive may retain only the absorbed object database. */ }
  const common = (await git(parent, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).toString().trim();
  try {
    const config = await git(parent, ['config', '--null', '--blob', ref + ':.gitmodules',
      '--get-regexp', '^submodule\\..*\\.path$']);
    for (const entry of config.toString('utf8').split('\0').filter(Boolean)) {
      const split = entry.indexOf('\n');
      const key = entry.slice(0, split);
      const name = key.slice('submodule.'.length, -'.path'.length);
      if (split >= 0 && entry.slice(split + 1) === local && name
        && !isAbsolute(name) && !name.split('/').includes('..')) {
        candidates.add(resolve(common, 'modules', name));
      }
    }
  } catch { /* Missing metadata does not establish that the pinned object exists. */ }
  candidates.add(resolve(common, 'modules', local));
  for (const gitDir of candidates) {
    const repo = { cwd: root, gitDir };
    try {
      // Discover storage from disk; read source only from the requested pin.
      await git(repo, ['cat-file', '-e', oid + '^{commit}']);
      return repo;
    } catch { /* Try another existing layout, never the submodule's moving HEAD. */ }
  }
  throw new Error('pinned submodule object unavailable: ' + path);
}

async function snapshot(root: string, sha: string, cache: ContentCache): Promise<Snapshot> {
  const result: Snapshot = { files: new Map(), texts: new Map(), unscanned: [], cache, proofs: new Map() };
  const walk = async (repo: Repository, ref: string, prefix: string) => {
    const key = JSON.stringify([repo.cwd, repo.gitDir, ref]);
    if (!cache.trees.has(key)) cache.trees.set(key, git(repo, ['ls-tree', '-rz', '--full-tree', ref]));
    const tree = await cache.trees.get(key)!;
    for (const record of tree.toString('utf8').split('\0').filter(Boolean)) {
      const tab = record.indexOf('\t');
      const [mode, type, oid] = record.slice(0, tab).split(' ');
      const local = record.slice(tab + 1);
      if (tab < 0 || !oid || !mode || !type || local.startsWith('/') || local.split('/').includes('..')) {
        throw new Error('invalid Git tree entry');
      }
      const path = prefix + local;
      result.files.set(path, { repo, oid, mode, type });
      if (type !== 'commit') continue;
      // Release archives have no submodule .git. Read its existing object database;
      // never checkout, update, or read the submodule's moving HEAD as source.
      try {
        const childKey = JSON.stringify([repo.cwd, repo.gitDir, path, oid]);
        if (!cache.submodules.has(childKey)) {
          cache.submodules.set(childKey, submoduleRepository(root, repo, ref, local, path, oid));
        }
        const child = await cache.submodules.get(childKey)!;
        await walk(child, oid, path + '/');
        result.files.delete(path);
      } catch {
        result.unscanned.push(path);
      }
    }
  };
  await walk({ cwd: root }, sha, '');
  return result;
}

async function loadTexts(view: Snapshot, files: readonly string[]): Promise<void> {
  // Different commits often share most blobs. Serialize cache fills across the
  // request so concurrent snapshots also read each immutable object only once.
  const { cache } = view;
  const objectKey = (entry: Entry) => JSON.stringify([entry.repo.cwd, entry.repo.gitDir, entry.oid]);
  const load = cache.blobLoads.then(async () => {
    const missing = [...new Set(files)].filter(file => !view.texts.has(file));
    const uncached = new Map<string, { file: string; entry: Entry }>();
    for (const file of missing) {
      const entry = view.files.get(file);
      if (!entry || entry.type !== 'blob' || entry.mode === '120000') throw new Error('unreadable input: ' + file);
      if (!cache.blobs.has(objectKey(entry))) uncached.set(objectKey(entry), { file, entry });
    }
    const objects = [...uncached];
    for (let offset = 0; offset < objects.length; offset += 64) {
      const batch = objects.slice(offset, offset + 64);
      const commands = batch.map(([, { entry }]) => {
        return {
          repo: entry.repo.cwd,
          args: ['--no-replace-objects',
            ...(entry.repo.gitDir ? ['--git-dir', entry.repo.gitDir, '--work-tree', entry.repo.cwd] : []),
            'cat-file', 'blob', entry.oid],
        };
      });
      const results = await runGitBatch(commands, {
        label: 'conformance-test-content', timeoutMs: 15_000, maxBuffer: 64 * 1024 * 1024,
        env: immutableGitEnvironment(),
      });
      for (let index = 0; index < batch.length; index++) {
        const result = results[index];
        const [key, { file }] = batch[index]!;
        if (!result || result.code !== 0) throw new Error('unreadable input: ' + file);
        cache.blobs.set(key, result.stdout);
      }
    }
    for (const file of missing) view.texts.set(file, cache.blobs.get(objectKey(view.files.get(file)!))!);
  });
  // A failed read still rejects its caller; it must not poison later queued reads.
  cache.blobLoads = load.catch(() => {});
  await load;
}

async function dependencyInputs(view: Snapshot): Promise<DependencyInputs> {
  const root = '/conformance-git-inputs';
  if (view.unscanned.length) throw new Error('Git dependency enumeration incomplete: ' + view.unscanned[0]);
  await loadTexts(view, ['package.json']);
  const pkg = JSON.parse(view.texts.get('package.json')!);
  if (!Array.isArray(pkg.workspaces)) throw new Error('workspace enumeration unavailable');
  const patterns: string[] = pkg.workspaces;
  const dirs = [...view.files.keys()].filter(path => path.endsWith('/package.json')).map(path => path.slice(0, -13))
    .filter(dir => STANDALONE_PACKAGE_DIRS.includes(dir)
      || (patterns.some(pattern => !pattern.startsWith('!') && matchesGlob(dir, pattern))
        && !patterns.some(pattern => pattern.startsWith('!') && matchesGlob(dir, pattern.slice(1)))));
  await loadTexts(view, dirs.map(dir => dir + '/package.json'));
  const workspaces = new Map<string, { dir: string; deps: string[] }>();
  for (const dir of dirs) {
    const manifest = JSON.parse(view.texts.get(dir + '/package.json')!);
    if (typeof manifest.name !== 'string' || workspaces.has(manifest.name)) throw new Error('ambiguous workspace identity');
    workspaces.set(manifest.name, { dir, deps: Object.keys({
      ...manifest.dependencies, ...manifest.devDependencies, ...manifest.peerDependencies,
    }) });
  }
  const trackedScan = { files: [...view.files.keys()], unscannedPresent: view.unscanned };
  const requested = new Set<string>();
  const fs = {
    list: (dir: string) => trackedScan.files.map(path => resolve(root, path)).filter(path => path.startsWith(dir + '/')),
    exists: (path: string) => view.files.has(relative(root, path)),
    read: (path: string) => {
      const rel = relative(root, path);
      if (view.texts.has(rel)) return view.texts.get(rel)!;
      if (view.files.has(rel)) requested.add(rel);
      return null;
    },
  };
  let shared;
  // Resolve only the canonical shared import graph, in batches. A graph hole
  // remains a refusal; it never becomes a smaller successful closure.
  for (;;) {
    requested.clear();
    shared = passingTaskVerdictSharedInputProvenance({ root, trackedScan, fs });
    if (requested.size === 0) break;
    await loadTexts(view, [...requested]);
  }
  return { workspaces, trackedScan, shared };
}

async function dependencyProof(view: Snapshot, file: string): Promise<ResolvedDependencyClosureProof> {
  const { workspaces, trackedScan, shared } = await (view.inputs ??= dependencyInputs(view));
  const owner = [...workspaces].filter(([, ws]) => file.startsWith(ws.dir + '/'))
    .sort((a, b) => b[1].dir.length - a[1].dir.length)[0];
  // File existence is checked even when another test warmed the workspace proof.
  if (!owner || !view.files.has(file)) throw new Error('test workspace unavailable: ' + file);
  const workspaceName = owner[0];
  if (!view.proofs.has(workspaceName)) {
    // The canonical task binds the whole workspace closure, not one test file.
    // Share both pending work and refusals within this immutable snapshot only.
    view.proofs.set(workspaceName, Promise.resolve().then(() => {
      const hashFiles = ({ files, unavailable = [] }: { files: string[]; unavailable?: string[] }) => {
        if (unavailable.length) return { ok: false as const, reason: 'unscanned dependency: ' + unavailable[0] };
        const paths = [...new Set(files)].sort();
        const hash = createHash('sha256');
        for (const path of paths) {
          const entry = view.files.get(path);
          if (!entry || entry.type !== 'blob') return { ok: false as const, reason: 'unreadable dependency: ' + path };
          hash.update(JSON.stringify([path, entry.mode, entry.oid]) + '\0');
        }
        return { ok: true as const, hash: hash.digest('hex'), listHash: createHash('sha256').update(JSON.stringify(paths)).digest('hex'),
          fileCount: paths.length, files: paths };
      };
      const proof = passingTaskVerdictDependencyProvenance({
        root: '/conformance-git-inputs', taskKey: workspaceName + ' :: test', script: 'test', workspaceName, workspaces,
        trackedScan, repoWideTaskKeys: new Set(), sharedInputProvenance: shared, hashFiles,
      });
      if (!proof.ok) throw new Error(proof.reason);
      return proof.semantic;
    }));
  }
  return view.proofs.get(workspaceName)!;
}

type ResolvedRepository = { root: string; sourceSha?: string };

async function resolveRepository(rootOverride?: string): Promise<ResolvedRepository> {
  if (rootOverride !== undefined) return { root: rootOverride };
  const moduleRoot = moduleRepository.moduleRepoRoot(import.meta.url);
  if (existsSync(resolve(moduleRoot, '.git'))) return { root: moduleRoot };

  const candidate = process.env.PAPERCUSP_INTEGRATION_ROOT;
  const entry = process.argv[1];
  if (!candidate || !entry) throw new Error('External conformance Git source is not qualified');
  const bundlePath = realpathSync(entry);
  if (basename(bundlePath) !== 'hono-host.mjs') throw new Error('External conformance entry is not the maintained host bundle');
  const artifact = measureBootOperatorArtifact(bundlePath, getBuildInfo().sha);
  if (artifact.status !== 'measured') throw new Error('External conformance bundle is unqualified: ' + artifact.reason);

  const sourceRoot = realpathSync(candidate);
  const gitTopLevel = realpathSync((await git({ cwd: sourceRoot }, ['rev-parse', '--show-toplevel'])).toString('utf8').trim());
  if (gitTopLevel !== sourceRoot) throw new Error('External conformance source root is not a Git repository root');
  const sourceSha = await operatorArtifactSource(sourceRoot, async (cwd, args) =>
    (await git({ cwd }, args)).toString('utf8').trim());
  if (!FULL_SHA.test(sourceSha) || sourceSha !== artifact.sourceSha) {
    throw new Error('External conformance source does not match the boot-qualified artifact');
  }
  return { root: sourceRoot, sourceSha };
}

/** Request-scoped caches: no mutable working-tree observation or synthetic receipt. */
function createContentComparator(repositoryRoot: string, qualifiedCurrentSha: string | null): TestContentEquivalence {
  const snapshots = new Map<string, Promise<Snapshot>>();
  const cache: ContentCache = { trees: new Map(), submodules: new Map(), blobs: new Map(), blobLoads: Promise.resolve() };
  const testEntries = new Map<string, Promise<string | null>>();
  const testEntry = (sha: string, file: string) => {
    const key = JSON.stringify([sha, file]);
    if (!testEntries.has(key)) testEntries.set(key, (async () => {
      try {
        const records = (await git({ cwd: repositoryRoot }, ['ls-tree', '-z', '--full-tree', sha, '--', file]))
          .toString('utf8').split('\0').filter(Boolean);
        if (records.length !== 1) return null;
        const tab = records[0]!.indexOf('\t');
        const identity = records[0]!.slice(0, tab);
        return tab >= 0 && records[0]!.slice(tab + 1) === file && /^100(?:644|755) blob [a-f0-9]{40}$/.test(identity)
          ? identity : null;
      } catch { return null; /* Unknown or submodule paths still require the full proof below. */ }
    })());
    return testEntries.get(key)!;
  };
  const patterns = new Map<string, Promise<string[]>>();
  const workspace = async (sha: string, file: string) => {
    if (!patterns.has(sha)) patterns.set(sha, (async () => {
      const manifest = JSON.parse((await git({ cwd: repositoryRoot }, ['show', sha + ':package.json'])).toString('utf8'));
      if (!Array.isArray(manifest.workspaces) || manifest.workspaces.some((value: unknown) => typeof value !== 'string')) {
        throw new Error('workspace enumeration unavailable');
      }
      return manifest.workspaces as string[];
    })());
    const globs = await patterns.get(sha)!;
    for (let dir = dirname(file); dir !== '.'; dir = dirname(dir)) {
      if ((STANDALONE_PACKAGE_DIRS.includes(dir)
        || (globs.some(pattern => !pattern.startsWith('!') && matchesGlob(dir, pattern))
          && !globs.some(pattern => pattern.startsWith('!') && matchesGlob(dir, pattern.slice(1)))))
        && await testEntry(sha, dir + '/package.json')) return dir;
    }
    return null;
  };
  const workspaceChanges = new Map<string, Promise<boolean>>();
  const workspaceChanged = async (recordedSha: string, currentSha: string, file: string) => {
    try {
      const [recordedDir, currentDir] = await Promise.all([workspace(recordedSha, file), workspace(currentSha, file)]);
      if (!recordedDir || recordedDir !== currentDir) return false;
      const key = JSON.stringify([recordedSha, currentSha, recordedDir]);
      if (!workspaceChanges.has(key)) workspaceChanges.set(key, (async () => {
        const records = (await git({ cwd: repositoryRoot }, ['--literal-pathspecs', 'diff-tree', '--no-commit-id',
          '--raw', '--no-abbrev', '-r', '--no-renames', '-z', recordedSha, currentSha, '--', recordedDir]))
          .toString('utf8').split('\0');
        if (records.pop() !== '' || records.length % 2 !== 0) return false;
        let changed = false;
        for (let index = 0; index < records.length; index += 2) {
          const entry = /^:(\d{6}) (\d{6}) [a-f0-9]{40} [a-f0-9]{40} [ADMT]$/.exec(records[index]!);
          if (!entry || !records[index + 1]!.startsWith(recordedDir + '/')) return false;
          // A gitlink can advance without changing its expanded file content.
          // Only direct blob/mode changes prove this mandatory closure differs.
          if ([entry[1], entry[2]].every(mode => /^(000000|100644|100755|120000)$/.test(mode!))) changed = true;
        }
        return changed;
      })());
      return await workspaceChanges.get(key)!;
    } catch { return false; /* Unknown ownership/diffs still need the canonical proof. */ }
  };
  const proof = (sha: string, file: string) => {
    if (!snapshots.has(sha)) snapshots.set(sha, snapshot(repositoryRoot, sha, cache));
    return snapshots.get(sha)!.then(view => dependencyProof(view, file));
  };
  return async ({ file, recordedSha, currentSha }) => {
    if (!SHA.test(recordedSha) || !SHA.test(currentSha) || file.startsWith('/') || file.split('/').includes('..')) {
      return { equivalent: false, reason: 'content identity unavailable' };
    }
    try {
      let resolvedRecordedSha = recordedSha;
      let resolvedCurrentSha = currentSha;
      if (qualifiedCurrentSha) {
        if (!FULL_SHA.test(recordedSha) || !qualifiedCurrentSha.startsWith(currentSha.toLowerCase())) {
          return { equivalent: false, reason: 'content identity does not match the qualified source artifact' };
        }
        resolvedRecordedSha = recordedSha.toLowerCase();
        resolvedCurrentSha = qualifiedCurrentSha;
        await git({ cwd: repositoryRoot }, ['cat-file', '-e', resolvedRecordedSha + '^{commit}']);
      }
      if (resolvedRecordedSha !== resolvedCurrentSha) {
        const [recordedTest, currentTest] = await Promise.all([
          testEntry(resolvedRecordedSha, file), testEntry(resolvedCurrentSha, file),
        ]);
        // The test itself belongs to the semantic closure. A changed immutable
        // blob/mode is sufficient to reject reuse before enumerating dependencies;
        // matching entries never establish equivalence on their own.
        if (recordedTest && currentTest && recordedTest !== currentTest) {
          return { equivalent: false, reason: 'semantic dependency closure changed' };
        }
        // The owning workspace is a mandatory part of the canonical closure.
        // This only rejects reuse; equal local inputs still need every dependency.
        if (recordedTest && currentTest && await workspaceChanged(resolvedRecordedSha, resolvedCurrentSha, file)) {
          return { equivalent: false, reason: 'semantic dependency closure changed' };
        }
      }
      const [recorded, current] = await Promise.all([
        proof(resolvedRecordedSha, file), proof(resolvedCurrentSha, file),
      ]);
      const equivalent = recorded.hash === current.hash && recorded.listHash === current.listHash;
      return { equivalent, reason: equivalent ? 'canonical semantic dependency closure matches' : 'semantic dependency closure changed' };
    } catch (error) {
      return { equivalent: false, reason: error instanceof Error ? error.message : String(error) };
    }
  };
}

export function createTestContentEquivalence(root?: string): TestContentEquivalence {
  let context: Promise<TestContentEquivalence> | undefined;
  return async input => {
    if (!SHA.test(input.recordedSha) || !SHA.test(input.currentSha)
        || input.file.startsWith('/') || input.file.split('/').includes('..')) {
      return { equivalent: false, reason: 'content identity unavailable' };
    }
    try {
      context ??= resolveRepository(root).then(({ root: resolvedRoot, sourceSha }) =>
        createContentComparator(resolvedRoot, sourceSha ?? null));
      return await (await context)(input);
    } catch (error) {
      return { equivalent: false, reason: error instanceof Error ? error.message : String(error) };
    }
  };
}
