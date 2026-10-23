/** Immutable Git inputs, judged by the SAME closure policy as passing-task reuse. */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { matchesGlob, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import {
  passingTaskVerdictDependencyProvenance,
  passingTaskVerdictSharedInputProvenance,
  type ResolvedDependencyClosureProof,
} from '../../../../scripts/lib/passing-task-verdict-cache.mjs';
import { STANDALONE_PACKAGE_DIRS } from '../../../../scripts/lib/test-runner-classes.mjs';
import { moduleRepoRoot } from '../module-repo-root';

const exec = promisify(execFile);
const SHA = /^[a-f0-9]{7,40}$/i;
type Repository = { cwd: string; gitDir?: string };
type Entry = { repo: Repository; oid: string; mode: string; type: string };
type Snapshot = { files: Map<string, Entry>; texts: Map<string, string>; unscanned: string[] };
export type TestContentEquivalence = (input: {
  file: string; recordedSha: string; currentSha: string;
}) => Promise<{ equivalent: boolean; reason: string }>;

async function git(repo: Repository, args: string[]): Promise<Buffer> {
  const result = await exec('git', [...(repo.gitDir ? ['--git-dir', repo.gitDir] : []), ...args], {
    cwd: repo.cwd, encoding: 'buffer', timeout: 15_000, maxBuffer: 64 * 1024 * 1024,
  });
  return result.stdout;
}

async function snapshot(root: string, sha: string): Promise<Snapshot> {
  const result: Snapshot = { files: new Map(), texts: new Map(), unscanned: [] };
  const walk = async (repo: Repository, ref: string, prefix: string) => {
    const tree = await git(repo, ['ls-tree', '-rz', '--full-tree', ref]);
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
        const common = (await git(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).toString().trim();
        await walk({ cwd: repo.cwd, gitDir: resolve(common, 'modules', local) }, oid, path + '/');
      } catch {
        result.unscanned.push(path);
      }
    }
  };
  await walk({ cwd: root }, sha, '');
  return result;
}

async function loadTexts(view: Snapshot, files: readonly string[]): Promise<void> {
  const missing = [...new Set(files)].filter(file => !view.texts.has(file));
  for (let offset = 0; offset < missing.length; offset += 16) {
    await Promise.all(missing.slice(offset, offset + 16).map(async file => {
      const entry = view.files.get(file);
      if (!entry || entry.type !== 'blob' || entry.mode === '120000') throw new Error('unreadable input: ' + file);
      view.texts.set(file, (await git(entry.repo, ['cat-file', 'blob', entry.oid])).toString('utf8'));
    }));
  }
}

async function dependencyProof(view: Snapshot, file: string): Promise<ResolvedDependencyClosureProof> {
  const root = '/conformance-git-inputs';
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
  const owner = [...workspaces].filter(([, ws]) => file.startsWith(ws.dir + '/'))
    .sort((a, b) => b[1].dir.length - a[1].dir.length)[0];
  if (!owner || !view.files.has(file)) throw new Error('test workspace unavailable: ' + file);
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
    root, taskKey: owner[0] + ' :: test', script: 'test', workspaceName: owner[0], workspaces,
    trackedScan, repoWideTaskKeys: new Set(), sharedInputProvenance: shared, hashFiles,
  });
  if (!proof.ok) throw new Error(proof.reason);
  return proof.semantic;
}

/** Request-scoped caches: no mutable working-tree observation or synthetic receipt. */
export function createTestContentEquivalence(root = moduleRepoRoot(import.meta.url)): TestContentEquivalence {
  const snapshots = new Map<string, Promise<Snapshot>>();
  const proofs = new Map<string, Promise<ResolvedDependencyClosureProof>>();
  const proof = (sha: string, file: string) => {
    const key = JSON.stringify([sha, file]);
    if (!snapshots.has(sha)) snapshots.set(sha, snapshot(root, sha));
    if (!proofs.has(key)) proofs.set(key, snapshots.get(sha)!.then(view => dependencyProof(view, file)));
    return proofs.get(key)!;
  };
  return async ({ file, recordedSha, currentSha }) => {
    if (!SHA.test(recordedSha) || !SHA.test(currentSha) || file.startsWith('/') || file.split('/').includes('..')) {
      return { equivalent: false, reason: 'content identity unavailable' };
    }
    try {
      const [recorded, current] = await Promise.all([proof(recordedSha, file), proof(currentSha, file)]);
      const equivalent = recorded.hash === current.hash && recorded.listHash === current.listHash;
      return { equivalent, reason: equivalent ? 'canonical semantic dependency closure matches' : 'semantic dependency closure changed' };
    } catch (error) {
      return { equivalent: false, reason: error instanceof Error ? error.message : String(error) };
    }
  };
}
