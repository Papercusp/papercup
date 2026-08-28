/**
 * Spawn-free completion tree stamps and the read-side freshness detector.
 *
 * Completion evidence is only useful when a later reader can tell whether the
 * verification still describes the checkout it is looking at.  Keep HEAD
 * resolution here as a small leaf so both the close path and read path share
 * the same exact observation, without importing the complete tool into reads.
 */
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as nodePath from 'node:path';
import { detectPapercupRoot } from '../../harness/register-papercusp';
import { hasValidGitEntry } from '../locks/valid-git-entry';
import type {
  CompletionSettlementManifest,
  CompletionTreeStamp,
  CompletionTreeContentIdentity,
  CompletionVerificationEvidence,
} from '../../coord-lifecycle/records';

const SHA_RE = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;
const MAX_PATHS_PROBED = 60;
const OBJECT_SHA_RE = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;

export type { CompletionTreeContentIdentity } from '../../coord-lifecycle/records';

function canonicalEvidence(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalEvidence).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([key]) => key !== 'settlementManifest')
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalEvidence(child)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** Build the immutable generation-1 receipt for a newly closed code item. */
export function completionSettlementManifest(
  evidence: CompletionVerificationEvidence,
  generation = 1,
): CompletionSettlementManifest | undefined {
  const stamp = evidence.treeStamp;
  if (!stamp?.repositoryRoot || !stamp.contentIdentity?.length) return undefined;
  const contentIdentity = [...stamp.contentIdentity]
    .map((identity) => ({ ...identity, path: identity.path.replaceAll('\\', '/') }))
    .sort((a, b) => a.path.localeCompare(b.path));
  const normalizedPaths = [...new Set(contentIdentity.map(({ path }) => path))];
  if (normalizedPaths.length === 0) return undefined;
  return {
    version: 1,
    generation,
    evidenceHash: createHash('sha256').update(canonicalEvidence(evidence)).digest('hex'),
    repositoryRoot: nodePath.resolve(stamp.repositoryRoot),
    headSha: stamp.headSha,
    normalizedPaths,
    contentIdentity,
  };
}

/** Injected reads for {@link completionTreeStamp}, so it is unit-testable. */
export interface CompletionTreeStampProbe {
  repoRoot?: string | null;
  /** Returns file contents, or undefined when the path does not exist / cannot be read. */
  readFile?: (absPath: string) => string | undefined;
  /** Returns raw file bytes, preserving Git's blob hash semantics for binary files. */
  readBytes?: (absPath: string) => Uint8Array | undefined;
  /** Declared paths whose working-tree and HEAD blob identities should be recorded. */
  filesChanged?: readonly string[];
  /** Injectable HEAD tree lookup; production uses one bounded `git ls-tree` read. */
  headBlobs?: (repoRoot: string, headSha: string, paths: readonly string[]) => ReadonlyMap<string, string | null> | undefined;
}

function normalizedRepoPath(repoRoot: string, raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.includes('*') || trimmed.includes('?')) return undefined;
  const abs = nodePath.resolve(repoRoot, trimmed);
  if (abs !== repoRoot && !abs.startsWith(repoRoot + nodePath.sep)) return undefined;
  return nodePath.relative(repoRoot, abs).split(nodePath.sep).join('/');
}

function gitBlobSha(bytes: Uint8Array, shaLength: number): string {
  const algorithm = shaLength === 64 ? 'sha256' : 'sha1';
  const header = Buffer.from(`blob ${bytes.byteLength}\0`, 'utf8');
  return createHash(algorithm).update(header).update(bytes).digest('hex');
}

export function completionHeadBlobMap(repoRoot: string, headSha: string, paths: readonly string[]): ReadonlyMap<string, string | null> | undefined {
  try {
    const runLsTree = (root: string, sha: string, selected?: readonly string[], recursive = true) => execFileSync(
      'git',
      ['-C', root, 'ls-tree', ...(recursive ? ['-r'] : []), '-z', sha, ...(selected?.length ? ['--', ...selected] : [])],
      {
      encoding: 'utf8',
      maxBuffer: 256 * 1024,
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
      },
    );
    const parseTree = (output: string) => {
      const blobs = new Map<string, string>();
      const gitlinks = new Map<string, string>();
      for (const record of output.split('\0')) {
        if (!record) continue;
        const tab = record.indexOf('\t');
        if (tab < 0) continue;
        const [mode, type, sha] = record.slice(0, tab).split(/\s+/);
        const path = record.slice(tab + 1);
        if (!sha || !OBJECT_SHA_RE.test(sha)) continue;
        if (type === 'blob' && mode) blobs.set(path, sha);
        if (type === 'commit' && mode === '160000') gitlinks.set(path, sha);
      }
      return { blobs, gitlinks };
    };

    const direct = parseTree(runLsTree(repoRoot, headSha, paths));
    const result = new Map<string, string | null>();
    for (const [path, sha] of direct.blobs) result.set(path, sha);

    const missing = paths.filter((path) => !result.has(path));
    if (missing.length > 0) {
      // A path below a submodule is absent from the superproject's recursive
      // tree: Git stores only the 160000 gitlink. Read the committed gitlinks,
      // then resolve each descendant against the exact submodule commit pinned
      // by this HEAD. Grouping keeps the lookup bounded to one recursive call
      // per referenced submodule, and recursion covers nested submodules too.
      // A full recursive tree can exceed maxBuffer on the production superproject (the
      // Papercusp tree is several MiB), which used to make every nested-submodule stamp
      // fail open as "identity unavailable". Query only the ancestor prefixes of the
      // missing paths; a non-recursive ls-tree returns the exact gitlink records while
      // keeping the lookup bounded by the declared path set.
      const gitlinkPrefixes = [
        ...new Set(
          missing.flatMap((path) => {
            const segments = path.split('/');
            return segments.slice(0, -1).map((_, index) => segments.slice(0, index + 1).join('/'));
          }),
        ),
      ];
      const allGitlinks = parseTree(runLsTree(repoRoot, headSha, gitlinkPrefixes, false)).gitlinks;
      const grouped = new Map<string, { sha: string; paths: string[] }>();
      for (const path of missing) {
        const prefix = [...allGitlinks.keys()]
          .filter((candidate) => path.startsWith(candidate + '/'))
          .sort((a, b) => b.length - a.length)[0];
        if (!prefix) continue;
        const group = grouped.get(prefix) ?? { sha: allGitlinks.get(prefix)!, paths: [] };
        group.paths.push(path.slice(prefix.length + 1));
        grouped.set(prefix, group);
      }
      for (const [prefix, group] of grouped) {
        const nested = completionHeadBlobMap(nodePath.join(repoRoot, prefix), group.sha, group.paths);
        if (!nested) continue;
        for (const path of group.paths) {
          const sha = nested.get(path);
          if (sha) result.set(`${prefix}/${path}`, sha);
        }
      }
    }
    return result;
  } catch {
    return undefined;
  }
}

function contentIdentity(
  repositoryRoot: string,
  headSha: string,
  filesChanged: readonly string[],
  probe: CompletionTreeStampProbe,
): CompletionTreeContentIdentity[] | undefined {
  const paths = [...new Set(filesChanged.slice(0, MAX_PATHS_PROBED).map((path) => normalizedRepoPath(repositoryRoot, path)))] as string[];
  if (paths.length === 0 || paths.some((path) => !path)) return undefined;
  const head = (probe.headBlobs ?? completionHeadBlobMap)(repositoryRoot, headSha, paths);
  if (!head) return undefined;
  const readBytes =
    probe.readBytes ??
    ((abs: string) => {
      try {
        return readFileSync(abs);
      } catch {
        return undefined;
      }
    });
  return paths.map((path) => {
    const bytes = readBytes(nodePath.join(repositoryRoot, path));
    return {
      path,
      workingTreeBlobSha: bytes === undefined ? null : gitBlobSha(bytes, headSha.length),
      headBlobSha: head.get(path) ?? null,
    };
  });
}

export function completionTreeContentIdentityMatches(
  identity: readonly CompletionTreeContentIdentity[] | undefined,
): boolean {
  return Boolean(
    identity?.length &&
      identity.every(
        (entry) =>
          entry.workingTreeBlobSha !== null &&
          entry.headBlobSha !== null &&
          entry.workingTreeBlobSha === entry.headBlobSha,
      ),
  );
}
/**
 * EI-21502635666260946: the WRITE-TIME half of the content-identity floor. A
 * close may claim `committed` only when the server could PROVE every declared
 * `filesChanged` path carries identical blob content in the working tree and
 * committed HEAD. Missing, mismatched, or unavailable identity never qualifies
 * — the close downgrades to `proposed` (record-and-warn, never rejected).
 *
 * This is also the contract mirrored in SQL by
 * harness_shared.downgrade_unproven_committed_close() (migration 972), which
 * enforces the same floor below the deploy boundary so a frozen release gate
 * serving an older build cannot mint stronger authority than this source
 * permits. Keep the two in sync: any change here must update
 * completion_content_identity_proven() and its migration test.
 */
export function committedCloseDowngradedForUnprovenContentIdentity(
  authorityByEvidence: string,
  filesChanged: readonly string[] | undefined,
  treeStamp: CompletionTreeStamp | undefined,
): boolean {
  return (
    authorityByEvidence === 'committed' &&
    Boolean(filesChanged?.length) &&
    !completionTreeContentIdentityMatches(treeStamp?.contentIdentity)
  );
}

/**
 * Read the current checkout HEAD without spawning git.
 *
 * This is deliberately fail-open: an absent or unreadable stamp means "not
 * observed", never "fresh".  The completion hot path must not turn a local
 * filesystem problem into a failed close or a false verification verdict.
 */
export function completionTreeStamp(probe: CompletionTreeStampProbe = {}): CompletionTreeStamp | undefined {
  const repoRoot = 'repoRoot' in probe ? probe.repoRoot : detectPapercupRoot();
  if (!repoRoot) return undefined;

  const readFile =
    probe.readFile ??
    ((abs: string) => {
      try {
        return readFileSync(abs, 'utf8');
      } catch {
        return undefined;
      }
    });

  try {
    const repositoryRoot = nodePath.resolve(repoRoot);
    let gitDir = nodePath.join(repositoryRoot, '.git');
    const dotGit = readFile(gitDir);
    if (dotGit !== undefined) {
      const pointed = /^gitdir:\s*(.+)$/m.exec(dotGit.trim())?.[1]?.trim();
      if (!pointed) return undefined;
      gitDir = nodePath.isAbsolute(pointed) ? pointed : nodePath.resolve(repositoryRoot, pointed);
    }

    const head = readFile(nodePath.join(gitDir, 'HEAD'))?.trim();
    if (!head) return undefined;
    if (SHA_RE.test(head)) {
      const stamp: CompletionTreeStamp = { repositoryRoot, headSha: head };
      const identity = probe.filesChanged ? contentIdentity(repositoryRoot, head, probe.filesChanged, probe) : undefined;
      return identity ? { ...stamp, contentIdentity: identity } : stamp;
    }

    const ref = /^ref:\s*(.+)$/.exec(head)?.[1]?.trim();
    if (!ref) return undefined;

    const loose = readFile(nodePath.join(gitDir, ref))?.trim();
    if (loose && SHA_RE.test(loose)) {
      const stamp: CompletionTreeStamp = { repositoryRoot, headSha: loose };
      const identity = probe.filesChanged ? contentIdentity(repositoryRoot, loose, probe.filesChanged, probe) : undefined;
      return identity ? { ...stamp, contentIdentity: identity } : stamp;
    }

    const packed = readFile(nodePath.join(gitDir, 'packed-refs'));
    if (!packed) return undefined;
    for (const line of packed.split('\n')) {
      if (!line || line.startsWith('#') || line.startsWith('^')) continue;
      const [sha, name] = line.trim().split(/\s+/, 2);
      if (name === ref && sha && SHA_RE.test(sha)) {
        const stamp: CompletionTreeStamp = { repositoryRoot, headSha: sha };
        const identity = probe.filesChanged ? contentIdentity(repositoryRoot, sha, probe.filesChanged, probe) : undefined;
        return identity ? { ...stamp, contentIdentity: identity } : stamp;
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export interface CompletionTreeStampForEvidenceProbe {
  /** Injectable path probe so repository selection stays pure in unit tests. */
  exists?: (abs: string) => boolean;
  /** Injectable checkout-root probe; production accepts real `.git` entries only. */
  isCheckoutRoot?: (abs: string) => boolean;
  /** Forwarded to completionTreeStamp after the owning repository is selected. */
  readFile?: (abs: string) => string | undefined;
  readBytes?: (abs: string) => Uint8Array | undefined;
  headBlobs?: (repoRoot: string, headSha: string, paths: readonly string[]) => ReadonlyMap<string, string | null> | undefined;
}

/**
 * Select the registered checkout that owns the completion's declared files,
 * then stamp that checkout's HEAD.  Stable ties preserve the first/root
 * checkout for backwards compatibility.
 */
export function completionTreeStampForEvidence(
  evidence: CompletionVerificationEvidence,
  repoRoots: string[],
  probe: CompletionTreeStampForEvidenceProbe = {},
): CompletionTreeStamp | undefined {
  const roots = [
    ...new Set(
      repoRoots
        .filter((root): root is string => typeof root === 'string' && root.trim().length > 0)
        .map((root) => nodePath.resolve(root)),
    ),
  ];
  if (roots.length === 0) return undefined;

  const exists = probe.exists ?? ((abs: string) => existsSync(abs));
  const isCheckoutRoot = probe.isCheckoutRoot ?? hasValidGitEntry;
  const declared = (evidence.filesChanged ?? []).slice(0, MAX_PATHS_PROBED);
  const primaryRoot = roots[0]!;

  // A relative path such as `papercusp-desktop/bin/check.sh` is resolved against the
  // primary checkout by callers. If that directory is itself an independent nested
  // repository, scoring the primary root would make the writer compare the file against
  // the parent tree (where the path is untracked) and record a false stale completion.
  // Discover those nested roots before scoring so the path can be re-rooted to the checkout
  // that actually owns its HEAD. This is deliberately bounded by the declared paths and
  // their ancestor chains; it never walks the repository tree.
  const nestedOwners = new Map<string, { absolutePath: string; root: string }>();
  for (const raw of declared) {
    const declaredPath = raw.trim();
    if (!declaredPath || declaredPath.includes('*') || declaredPath.includes('?')) continue;
    const absolutePath = nodePath.resolve(primaryRoot, declaredPath);
    if (absolutePath !== primaryRoot && !absolutePath.startsWith(primaryRoot + nodePath.sep)) continue;

    let dir = nodePath.dirname(absolutePath);
    for (let depth = 0; depth < 64 && dir !== primaryRoot; depth += 1) {
      if (isCheckoutRoot(dir)) {
        nestedOwners.set(declaredPath, { absolutePath, root: dir });
        break;
      }
      const parent = nodePath.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }

  const candidateRoots = [
    ...new Set([
      ...roots,
      ...[...nestedOwners.values()].map(({ root }) => root),
    ]),
  ];

  const pathForRoot = (
    root: string,
    raw: string,
  ): { absolutePath: string; relativePath: string } | undefined => {
    const declaredPath = raw.trim();
    if (!declaredPath || declaredPath.includes('*') || declaredPath.includes('?')) return undefined;
    const nested = nestedOwners.get(declaredPath);
    if (nested) {
      // Once the primary-root anchor identifies an owning nested checkout, do not let the
      // parent score the physical file as its own. A mixed-root completion therefore remains
      // unproven instead of combining half-matching repositories into one identity.
      if (root !== nested.root) return undefined;
      return {
        absolutePath: nested.absolutePath,
        relativePath: nodePath.relative(root, nested.absolutePath).split(nodePath.sep).join('/'),
      };
    }

    const absolutePath = nodePath.resolve(root, declaredPath);
    if (absolutePath !== root && !absolutePath.startsWith(root + nodePath.sep)) return undefined;
    return {
      absolutePath,
      relativePath: nodePath.relative(root, absolutePath).split(nodePath.sep).join('/'),
    };
  };

  let selectedRoot = primaryRoot;
  let selectedMatches = -1;
  let selectedAbsoluteSpecificity = -1;

  for (const repoRoot of candidateRoots) {
    let matches = 0;
    let absoluteSpecificity = -1;
    for (const raw of declared) {
      const declaredPath = raw.trim();
      if (!declaredPath || declaredPath.includes('*') || declaredPath.includes('?')) continue;
      const resolved = pathForRoot(repoRoot, declaredPath);
      if (!resolved) continue;
      try {
        if (exists(resolved.absolutePath)) {
          matches += 1;
          // An absolute path can be physically contained by both a superproject and its
          // submodule. Prefer the deepest containing checkout so its HEAD/blob identity is
          // stamped, while relative-path ties retain the primary-root compatibility rule.
          if (nodePath.isAbsolute(declaredPath)) absoluteSpecificity = Math.max(absoluteSpecificity, repoRoot.length);
        }
      } catch {
        // An unreadable candidate is not evidence that another checkout owns the file.
      }
    }
    if (
      matches > selectedMatches ||
      (matches === selectedMatches && absoluteSpecificity > selectedAbsoluteSpecificity)
    ) {
      selectedRoot = repoRoot;
      selectedMatches = matches;
      selectedAbsoluteSpecificity = absoluteSpecificity;
    }
  }

  const selectedFiles = declared.map((raw) => {
    const resolved = pathForRoot(selectedRoot, raw);
    return resolved?.relativePath ?? normalizedRepoPath(selectedRoot, raw);
  });

  return completionTreeStamp({
    repoRoot: selectedRoot,
    readFile: probe.readFile,
    readBytes: probe.readBytes,
    headBlobs: probe.headBlobs,
    filesChanged: selectedFiles,
  });
}

export type CompletionFreshnessVerdict = 'fresh' | 'stale' | 'unavailable';

export interface CompletionFreshness {
  verdict: CompletionFreshnessVerdict;
  storedTreeStamp: CompletionTreeStamp;
  currentTreeStamp?: CompletionTreeStamp;
  reason: string;
}

export interface CompletionFreshnessProbe {
  currentStamp?: (stored: CompletionTreeStamp) => CompletionTreeStamp | undefined;
}

function storedTreeStamp(value: unknown): CompletionTreeStamp | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const repositoryRoot = typeof record.repositoryRoot === 'string' ? record.repositoryRoot.trim() : '';
  const headSha = typeof record.headSha === 'string' ? record.headSha.trim() : '';
  if (!repositoryRoot || !SHA_RE.test(headSha)) return undefined;
  const rawIdentity = record.contentIdentity;
  let contentIdentity: CompletionTreeContentIdentity[] | undefined;
  if (rawIdentity !== undefined) {
    if (!Array.isArray(rawIdentity) || rawIdentity.length === 0 || rawIdentity.length > MAX_PATHS_PROBED) return undefined;
    contentIdentity = [];
    for (const candidate of rawIdentity) {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return undefined;
      const entry = candidate as Record<string, unknown>;
      const path = typeof entry.path === 'string' ? entry.path.trim() : '';
      const workingTreeBlobSha = entry.workingTreeBlobSha;
      const headBlobSha = entry.headBlobSha;
      if (
        !path ||
        (workingTreeBlobSha !== null && (typeof workingTreeBlobSha !== 'string' || !OBJECT_SHA_RE.test(workingTreeBlobSha))) ||
        (headBlobSha !== null && (typeof headBlobSha !== 'string' || !OBJECT_SHA_RE.test(headBlobSha)))
      ) return undefined;
      contentIdentity.push({ path, workingTreeBlobSha, headBlobSha });
    }
  }
  return { repositoryRoot: nodePath.resolve(repositoryRoot), headSha, ...(contentIdentity ? { contentIdentity } : {}) };
}

function identityByPath(identity: readonly CompletionTreeContentIdentity[]): Map<string, CompletionTreeContentIdentity> | undefined {
  const byPath = new Map<string, CompletionTreeContentIdentity>();
  for (const entry of identity) {
    if (byPath.has(entry.path)) return undefined;
    byPath.set(entry.path, entry);
  }
  return byPath;
}

/**
 * Compare terminal evidence's stored tree stamp with the current stamp from
 * that same repository.  No tree stamp means no signal; an unobservable current
 * stamp is explicit `unavailable`, never a false `fresh` result.
 */
export function completionFreshnessForEvidence(
  evidence: unknown,
  probe: CompletionFreshnessProbe = {},
): CompletionFreshness | undefined {
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) return undefined;
  const stored = storedTreeStamp((evidence as Record<string, unknown>).treeStamp);
  if (!stored) return undefined;

  if (!stored.contentIdentity?.length) {
    return {
      verdict: 'unavailable',
      storedTreeStamp: stored,
      reason: `Committed content identity was not recorded for ${stored.repositoryRoot}; completion freshness is not established.`,
    };
  }

  let current: CompletionTreeStamp | undefined;
  try {
    current =
      (probe.currentStamp ??
        ((stamp) =>
          completionTreeStamp({
            repoRoot: stamp.repositoryRoot,
            filesChanged: stamp.contentIdentity?.map((entry) => entry.path),
          })))(stored);
  } catch {
    current = undefined;
  }

  if (!current) {
    return {
      verdict: 'unavailable',
      storedTreeStamp: stored,
      reason: `Current HEAD could not be observed for ${stored.repositoryRoot}; completion freshness is not established.`,
    };
  }

  if (!current.contentIdentity?.length) {
    return {
      verdict: 'unavailable',
      storedTreeStamp: stored,
      currentTreeStamp: current,
      reason: `Current committed content identity could not be observed for ${stored.repositoryRoot}; completion freshness is not established.`,
    };
  }

  if (!completionTreeContentIdentityMatches(stored.contentIdentity)) {
    return {
      verdict: 'stale',
      storedTreeStamp: stored,
      currentTreeStamp: current,
      reason: 'Stored completion content identity does not match its declared HEAD; re-verify before trusting it.',
    };
  }
  if (!completionTreeContentIdentityMatches(current.contentIdentity)) {
    return {
      verdict: 'stale',
      storedTreeStamp: stored,
      currentTreeStamp: current,
      reason: 'Current working-tree content does not match committed HEAD for every declared path; re-verify before trusting it.',
    };
  }

  if (current.repositoryRoot !== stored.repositoryRoot) {
    return {
      verdict: 'stale',
      storedTreeStamp: stored,
      currentTreeStamp: current,
      reason:
        `Completion verification was observed in ${stored.repositoryRoot}, but current evidence resolved in ${current.repositoryRoot}; ` +
        're-verify before treating the terminal result as current.',
    };
  }

  const storedByPath = identityByPath(stored.contentIdentity);
  const currentByPath = identityByPath(current.contentIdentity);
  const samePaths =
    storedByPath &&
    currentByPath &&
    storedByPath.size === currentByPath.size &&
    [...storedByPath.keys()].every((path) => currentByPath.has(path));
  if (!samePaths || !storedByPath || !currentByPath) {
    return {
      verdict: 'stale',
      storedTreeStamp: stored,
      currentTreeStamp: current,
      reason: 'Current committed content identity covers a different declared path set; re-verify before trusting it.',
    };
  }

  for (const [path, storedEntry] of storedByPath) {
    const currentEntry = currentByPath.get(path)!;
    if (storedEntry.headBlobSha !== currentEntry.headBlobSha) {
      return {
        verdict: 'stale',
        storedTreeStamp: stored,
        currentTreeStamp: current,
        reason:
          `Committed content for ${path} changed between verification HEAD ${stored.headSha} and current HEAD ${current.headSha}; ` +
          're-verify before treating the terminal result as current.',
      };
    }
  }

  return {
    verdict: 'fresh',
    storedTreeStamp: stored,
    currentTreeStamp: current,
    reason:
      current.headSha === stored.headSha
        ? `Completion verification and current HEAD both resolve to ${current.headSha}.`
        : `Completion verification remains fresh across HEAD movement from ${stored.headSha} to ${current.headSha}; declared path content is unchanged.`,
  };
}
