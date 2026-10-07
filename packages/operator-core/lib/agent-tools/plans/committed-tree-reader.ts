/**
 * Read repository files as they exist at ONE commit, from git objects
 * (proof-freshness-pinned-candidate-2026-10-06 P-002, decision D-001).
 *
 * WHY. A repo-files proof binding stores a sha256 fingerprint of the files it measured.
 * Freshness used to be re-measured from the LIVE shared working tree, so any peer's
 * uncommitted edit to any file in a proof's closure (a hub file like work-items.ts is in
 * most closures) made shipped proof read stale within minutes, and binds refused on the
 * same drift. D-001 moves the measurement onto committed bytes: one measurement commit M
 * per evaluation, read from git objects, so uncommitted edits are invisible while a
 * committed change to a closure file still reads stale (nothing is waived).
 *
 * COST. Every read is batched per repository, never per file or per binding: one
 * `ls-tree` per repository (plus one per parent to resolve submodule gitlinks) and one
 * `cat-file --batch` per repository for blob contents not already digested. Blob ids are
 * content addresses, so the blob -> sha256 memo below is correct forever and repeated
 * evaluations of an unchanged commit spawn no `cat-file` at all.
 *
 * The file-set digest lives here so the working-tree measurement and the commit
 * measurement share one canonical formula: a binding stored before this change reads
 * current exactly when its fingerprint equals the closure bytes at M.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { posix } from 'node:path';
import { minimatch } from 'minimatch';
import { pinModuleState } from '@papercusp/module-singleton';
import { createTextCollector } from '../../child-output';
import {
  gitSidecarEnabled,
  isSidecarInfrastructureFault,
  noteSidecarFallback,
  runGitStdinViaSpawnerSidecar,
  type GitStdinRunResult,
} from '../../fleet/git-via-sidecar';
import { defaultGitRunner, gitBlobId, owningRepo, type GitRunner } from './evidence-measurement-pin';

/** One file as committed: the digest inputs plus the git blob id the bytes came from. */
export interface CommittedFile {
  path: string;
  sha256: string;
  gitBlob: string;
  size: number;
}

/** Read blob contents for many ids in ONE process; ids absent from the result are missing. */
export type BlobBatchReader = (repoDir: string, blobIds: readonly string[]) => Promise<Map<string, Buffer>>;

export interface CommittedTreeDeps {
  git?: GitRunner;
  readBlobs?: BlobBatchReader;
  /** Whether `<root>/<repo>` is a nested repository; defaults to a `.git` entry probe. */
  exists?: (repo: string) => Promise<boolean>;
}

export interface CommittedGlobLimits {
  maxMatches: number;
  maxDepth: number;
}

const BLOB_BATCH_TIMEOUT_MS = 15_000;
const MAX_MEMOIZED_BLOBS = 50_000;
const MAX_FILE_SET_BYTES = 8 * 1024 * 1024;
const COMMIT_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

const blobDigests = pinModuleState('@papercusp/operator-core.committed-blob-digests', () => ({
  byBlob: new Map<string, { sha256: string; size: number }>(),
}));

/** The canonical `sha256-file-set-v1` digest over `{ path, sha256 }` entries. */
export function repoFileSetFingerprint(entries: ReadonlyArray<{ path: string; sha256: string }>): string {
  const ordered = [...entries]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map(({ path, sha256 }) => ({ path, sha256 }));
  const digest = createHash('sha256').update(JSON.stringify(ordered)).digest('hex');
  return `sha256-file-set-v1:${digest}`;
}

/**
 * The commit a measurement root's HEAD points at, or null when the root is not the TOP
 * LEVEL of a git checkout. A non-git root, a root with no commit yet, and a root that is a
 * subdirectory of a larger repository all return null and keep the working-tree
 * measurement: every committed read below addresses paths relative to the repository top
 * level, so a subdirectory root would silently read the wrong objects.
 */
export async function resolveMeasurementCommit(root: string, git: GitRunner = defaultGitRunner): Promise<string | null> {
  try {
    const [top, commit] = (await git(root, ['rev-parse', '--show-toplevel', 'HEAD^{commit}'])).trim().split('\n');
    if (!top || !commit || !COMMIT_RE.test(commit)) return null;
    const [realTop, realRoot] = await Promise.all([realpath(top), realpath(root)]);
    return realTop === realRoot ? commit : null;
  } catch {
    return null;
  }
}

/** Binary-safe `git cat-file --batch`: one process for every id. */
export const defaultBlobBatchReader: BlobBatchReader = async (repoDir, blobIds) => {
  const stdin = `${blobIds.join('\n')}\n`;
  if (gitSidecarEnabled('PAPERCUSP_PLAN_AUDIT_SPAWN_SIDECAR')) {
    let sidecarResult: GitStdinRunResult | null = null;
    try {
      sidecarResult = await runGitStdinViaSpawnerSidecar(
        ['cat-file', '--batch'],
        repoDir,
        stdin,
        BLOB_BATCH_TIMEOUT_MS,
        process.env,
      );
    } catch (error) {
      noteSidecarFallback('committed-tree-reader', error);
    }
    if (sidecarResult && isSidecarInfrastructureFault(sidecarResult)) {
      noteSidecarFallback('committed-tree-reader', new Error(sidecarResult.stderr));
      sidecarResult = null;
    }
    if (sidecarResult) {
      if (sidecarResult.code !== 0) {
        throw new Error(
          `Command failed (exit ${sidecarResult.code}): git -C ${repoDir} cat-file --batch\n${sidecarResult.stderr}`,
        );
      }
      return parseCatFileBatch(sidecarResult.stdout);
    }
  }

  return new Promise((resolvePromise, reject) => {
    const child = spawn('git', ['-C', repoDir, 'cat-file', '--batch'], { stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    const stderr = createTextCollector(child.stderr);
    const timer = setTimeout(() => child.kill('SIGKILL'), BLOB_BATCH_TIMEOUT_MS);
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`Command failed (${signal ?? `exit ${code}`}): git -C ${repoDir} cat-file --batch\n${stderr.text()}`));
        return;
      }
      try {
        resolvePromise(parseCatFileBatch(Buffer.concat(chunks)));
      } catch (error) {
        reject(error);
      }
    });
    child.stdin.end(stdin);
  });
};

/** Parse `cat-file --batch` output: `<oid> <type> <size>\n<bytes>\n` or `<oid> missing\n`. */
export function parseCatFileBatch(output: Buffer): Map<string, Buffer> {
  const blobs = new Map<string, Buffer>();
  let offset = 0;
  while (offset < output.length) {
    const newline = output.indexOf(0x0a, offset);
    if (newline < 0) throw new Error('cat_file_batch_truncated_header');
    const header = output.subarray(offset, newline).toString('utf8').split(' ');
    offset = newline + 1;
    if (header[1] === 'missing' || header.length < 3) continue;
    const size = Number(header[2]);
    if (!Number.isSafeInteger(size) || size < 0 || offset + size > output.length) {
      throw new Error('cat_file_batch_truncated_body');
    }
    if (header[1] === 'blob') blobs.set(header[0]!, Buffer.from(output.subarray(offset, offset + size)));
    offset += size + 1;
  }
  return blobs;
}

function normalizedRepoPath(path: string): string {
  const normalized = posix.normalize(path);
  if (posix.isAbsolute(normalized) || normalized === '..' || normalized.startsWith('../') || normalized === '.') {
    throw new Error(`repo_measurement_path_outside_root:${path}`);
  }
  return normalized;
}

const relativeTo = (repo: string, path: string) => (repo === '.' ? path : path.slice(repo.length + 1));
const repoDir = (root: string, repo: string) => (repo === '.' ? root : posix.join(root, repo));

/** `ls-tree -z` entries keyed by the path relative to the listed repository. */
function parseLsTreeZ(output: string): Map<string, { mode: string; type: string; object: string }> {
  const entries = new Map<string, { mode: string; type: string; object: string }>();
  for (const record of output.split('\0')) {
    const tab = record.indexOf('\t');
    if (tab < 0) continue;
    const [mode, type, object] = record.slice(0, tab).split(' ');
    if (mode && type && object) entries.set(record.slice(tab + 1), { mode, type, object });
  }
  return entries;
}

async function lsTree(git: GitRunner, dir: string, commit: string, paths: readonly string[], recursive = false) {
  if (paths.length === 0) return new Map<string, { mode: string; type: string; object: string }>();
  const args = ['ls-tree', '-z', ...(recursive ? ['-r'] : []), commit, '--', ...paths];
  return parseLsTreeZ(await git(dir, args));
}

/**
 * Resolve the commit each repository is at under superproject commit `commit`: the root
 * is `commit` itself; a submodule is the gitlink its parent records at the parent's
 * commit. A repository with no gitlink at that commit maps to null (its paths are absent).
 */
async function resolveRepoCommits(
  root: string,
  commit: string,
  repos: ReadonlySet<string>,
  git: GitRunner,
  exists: (repo: string) => Promise<boolean>,
): Promise<Map<string, string | null>> {
  const commits = new Map<string, string | null>([['.', commit]]);
  const parentOf = new Map<string, string>();
  const pending = new Set<string>();
  const enqueue = async (repo: string): Promise<void> => {
    if (commits.has(repo) || pending.has(repo)) return;
    pending.add(repo);
    const parent = await owningRepo(root, repo, exists);
    parentOf.set(repo, parent);
    await enqueue(parent);
  };
  for (const repo of repos) await enqueue(repo);
  while (pending.size > 0) {
    // Resolve every repository whose parent is already resolved, one ls-tree per parent.
    const ready = new Map<string, string[]>();
    for (const repo of pending) {
      const parent = parentOf.get(repo)!;
      if (!commits.has(parent)) continue;
      ready.set(parent, [...(ready.get(parent) ?? []), repo]);
    }
    if (ready.size === 0) throw new Error('committed_tree_repo_cycle');
    for (const [parent, children] of ready) {
      const parentCommit = commits.get(parent) ?? null;
      const entries = parentCommit
        ? await lsTree(git, repoDir(root, parent), parentCommit, children.map((child) => relativeTo(parent, child)))
        : new Map<string, { mode: string; type: string; object: string }>();
      for (const child of children) {
        const entry = entries.get(relativeTo(parent, child));
        commits.set(child, entry?.mode === '160000' ? entry.object : null);
        pending.delete(child);
      }
    }
  }
  return commits;
}

function rememberDigest(blob: string, content: Buffer): { sha256: string; size: number } {
  const digest = { sha256: createHash('sha256').update(content).digest('hex'), size: content.length };
  if (blobDigests.byBlob.size >= MAX_MEMOIZED_BLOBS) blobDigests.byBlob.clear();
  blobDigests.byBlob.set(blob, digest);
  return digest;
}

/** Where a root-relative path lives at a commit: its owning repository and tree entry. */
export interface CommittedBlobLocation {
  /** Owning repository, root-relative (`.` for the root itself). */
  repo: string;
  /** The tree entry's object id (a blob id for a regular file). */
  object: string;
  mode: string;
  type: string;
  /** True only for a regular file (a blob that is not a symlink). */
  isFile: boolean;
}

/**
 * Locate `paths` (root-relative) at superproject commit `commit` WITHOUT reading their
 * bytes: one `ls-tree` per owning repository, plus one per parent for submodule gitlinks.
 * Keys are the normalized paths; a path absent at that commit maps to null. This is the
 * blob-id-only read for callers that compare git object ids (P-019: audit citations),
 * and the first half of `readCommittedFiles`.
 */
export async function locateCommittedBlobs(
  root: string,
  commit: string,
  paths: readonly string[],
  deps: CommittedTreeDeps = {},
): Promise<Map<string, CommittedBlobLocation | null>> {
  const git = deps.git ?? defaultGitRunner;
  const ownerOf = new Map<string, string>();
  for (const normalized of new Set(paths.map(normalizedRepoPath))) {
    ownerOf.set(normalized, await owningRepo(root, normalized, deps.exists));
  }
  const repoCommits = await resolveRepoCommits(root, commit, new Set(ownerOf.values()), git, deps.exists ?? ((repo) => hasRepo(root, repo)));

  const byRepo = new Map<string, string[]>();
  for (const [normalized, repo] of ownerOf) byRepo.set(repo, [...(byRepo.get(repo) ?? []), normalized]);
  const located = new Map<string, CommittedBlobLocation | null>();
  for (const [repo, repoPaths] of byRepo) {
    const repoCommit = repoCommits.get(repo) ?? null;
    if (!repoCommit) {
      for (const path of repoPaths) located.set(path, null);
      continue;
    }
    const entries = await lsTree(git, repoDir(root, repo), repoCommit, repoPaths.map((path) => relativeTo(repo, path)));
    for (const path of repoPaths) {
      const entry = entries.get(relativeTo(repo, path));
      located.set(
        path,
        entry
          ? { repo, object: entry.object, mode: entry.mode, type: entry.type, isFile: entry.type === 'blob' && entry.mode !== '120000' }
          : null,
      );
    }
  }
  return located;
}

/**
 * Read `paths` (root-relative) as committed at superproject commit `commit`. A path that
 * does not exist at that commit maps to null; a path that is a tree, gitlink or symlink
 * there throws `repo_measurement_not_file`.
 */
export async function readCommittedFiles(
  root: string,
  commit: string,
  paths: readonly string[],
  deps: CommittedTreeDeps = {},
): Promise<Map<string, CommittedFile | null>> {
  const readBlobs = deps.readBlobs ?? defaultBlobBatchReader;
  const declared = [...new Set(paths)];
  const normalizedOf = new Map(declared.map((path) => [path, normalizedRepoPath(path)] as const));
  const locations = await locateCommittedBlobs(root, commit, [...new Set(normalizedOf.values())], deps);
  const blobOf = new Map<string, { repo: string; blob: string } | null>();
  for (const [path, location] of locations) {
    if (!location) {
      blobOf.set(path, null);
    } else if (!location.isFile) {
      throw new Error(`repo_measurement_not_file:${path}`);
    } else {
      blobOf.set(path, { repo: location.repo, blob: location.object });
    }
  }

  const unread = new Map<string, Set<string>>();
  for (const located of blobOf.values()) {
    if (!located || blobDigests.byBlob.has(located.blob)) continue;
    unread.set(located.repo, (unread.get(located.repo) ?? new Set()).add(located.blob));
  }
  for (const [repo, blobs] of unread) {
    const contents = await readBlobs(repoDir(root, repo), [...blobs]);
    for (const blob of blobs) {
      const content = contents.get(blob);
      if (!content) throw new Error(`repo_measurement_blob_missing:${blob}`);
      if (gitBlobId(content) !== blob) throw new Error(`repo_measurement_blob_mismatch:${blob}`);
      rememberDigest(blob, content);
    }
  }

  const result = new Map<string, CommittedFile | null>();
  for (const [path, normalized] of normalizedOf) {
    const located = blobOf.get(normalized) ?? null;
    if (!located) {
      result.set(path, null);
      continue;
    }
    const digest = blobDigests.byBlob.get(located.blob)!;
    result.set(path, { path, sha256: digest.sha256, gitBlob: located.blob, size: digest.size });
  }
  return result;
}

async function hasRepo(root: string, repo: string): Promise<boolean> {
  const { lstat } = await import('node:fs/promises');
  try {
    await lstat(posix.join(root, repo, '.git'));
    return true;
  } catch {
    return false;
  }
}

const GLOB_SYNTAX_RE = /[*?[\]{}()!+@]/;

/** The static leading directory of a glob (`packages/x/**\/*.ts` -> `packages/x`). */
function globBase(glob: string): string {
  const segments = glob.split('/');
  const fixed: string[] = [];
  for (const segment of segments.slice(0, -1)) {
    if (GLOB_SYNTAX_RE.test(segment)) break;
    fixed.push(segment);
  }
  return fixed.join('/');
}

/**
 * The base each glob's depth bound is counted from, mirroring fast-glob's task grouping
 * (measured against fast-glob on a fixture tree, committed-tree-reader.test.ts):
 * a STATIC pattern is stat'ed directly and has no depth bound (null); DYNAMIC patterns are
 * grouped by base directory, except that when any of them is rooted at the cwd they all
 * merge into one cwd task, so every dynamic pattern then counts depth from the root ('').
 */
function depthBases(globs: readonly string[]): Map<string, string | null> {
  const dynamic = globs.filter((glob) => GLOB_SYNTAX_RE.test(glob));
  const mergedAtRoot = dynamic.some((glob) => globBase(glob) === '');
  return new Map(globs.map((glob) => [glob, !GLOB_SYNTAX_RE.test(glob) ? null : mergedAtRoot ? '' : globBase(glob)]));
}

/**
 * fast-glob's `deep` bound: a file is listed when it sits directly in the base directory
 * or its parent directory is fewer than `maxDepth` levels below it.
 */
function withinDepth(path: string, base: string | null, maxDepth: number): boolean {
  if (base === null) return true;
  const baseSegments = base === '' ? 0 : base.split('/').length;
  const parentLevel = path.split('/').length - 1 - baseSegments;
  return parentLevel < Math.max(maxDepth, 1);
}

/**
 * Expand source globs against the files committed at `commit` (the commit-side twin of
 * the working-tree fast-glob expansion: dot files included, symlinks not followed, the
 * same depth and match-count bounds). Submodules under a glob's base are descended at
 * the gitlink their parent records.
 */
export async function listCommittedGlobMatches(
  root: string,
  commit: string,
  globs: readonly string[],
  limits: CommittedGlobLimits,
  deps: CommittedTreeDeps = {},
): Promise<string[]> {
  if (globs.length === 0) return [];
  const git = deps.git ?? defaultGitRunner;
  const exists = deps.exists ?? ((repo: string) => hasRepo(root, repo));
  const bases = [...new Set(globs.map(globBase))];
  // A base inside a submodule is listed INSIDE that submodule: a superproject pathspec
  // below a gitlink matches nothing, so resolve each base's owning repository first.
  const ownerOf = new Map<string, string>();
  for (const base of bases) ownerOf.set(base, base === '' ? '.' : await owningRepo(root, `${base}/_`, exists));
  const repoCommits = await resolveRepoCommits(root, commit, new Set(ownerOf.values()), git, exists);
  const queue: Array<{ repo: string; commit: string; prefixes: string[] }> = [];
  for (const repo of new Set(ownerOf.values())) {
    const repoCommit = repoCommits.get(repo);
    if (!repoCommit) continue;
    const owned = bases.filter((base) => ownerOf.get(base) === repo);
    const whole = owned.some((base) => base === '' || base === repo);
    queue.push({ repo, commit: repoCommit, prefixes: whole ? [] : owned.map((base) => relativeTo(repo, base)) });
  }
  const listed = new Set<string>();
  // Per repository, what has been listed: 'all' or the listed prefixes. A later, wider
  // request (a gitlink reached from a parent's base) lists only what is not yet covered.
  const listedPrefixes = new Map<string, 'all' | Set<string>>();
  while (queue.length > 0) {
    const next = queue.shift()!;
    const done = listedPrefixes.get(next.repo);
    if (done === 'all') continue;
    const prefixes = next.prefixes.length === 0 ? [] : next.prefixes.filter((prefix) => !done?.has(prefix));
    if (next.prefixes.length > 0 && prefixes.length === 0) continue;
    listedPrefixes.set(next.repo, prefixes.length === 0 ? 'all' : new Set([...(done ?? []), ...prefixes]));
    const args = ['ls-tree', '-z', '-r', next.commit, ...(prefixes.length ? ['--', ...prefixes] : [])];
    const entries = parseLsTreeZ(await git(repoDir(root, next.repo), args));
    for (const [relPath, entry] of entries) {
      const path = next.repo === '.' ? relPath : `${next.repo}/${relPath}`;
      if (entry.mode === '160000') {
        const covered = bases.filter((base) => base === '' || path.startsWith(`${base}/`) || base.startsWith(`${path}/`));
        if (covered.length) {
          queue.push({
            repo: path,
            commit: entry.object,
            prefixes: covered.some((base) => !base.startsWith(`${path}/`)) ? [] : covered.map((base) => relativeTo(path, base)),
          });
        }
      } else if (entry.type === 'blob' && entry.mode !== '120000') {
        listed.add(path);
      }
    }
  }
  const matches = new Set<string>();
  const baseOf = depthBases(globs);
  for (const path of listed) {
    if (globs.some((glob) => minimatch(path, glob, { dot: true }) && withinDepth(path, baseOf.get(glob) ?? null, limits.maxDepth))) {
      matches.add(path);
      if (matches.size > limits.maxMatches) {
        throw new Error(`repo_measurement_too_many_glob_files:${matches.size}>${limits.maxMatches}`);
      }
    }
  }
  return [...matches].sort();
}

/**
 * The commit-side twin of the working-tree file-set fingerprint: same digest, same
 * per-file `{ path, sha256, gitBlob }`, computed from the bytes committed at `commit`.
 */
export async function fingerprintRepoFileSetAtCommit(
  root: string,
  commit: string,
  declaredPaths: readonly string[],
  deps: CommittedTreeDeps = {},
): Promise<{ fingerprint: string; files: Array<{ path: string; sha256: string; gitBlob: string }> }> {
  const paths = [...new Set(declaredPaths)].sort();
  const read = await readCommittedFiles(root, commit, paths, deps);
  const files: Array<{ path: string; sha256: string; gitBlob: string }> = [];
  let totalBytes = 0;
  for (const path of paths) {
    const file = read.get(path);
    if (!file) throw new Error(`repo_measurement_absent_at_commit:${path}@${commit.slice(0, 12)}`);
    totalBytes += file.size;
    if (totalBytes > MAX_FILE_SET_BYTES) {
      throw new Error(`repo_measurement_too_large:${totalBytes}>${MAX_FILE_SET_BYTES}`);
    }
    files.push({ path, sha256: file.sha256, gitBlob: file.gitBlob });
  }
  return { fingerprint: repoFileSetFingerprint(files), files };
}

/** Test seam: forget memoized blob digests. */
export function __resetCommittedBlobDigestsForTest(): void {
  blobDigests.byBlob.clear();
}
