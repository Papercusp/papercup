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
  headBlobs?: (
    repoRoot: string,
    headSha: string,
    paths: readonly string[],
  ) => ReadonlyMap<string, HeadBlobResolution> | undefined;
}

/**
 * WI-42441 — the HEAD side of one declared path, THREE-valued on purpose.
 *
 * The predecessor returned `ReadonlyMap<string, string | null>` and signalled
 * "not in the commit" by leaving the path OUT of the map. That overloads absence:
 * a submodule whose descent failed (not initialized — routine in a `git worktree`
 * checkout, WI-40231) dropped out of the map exactly like a path the commit really
 * does not carry. Downstream that became `missing-from-commit`, which reads as
 * "the closer declared a path that is not in the commit" and sends them to re-verify
 * a tree that was already correct.
 *
 * So every requested path now gets an entry, and the two failures are separate
 * constructors. This is the same discipline `candidate-contains.ts` already applies
 * to the gate's blob-containment read ("an ABSENCE must never read as a POSITIVE");
 * the two modules answer the same question about the same trees, and this one was
 * the half still conflating them.
 */
export type HeadBlobResolution =
  /** The commit carries this path, at this blob. */
  | { status: 'resolved'; sha: string }
  /** Definitively NOT in the commit — the tree was read, and the path is not in it. */
  | { status: 'absent' }
  /** The lookup could not answer. NEVER a verdict about the commit's contents. */
  | { status: 'unresolvable'; reason: string };

/** The blob sha when resolved, else null — for readers that only need the match test. */
export function headBlobShaOf(resolution: HeadBlobResolution | undefined): string | null {
  return resolution?.status === 'resolved' ? resolution.sha : null;
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

export function completionHeadBlobMap(
  repoRoot: string,
  headSha: string,
  paths: readonly string[],
): ReadonlyMap<string, HeadBlobResolution> | undefined {
  try {
    const runLsTree = (root: string, sha: string, selected?: readonly string[], recursive = true) =>
      execFileSync(
        'git',
        [
          '-C',
          root,
          'ls-tree',
          ...(recursive ? ['-r'] : []),
          '-z',
          sha,
          ...(selected?.length ? ['--', ...selected] : []),
        ],
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
    const result = new Map<string, HeadBlobResolution>();
    for (const [path, sha] of direct.blobs) result.set(path, { status: 'resolved', sha });

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
        for (const path of group.paths) {
          // A submodule we could not read answers NOTHING about the commit's contents.
          // Reporting it as absent is the WI-42441 conflation: it blames the closer for
          // a path the server merely failed to resolve.
          result.set(
            `${prefix}/${path}`,
            nested
              ? nested.get(path) ?? { status: 'absent' }
              : {
                  status: 'unresolvable',
                  reason:
                    `submodule '${prefix}' could not be read at ${group.sha.slice(0, 12)} ` +
                    `(not initialized in this checkout, or its object store is unreadable)`,
                },
          );
        }
      }
      // Anything still unaccounted for was read out of a tree that simply does not
      // carry it — the one case that IS a definitive negative.
      for (const path of missing) if (!result.has(path)) result.set(path, { status: 'absent' });
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
  const paths = [
    ...new Set(filesChanged.slice(0, MAX_PATHS_PROBED).map((path) => normalizedRepoPath(repositoryRoot, path))),
  ] as string[];
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
    const resolution = head.get(path);
    return {
      path,
      workingTreeBlobSha: bytes === undefined ? null : gitBlobSha(bytes, headSha.length),
      headBlobSha: headBlobShaOf(resolution),
      // Carried so the closer is told WHY, not just that it failed (WI-42441).
      ...(resolution?.status === 'unresolvable' ? { headBlobUnresolvable: resolution.reason } : {}),
    };
  });
}

/**
 * WI-42441: the declared paths whose HEAD side could not be READ, with the reason.
 *
 * Non-empty means the downgrade is the SERVER's resolution failure, not the closer's
 * tree hygiene — which is the difference between advice that can be followed and
 * advice that cannot. Deliberately narrow: a path that resolved and simply does not
 * match is NOT listed, because that one really is the closer's to fix.
 */
export function unresolvableContentIdentityPaths(
  stamp: { contentIdentity?: readonly CompletionTreeContentIdentity[] } | undefined | null,
): { path: string; headBlobUnresolvable: string }[] {
  return (stamp?.contentIdentity ?? []).flatMap((entry) =>
    entry.headBlobUnresolvable ? [{ path: entry.path, headBlobUnresolvable: entry.headBlobUnresolvable }] : [],
  );
}

/**
 * EI-21970667079827352 — WHICH declared paths failed content identity, and whether
 * WAITING can ever settle them.
 *
 * The `proposed` warning named the RULE ("could not prove that every declared path
 * has the same blob...") but never the FACT, and three situations produce that one
 * sentence: git-sync has not swept yet; ONE path of several missed the last tick (a
 * single logical change landing across two sweeps, routine on this tree); or a
 * declared path is misspelled / reverted / never existed. The first two settle
 * themselves; the third NEVER does. Indistinguishable from the text, the natural
 * move is to wait — which in the third case is an unbounded wait, on an item that
 * has already left the claimable pool, for something that cannot happen.
 *
 * `settles` is the field that matters, and it is derivable from identities the
 * server already computed:
 *  - a path present in the working tree but not yet in HEAD is mid-sweep      -> 'sweep'
 *  - a path whose two blobs merely DIFFER moved after the commit              -> 'sweep'
 *  - a path in NEITHER tree cannot become committed by any amount of waiting  -> 'never'
 *  - a path in HEAD but gone from the working tree is likewise unprovable     -> 'never'
 *
 * Entries carrying `headBlobUnresolvable` are deliberately EXCLUDED: that is the
 * server's own resolution failure (WI-42441), it already has its own reason-specific
 * remedy, and folding it in here would re-conflate the two opposite remedies that
 * type was split apart to keep separate.
 */
export type UnprovenContentIdentityReason =
  | 'missing-from-commit'
  | 'content-mismatch'
  | 'absent-from-both'
  | 'absent-from-working-tree';

export type UnprovenContentIdentityRow = {
  path: string;
  reason: UnprovenContentIdentityReason;
  settles: 'sweep' | 'never';
};

/**
 * EI-21970667079827352 — render the per-path facts as the remedy the caller should follow.
 *
 * Pure and exported so the SENTENCE is testable. It previously lived inline in a ~3,000-line
 * function with no seam, which is why the one thing the caller actually reads was the one
 * thing no test covered.
 *
 * The lead is always whether WAITING works, because that is the only branch where the
 * caller's next action differs: `sweep` means re-send the identical completion later,
 * `never` means the evidence itself is wrong and no amount of waiting fixes it.
 */
export function describeUnprovenContentIdentity(
  rows: readonly UnprovenContentIdentityRow[],
  declaredPathCount: number,
): string | undefined {
  if (rows.length === 0) return undefined;
  const render = (subset: readonly UnprovenContentIdentityRow[]) =>
    subset.map((row) => `\`${row.path}\` (${row.reason})`).join('; ');
  const willSettle = rows.filter((row) => row.settles === 'sweep');
  const neverSettles = rows.filter((row) => row.settles === 'never');
  const total = declaredPathCount > 0 ? declaredPathCount : rows.length;
  const head = `Content identity was not proven for ${rows.length} of ${total} declared \`filesChanged\` path(s): ${render(rows)}. `;
  const neverRemedy =
    `${render(neverSettles)} ${neverSettles.length === 1 ? 'is' : 'are'} absent from the working tree, so NO ` +
    `sweep can ever commit ${neverSettles.length === 1 ? 'it' : 'them'} — that is a misspelled, renamed, ` +
    `reverted, or never-created path in your completion evidence. Re-call work_items:complete for this id with ` +
    `the REAL path(s), never a plausible-looking guess.`;
  if (neverSettles.length === 0) {
    return (
      head +
      `WAITING SETTLES THIS — your evidence was accepted and nothing is wrong with your tree. Those path(s) are ` +
      `present in the working tree but not yet in the commit, and git-sync sweeps this tree on a schedule, so ONE ` +
      `logical change routinely lands across TWO ticks. The git-sync completion-settlement reconciler checks the ` +
      `recorded settlement manifest automatically after each emitted commit and upgrades this close to ` +
      `\`committed\` when those exact blobs land. Do not re-call \`work_items:complete\`, re-verify work that is ` +
      `already correct, or re-word the evidence.`
    );
  }
  if (willSettle.length === 0) {
    return head + `WAITING WILL NOT SETTLE THIS — do not sit on it. ${neverRemedy}`;
  }
  return (
    head +
    `MIXED — only one half is worth waiting on. ${render(willSettle)} will be checked automatically by the ` +
    `git-sync completion-settlement reconciler on the next sweep, ` +
    `but ${neverRemedy} Waiting alone leaves this close \`proposed\` indefinitely.`
  );
}

export function unprovenContentIdentityPaths(
  stamp: { contentIdentity?: readonly CompletionTreeContentIdentity[] } | undefined | null,
): UnprovenContentIdentityRow[] {
  return (stamp?.contentIdentity ?? []).flatMap((entry): UnprovenContentIdentityRow[] => {
    // The server could not READ the HEAD side — a different failure with a different
    // remedy, reported by unresolvableContentIdentityPaths. Not ours.
    if (entry.headBlobUnresolvable) return [];
    const inTree = entry.workingTreeBlobSha !== null;
    const inHead = entry.headBlobSha !== null;
    if (inTree && inHead) {
      return entry.workingTreeBlobSha === entry.headBlobSha
        ? [] // proven — this path is fine
        : [{ path: entry.path, reason: 'content-mismatch' as const, settles: 'sweep' as const }];
    }
    if (inTree && !inHead) {
      return [{ path: entry.path, reason: 'missing-from-commit' as const, settles: 'sweep' as const }];
    }
    if (!inTree && inHead) {
      return [{ path: entry.path, reason: 'absent-from-working-tree' as const, settles: 'never' as const }];
    }
    return [{ path: entry.path, reason: 'absent-from-both' as const, settles: 'never' as const }];
  });
}

export function completionTreeContentIdentityMatches(
  identity: readonly CompletionTreeContentIdentity[] | undefined,
): boolean {
  // WI-1409142: `!= null`, deliberately loose, so it rejects an ABSENT key as well as
  // an explicit null. Stored evidence really can arrive with these keys missing — a
  // recursive jsonb_strip_nulls used to delete them on write — and under strict `!==`
  // an entry missing BOTH keys read as PROVEN: `undefined !== null` is true twice, then
  // `undefined === undefined` matches. That is the one direction this floor must never
  // fail in, since it would mint `committed` authority from evidence the server never
  // actually observed.
  //
  // EI-21937921955988010: an `outOfRepoArtifact` entry is EXCLUDED from the floor
  // rather than failed by it. Such a path (an evidence screenshot under
  // ~/.papercusp/evidence/) belongs to no checkout, so blob identity is undefined for
  // it — not "unavailable". `verifiedHow: 'live-drove-ui'` requires citing exactly
  // those artifacts, so counting them unproven made UI-verified completions
  // permanently ineligible for `committed` no matter how clean the code side was.
  //
  // The floor stays conservative in the direction that matters: at least one
  // REPO-BACKED entry must exist and every repo-backed entry must match. A completion
  // citing only artifacts therefore still does NOT qualify — absence of provable code
  // evidence must never mint `committed`.
  const repoBacked = (identity ?? []).filter((entry) => entry.outOfRepoArtifact !== true);
  return Boolean(
    identity?.length &&
    repoBacked.length &&
    repoBacked.every(
      (entry) =>
        entry.workingTreeBlobSha != null &&
        entry.headBlobSha != null &&
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
      const identity = probe.filesChanged
        ? contentIdentity(repositoryRoot, head, probe.filesChanged, probe)
        : undefined;
      return identity ? { ...stamp, contentIdentity: identity } : stamp;
    }

    const ref = /^ref:\s*(.+)$/.exec(head)?.[1]?.trim();
    if (!ref) return undefined;

    const loose = readFile(nodePath.join(gitDir, ref))?.trim();
    if (loose && SHA_RE.test(loose)) {
      const stamp: CompletionTreeStamp = { repositoryRoot, headSha: loose };
      const identity = probe.filesChanged
        ? contentIdentity(repositoryRoot, loose, probe.filesChanged, probe)
        : undefined;
      return identity ? { ...stamp, contentIdentity: identity } : stamp;
    }

    const packed = readFile(nodePath.join(gitDir, 'packed-refs'));
    if (!packed) return undefined;
    for (const line of packed.split('\n')) {
      if (!line || line.startsWith('#') || line.startsWith('^')) continue;
      const [sha, name] = line.trim().split(/\s+/, 2);
      if (name === ref && sha && SHA_RE.test(sha)) {
        const stamp: CompletionTreeStamp = { repositoryRoot, headSha: sha };
        const identity = probe.filesChanged
          ? contentIdentity(repositoryRoot, sha, probe.filesChanged, probe)
          : undefined;
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
  headBlobs?: (
    repoRoot: string,
    headSha: string,
    paths: readonly string[],
  ) => ReadonlyMap<string, HeadBlobResolution> | undefined;
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
    const underPrimary = absolutePath === primaryRoot || absolutePath.startsWith(primaryRoot + nodePath.sep);

    // EI-21937921955988010: an ABSOLUTE path outside the primary checkout used to be
    // skipped here, which is precisely why a suite-app completion never acquired an
    // owning root: the apps live in independent checkouts under
    // ~/.papercusp-workspaces/<ws>/.papercusp/apps/*, so every one of their paths fell
    // through this `continue` and the stamp collapsed to the papercusp repo alone.
    // Walk up to the checkout that actually owns it, bounded by the path's own ancestor
    // chain exactly as the nested case is — this never walks a repository tree.
    if (!underPrimary && !nodePath.isAbsolute(declaredPath)) continue;

    let dir = nodePath.dirname(absolutePath);
    const stopAt = underPrimary ? primaryRoot : undefined;
    for (let depth = 0; depth < 64 && dir !== stopAt; depth += 1) {
      if (isCheckoutRoot(dir)) {
        nestedOwners.set(declaredPath, { absolutePath, root: dir });
        break;
      }
      const parent = nodePath.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }

  const candidateRoots = [...new Set([...roots, ...[...nestedOwners.values()].map(({ root }) => root)])];

  interface PathResolution {
    absolutePath: string;
    relativePath: string;
    /**
     * EI-21850619651553189: the SAME declared path re-resolved with a leading
     * `<repoName>/` segment stripped, when that segment names `root` by its own
     * directory basename — the conventional cross-repo form (`email/packages/...`,
     * matching how the file is named in prose, plan titles, and everywhere else)
     * rather than a path already relative to that repo's own root. Offered
     * ALONGSIDE `absolutePath`/`relativePath` above, never instead of them: a
     * plain relative path always resolves "inside" any root by construction
     * (`resolve(root, 'a/b')` can never escape `root`), so the plain form alone
     * cannot distinguish a real hit from a declared path that merely happens to
     * share this root's name as its first segment — only EXISTENCE can, which is
     * why this is a candidate for the caller to check, not a decision made here.
     */
    strippedAbsolutePath?: string;
    strippedRelativePath?: string;
  }

  const pathForRoot = (root: string, raw: string): PathResolution | undefined => {
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
    const relativePath = nodePath.relative(root, absolutePath).split(nodePath.sep).join('/');

    let strippedAbsolutePath: string | undefined;
    let strippedRelativePath: string | undefined;
    const prefix = `${nodePath.basename(root)}/`;
    if (declaredPath.startsWith(prefix)) {
      const stripped = declaredPath.slice(prefix.length);
      if (stripped) {
        const strippedAbs = nodePath.resolve(root, stripped);
        if (strippedAbs === root || strippedAbs.startsWith(root + nodePath.sep)) {
          strippedAbsolutePath = strippedAbs;
          strippedRelativePath = nodePath.relative(root, strippedAbs).split(nodePath.sep).join('/');
        }
      }
    }

    return { absolutePath, relativePath, strippedAbsolutePath, strippedRelativePath };
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
        const plainExists = exists(resolved.absolutePath);
        const strippedExists = !plainExists && resolved.strippedAbsolutePath && exists(resolved.strippedAbsolutePath);
        if (plainExists || strippedExists) {
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
    // EI-21937921955988010: on a TIE, a REGISTERED checkout outranks one that was merely
    // discovered by walking a declared path's ancestors. Now that a multi-repo completion
    // stamps every owning checkout, the top-level pair is only the PRIMARY identity — and
    // letting an unregistered suite-app checkout capture it (its absolute paths score
    // specificity while the registered root's relative ones score -1) would silently
    // re-point `completionSettlementManifest` and every freshness re-check at a repository
    // the system does not track. A discovered root still wins outright when it owns MORE
    // declared paths, which is what the nested-checkout case depends on.
    const registered = roots.includes(repoRoot);
    const selectedRegistered = roots.includes(selectedRoot);
    if (
      matches > selectedMatches ||
      (matches === selectedMatches &&
        registered === selectedRegistered &&
        absoluteSpecificity > selectedAbsoluteSpecificity) ||
      (matches === selectedMatches && registered && !selectedRegistered)
    ) {
      selectedRoot = repoRoot;
      selectedMatches = matches;
      selectedAbsoluteSpecificity = absoluteSpecificity;
    }
  }

  // Mirror the scoring loop's own preference: the stripped candidate wins only when
  // it is the one that actually exists and the plain form does not.
  const fileForRoot = (root: string, raw: string): string | undefined => {
    const resolved = pathForRoot(root, raw);
    if (!resolved) return normalizedRepoPath(root, raw);
    if (resolved.strippedRelativePath) {
      try {
        if (!exists(resolved.absolutePath) && exists(resolved.strippedAbsolutePath!)) {
          return resolved.strippedRelativePath;
        }
      } catch {
        /* fall through to the plain relativePath below */
      }
    }
    return resolved.relativePath;
  };

  /**
   * EI-21937921955988010: the checkout that OWNS a declared path, which is NOT always
   * `selectedRoot`. Previously every path was forced through `selectedRoot` and a
   * single unresolvable one discarded the ENTIRE stamp (the `validSelectedFiles`
   * all-or-nothing bail) — so a completion spanning the papercusp repo, two suite-app
   * checkouts and a handful of screenshot artifacts stored no stamp at all and closed
   * as `proposed` with no diagnostic naming which paths were the problem.
   */
  const ownerForPath = (raw: string): string | undefined => {
    const nested = nestedOwners.get(raw.trim());
    if (nested) return nested.root;
    // Mirror the scoring loop's tie rule EXACTLY: deepest-containing-checkout wins only
    // for an ABSOLUTE declared path (where containment is a real fact and a submodule
    // should stamp its own HEAD). A RELATIVE path resolves "inside" every root by
    // construction, so it retains the primary-root compatibility rule instead —
    // EI-20460682854560939, "legacy completions do not change repositories".
    const declaredIsAbsolute = nodePath.isAbsolute(raw.trim());
    let best: string | undefined;
    let bestSpecificity = -1;
    for (const repoRoot of candidateRoots) {
      const resolved = pathForRoot(repoRoot, raw);
      if (!resolved) continue;
      try {
        const plainExists = exists(resolved.absolutePath);
        const strippedExists =
          !plainExists && resolved.strippedAbsolutePath && exists(resolved.strippedAbsolutePath);
        if (!(plainExists || strippedExists)) continue;
      } catch {
        continue;
      }
      if (!declaredIsAbsolute) {
        // First match wins, and `selectedRoot` (scored primary) outranks any other.
        if (repoRoot === selectedRoot) return repoRoot;
        best ??= repoRoot;
        continue;
      }
      if (repoRoot.length > bestSpecificity) {
        best = repoRoot;
        bestSpecificity = repoRoot.length;
      }
    }
    if (best) return best;
    // A path that resolves INSIDE the primary checkout but does not exist is still that
    // checkout's to prove: recording it with a null identity is what keeps a missing
    // file reading as UNPROVEN rather than being excused as an out-of-repo artifact.
    return pathForRoot(selectedRoot, raw) ? selectedRoot : undefined;
  };

  const groups = new Map<string, string[]>();
  const artifactPaths: string[] = [];
  for (const raw of declared) {
    const declaredPath = raw.trim();
    // A glob or empty citation is INVALID, not an artifact. WI-312624 made the
    // fail-closed bail explicit for exactly this case; keep it.
    if (!declaredPath || declaredPath.includes('*') || declaredPath.includes('?')) return undefined;
    const owner = ownerForPath(raw);
    const file = owner ? fileForRoot(owner, raw) : undefined;
    if (!owner || !file) {
      artifactPaths.push(declaredPath);
      continue;
    }
    const group = groups.get(owner) ?? [];
    group.push(file);
    groups.set(owner, group);
  }

  const primaryStamp = completionTreeStamp({
    repoRoot: selectedRoot,
    readFile: probe.readFile,
    readBytes: probe.readBytes,
    headBlobs: probe.headBlobs,
    filesChanged: groups.get(selectedRoot) ?? [],
  });
  if (!primaryStamp) return undefined;

  const identity: CompletionTreeContentIdentity[] = [...(primaryStamp.contentIdentity ?? [])];
  for (const [repoRoot, files] of groups) {
    if (repoRoot === selectedRoot) continue;
    const stamp = completionTreeStamp({
      repoRoot,
      readFile: probe.readFile,
      readBytes: probe.readBytes,
      headBlobs: probe.headBlobs,
      filesChanged: files,
    });
    if (!stamp?.contentIdentity) {
      // That checkout's HEAD could not be read. Record ITS paths as unproven — with the
      // reason, per WI-42441 — instead of discarding every other repository's proof.
      for (const path of files) {
        identity.push({
          path,
          workingTreeBlobSha: null,
          headBlobSha: null,
          repositoryRoot: repoRoot,
          headBlobUnresolvable: `checkout '${repoRoot}' HEAD could not be read`,
        });
      }
      continue;
    }
    for (const entry of stamp.contentIdentity) {
      identity.push({ ...entry, repositoryRoot: repoRoot, headSha: stamp.headSha });
    }
  }
  for (const path of artifactPaths) {
    identity.push({ path, workingTreeBlobSha: null, headBlobSha: null, outOfRepoArtifact: true });
  }

  return identity.length
    ? { ...primaryStamp, contentIdentity: identity.slice(0, MAX_PATHS_PROBED) }
    : primaryStamp;
}

export type CompletionFreshnessVerdict = 'fresh' | 'stale' | 'unavailable' | 'not-applicable';

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
    if (!Array.isArray(rawIdentity) || rawIdentity.length === 0 || rawIdentity.length > MAX_PATHS_PROBED)
      return undefined;
    contentIdentity = [];
    for (const candidate of rawIdentity) {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return undefined;
      const entry = candidate as Record<string, unknown>;
      const path = typeof entry.path === 'string' ? entry.path.trim() : '';
      const workingTreeBlobSha = entry.workingTreeBlobSha;
      const headBlobSha = entry.headBlobSha;
      if (
        !path ||
        (workingTreeBlobSha !== null &&
          (typeof workingTreeBlobSha !== 'string' || !OBJECT_SHA_RE.test(workingTreeBlobSha))) ||
        (headBlobSha !== null && (typeof headBlobSha !== 'string' || !OBJECT_SHA_RE.test(headBlobSha)))
      )
        return undefined;
      contentIdentity.push({ path, workingTreeBlobSha, headBlobSha });
    }
  }
  return { repositoryRoot: nodePath.resolve(repositoryRoot), headSha, ...(contentIdentity ? { contentIdentity } : {}) };
}

function identityByPath(
  identity: readonly CompletionTreeContentIdentity[],
): Map<string, CompletionTreeContentIdentity> | undefined {
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
  const record = evidence as Record<string, unknown>;
  const stored = storedTreeStamp(record.treeStamp);
  if (!stored) return undefined;

  if (!stored.contentIdentity?.length) {
    // Pathless verification is a valid, measured completion shape (`already-passing`,
    // investigation, duplicate, or other no-file work). There is no content identity
    // to compare, so calling it "unavailable" falsely blames the observer for a signal
    // that is not applicable. Older writers dropped an explicit `filesChanged: []`, so
    // an omitted path list is included here; a non-empty list remains unavailable below.
    const filesChanged = record.filesChanged;
    if (filesChanged === undefined || (Array.isArray(filesChanged) && filesChanged.length === 0)) {
      return {
        verdict: 'not-applicable',
        storedTreeStamp: stored,
        reason: `No changed files were declared for ${stored.repositoryRoot}; completion freshness is not applicable.`,
      };
    }
    return {
      verdict: 'unavailable',
      storedTreeStamp: stored,
      reason: `Committed content identity was not recorded for ${stored.repositoryRoot}; completion freshness is not established.`,
    };
  }

  let current: CompletionTreeStamp | undefined;
  try {
    current = (
      probe.currentStamp ??
      ((stamp) =>
        completionTreeStamp({
          repoRoot: stamp.repositoryRoot,
          filesChanged: stamp.contentIdentity?.map((entry) => entry.path),
        }))
    )(stored);
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

  /**
   * WI-42441: a path whose HEAD side could not be READ makes the identity fail to match,
   * but `stale` is a claim ABOUT THE EVIDENCE ("it no longer describes this tree"), and we
   * have not established that. Saying stale here sends the reader to re-verify work that
   * may be perfectly current, which is the same misattribution this item fixed at the
   * close path. `unavailable` is the honest verdict for "could not check".
   */
  const unresolvable = [
    ...unresolvableContentIdentityPaths(current),
    ...unresolvableContentIdentityPaths(stored),
  ];
  if (unresolvable.length > 0) {
    return {
      verdict: 'unavailable',
      storedTreeStamp: stored,
      currentTreeStamp: current,
      reason:
        `Committed content could not be resolved for ${unresolvable
          .map((entry) => `${entry.path} (${entry.headBlobUnresolvable})`)
          .join('; ')}; completion freshness is not established. This is a resolution failure, not evidence of staleness.`,
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
      reason:
        'Current working-tree content does not match committed HEAD for every declared path; re-verify before trusting it.',
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
