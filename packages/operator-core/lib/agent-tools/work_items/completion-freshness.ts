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
import type {
  CompletionTreeStamp,
  CompletionTreeContentIdentity,
  CompletionVerificationEvidence,
} from '../../coord-lifecycle/records';

const SHA_RE = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;
const MAX_PATHS_PROBED = 60;
const OBJECT_SHA_RE = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;

export type { CompletionTreeContentIdentity } from '../../coord-lifecycle/records';

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

function headBlobMap(repoRoot: string, headSha: string, paths: readonly string[]): ReadonlyMap<string, string | null> | undefined {
  try {
    const output = execFileSync('git', ['-C', repoRoot, 'ls-tree', '-r', '-z', headSha, '--', ...paths], {
      encoding: 'utf8',
      maxBuffer: 256 * 1024,
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const result = new Map<string, string | null>();
    for (const record of output.split('\0')) {
      if (!record) continue;
      const tab = record.indexOf('\t');
      if (tab < 0) continue;
      const [mode, type, sha] = record.slice(0, tab).split(/\s+/);
      const path = record.slice(tab + 1);
      if (type === 'blob' && mode && sha && OBJECT_SHA_RE.test(sha)) result.set(path, sha);
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
  const head = (probe.headBlobs ?? headBlobMap)(repositoryRoot, headSha, paths);
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
  const declared = (evidence.filesChanged ?? []).slice(0, MAX_PATHS_PROBED);
  let selectedRoot = roots[0]!;
  let selectedMatches = -1;

  for (const repoRoot of roots) {
    let matches = 0;
    for (const raw of declared) {
      const declaredPath = raw.trim();
      if (!declaredPath || declaredPath.includes('*') || declaredPath.includes('?')) continue;
      try {
        const abs = nodePath.resolve(repoRoot, declaredPath);
        if (abs !== repoRoot && !abs.startsWith(repoRoot + nodePath.sep)) continue;
        if (exists(abs)) matches += 1;
      } catch {
        // An unreadable candidate is not evidence that another checkout owns the file.
      }
    }
    if (matches > selectedMatches) {
      selectedRoot = repoRoot;
      selectedMatches = matches;
    }
  }

  return completionTreeStamp({
    repoRoot: selectedRoot,
    readFile: probe.readFile,
    readBytes: probe.readBytes,
    headBlobs: probe.headBlobs,
    filesChanged: declared,
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

  if (current.repositoryRoot !== stored.repositoryRoot || current.headSha !== stored.headSha) {
    return {
      verdict: 'stale',
      storedTreeStamp: stored,
      currentTreeStamp: current,
      reason:
        `Completion verification was observed at ${stored.headSha}, but current HEAD is ${current.headSha}; ` +
        're-verify before treating the terminal result as current.',
    };
  }

  return {
    verdict: 'fresh',
    storedTreeStamp: stored,
    currentTreeStamp: current,
    reason: `Completion verification and current HEAD both resolve to ${current.headSha}.`,
  };
}
