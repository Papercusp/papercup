/** Link-safety companion to copy/checksum verification. Call under the offload's
 * existing quiescence/identity locks; this helper never copies or removes data.
 * Capture BEFORE moving the original, then verify the staged namespace and the
 * published destination before removing that original. A checksum of link text
 * alone cannot prove that a relocated link still reaches the same target.
 * Repeat source capture at cutover: path-prefix holder/pin checks cannot prove
 * quiescence when a regular file has another hard-link pathname outside the tree.
 */
import { execFile } from 'node:child_process';
import { lstat, opendir, readdir, readlink, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

interface LinkObservation {
  path: string;
  text: string;
  target: string | null;
}

export interface OffloadLinkSnapshot {
  sourceRoot: string;
  entriesVisited: number;
  links: Array<LinkObservation & { target: string }>;
  /** Preserve the original logical Git namespace even after realpath changes. */
  gitPublication?: { repositoryRoot: string; ignoredPaths: string[] };
}

export interface OffloadLinkScanOptions {
  /** Exhausting the budget throws; a partial scan is never a successful proof. */
  maxEntries?: number;
  signal?: AbortSignal;
  /** Planned temporary/retained names must be ignored before any rename. */
  publicationPaths?: string[];
}

export interface OffloadLinkViolation {
  path: string;
  reason: 'missing-link' | 'unexpected-link' | 'link-text-changed' | 'target-unresolved' | 'target-changed' | 'git-publication-exposed';
  expected?: string;
  actual?: string;
}

function within(root: string, target: string): boolean {
  const suffix = relative(root, target);
  return suffix === '' || (suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix));
}

/** Check the original logical namespace, before realpath follows an earlier
 * offload. Git does not traverse a directory replaced by a symlink, even when
 * every underlying byte survives. Generated, untracked directories remain
 * eligible. Callers must hold the repository/index and offload identity locks.
 */
async function gitIgnored(repositoryRoot: string, path: string, options: OffloadLinkScanOptions): Promise<boolean> {
  if (!within(repositoryRoot, path) || path === repositoryRoot) throw new Error(`Git publication path outside repository: ${path}`);
  try {
    await promisify(execFile)('git', ['-C', repositoryRoot, 'check-ignore', '--quiet', '--no-index', '--',
      relative(repositoryRoot, path).split(sep).join('/')],
    { encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024, signal: options.signal });
    return true;
  } catch (error) {
    if ((error as { code?: unknown }).code === 1) return false;
    throw error;
  }
}

async function assertNoTrackedSource(sourceRoot: string, options: OffloadLinkScanOptions): Promise<OffloadLinkSnapshot['gitPublication']> {
  const logicalRoot = resolve(sourceRoot);
  for (let ancestor = logicalRoot; ; ancestor = dirname(ancestor)) {
    options.signal?.throwIfAborted();
    let repository = false;
    try {
      const marker = join(ancestor, '.git');
      const metadata = await lstat(marker);
      // Match committed-source-loader's narrow exemption: home ignore tooling
      // may create only .git/info/exclude without creating a checkout. Keep
      // damaged repositories and malformed worktree gitfiles fail-closed.
      const entries = metadata.isDirectory() ? await readdir(marker) : null;
      repository = entries === null || entries.length !== 1 || entries[0] !== 'info';
    }
    catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    }
    if (repository) {
      if (ancestor === logicalRoot) throw new Error(`Git source tree cannot use a symlink offload: ${logicalRoot}`);
      // Literal pathspecs also protect names containing Git wildcard syntax.
      // Errors, timeouts and output-budget exhaustion fail the preflight closed.
      const { stdout } = await promisify(execFile)('git', ['-C', ancestor, 'ls-files', '--cached', '-z', '--',
        `:(literal)${relative(ancestor, logicalRoot).split(sep).join('/')}`],
      { encoding: 'utf8', timeout: 30_000, maxBuffer: 8 * 1024 * 1024, signal: options.signal });
      if (stdout.length) throw new Error(`Git-tracked source cannot use a symlink offload: ${logicalRoot}`);
      const ignoredPaths: string[] = [];
      // Directory-only ignore rules can stop matching at symlink cutover.
      // Remember ignored originals and recheck their logical names on EVERY
      // verification, including when the caller verifies the physical copy.
      if (await gitIgnored(ancestor, logicalRoot, options)) ignoredPaths.push(logicalRoot);
      for (const path of options.publicationPaths ?? []) {
        const planned = resolve(path);
        if (!await gitIgnored(ancestor, planned, options)) throw new Error(`Git publication would expose offload path: ${planned}`);
        ignoredPaths.push(planned);
      }
      return { repositoryRoot: ancestor, ignoredPaths: [...new Set(ignoredPaths)] };
    }
    if (dirname(ancestor) === ancestor) return;
  }
}

async function scan(root: string, options: OffloadLinkScanOptions) {
  const maxEntries = options.maxEntries ?? 1_000_000;
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) throw new Error('maxEntries must be a positive safe integer');
  options.signal?.throwIfAborted();
  const canonicalRoot = await realpath(resolve(root));
  const links: LinkObservation[] = [];
  // As in retention allocation accounting, group multiply linked files by
  // device/inode. Here we need namespace containment rather than byte totals.
  const hardlinks = new Map<string, { path: string; nlink: number; seen: number }>();
  const pending = [''];
  let entriesVisited = 0;
  while (pending.length) {
    options.signal?.throwIfAborted();
    const directory = pending.pop()!;
    const fullDirectory = join(canonicalRoot, directory);
    const before = await lstat(fullDirectory);
    if (!before.isDirectory()) throw new Error(`Offload scan directory changed: ${fullDirectory}`);
    const stream = await opendir(fullDirectory);
    for await (const entry of stream) {
      options.signal?.throwIfAborted();
      if (++entriesVisited > maxEntries) throw new Error(`Offload link scan exceeded ${maxEntries} entries`);
      const path = join(directory, entry.name);
      if (entry.name === '.git') throw new Error(`Git source tree cannot use a symlink offload: ${path}`);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile()) {
        // Native custody consumers require every ancestor to be a real
        // directory. A checksum-preserving symlink offload still breaks them,
        // including packets nested below the selected source root.
        if (/^[a-f0-9]{64}\.native-proof\.json$/.test(entry.name)) {
          throw new Error(`Native proof custody cannot use a symlink offload: ${path}`);
        }
        const value = await lstat(join(canonicalRoot, path));
        if (!value.isFile()) throw new Error(`Offload file changed during observation: ${path}`);
        if (value.nlink > 1) {
          const key = `${value.dev}:${value.ino}`;
          const previous = hardlinks.get(key);
          if (previous && previous.nlink !== value.nlink) throw new Error(`Offload hard link changed during observation: ${path}`);
          if (previous) previous.seen += 1;
          else hardlinks.set(key, { path, nlink: value.nlink, seen: 1 });
        }
      } else if (entry.isSymbolicLink()) {
        const fullPath = join(canonicalRoot, path);
        const first = await lstat(fullPath);
        const text = await readlink(fullPath);
        let target: string | null;
        try { target = await realpath(fullPath); }
        catch (error) {
          // Broken links/cycles are an explicit failed proof; permission and IO
          // errors abort rather than pretending the remainder was observed.
          if (!['ENOENT', 'ENOTDIR', 'ELOOP'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
          target = null;
        }
        const last = await lstat(fullPath);
        if (first.dev !== last.dev || first.ino !== last.ino || first.ctimeMs !== last.ctimeMs) {
          throw new Error(`Offload link changed during observation: ${fullPath}`);
        }
        links.push({ path, text, target });
      }
    }
    const after = await lstat(fullDirectory);
    if (before.dev !== after.dev || before.ino !== after.ino || before.mtimeMs !== after.mtimeMs) {
      throw new Error(`Offload directory changed during observation: ${fullDirectory}`);
    }
  }
  for (const value of hardlinks.values()) {
    if (value.seen !== value.nlink) {
      throw new Error(`Offload file has external hard links: ${value.path} (${value.seen}/${value.nlink} links inside root)`);
    }
  }
  links.sort((a, b) => a.path.localeCompare(b.path));
  return { root: canonicalRoot, entriesVisited, links };
}

/** Snapshot every symlink, including external chains, without following linked
 * directories in the walk. Broken original targets fail closed. */
export async function captureOffloadLinks(sourceRoot: string, options: OffloadLinkScanOptions = {}): Promise<OffloadLinkSnapshot> {
  const gitPublication = await assertNoTrackedSource(sourceRoot, options);
  const observed = await scan(sourceRoot, options);
  const links = observed.links.map(link => {
    if (link.target === null) throw new Error(`Original offload link is unresolved: ${link.path}`);
    return { ...link, target: link.target };
  });
  return { sourceRoot: observed.root, entriesVisited: observed.entriesVisited, links,
    ...(gitPublication ? { gitPublication } : {}) };
}

/** Internal targets must reach the corresponding destination object; external
 * targets must retain their original canonical path. Both inventory and text
 * are checked as well, so missing/new links cannot silently disappear in a scan.
 * Namespace anchors outside destinationRoot can preserve outgoing relative links.
 */
export async function verifyOffloadLinks(snapshot: OffloadLinkSnapshot, destinationRoot: string,
  options: OffloadLinkScanOptions = {}) {
  const observed = await scan(destinationRoot, options);
  if (observed.root === snapshot.sourceRoot) throw new Error('Offload destination is the original source');
  const actual = new Map(observed.links.map(link => [link.path, link]));
  const violations: OffloadLinkViolation[] = [];
  for (const path of snapshot.gitPublication?.ignoredPaths ?? []) {
    if (!await gitIgnored(snapshot.gitPublication!.repositoryRoot, path, options)) {
      violations.push({ path, reason: 'git-publication-exposed' });
    }
  }
  for (const link of snapshot.links) {
    const found = actual.get(link.path);
    if (!found) { violations.push({ path: link.path, reason: 'missing-link' }); continue; }
    actual.delete(link.path);
    if (found.text !== link.text) violations.push({ path: link.path, reason: 'link-text-changed', expected: link.text, actual: found.text });
    const expected = within(snapshot.sourceRoot, link.target)
      ? join(observed.root, relative(snapshot.sourceRoot, link.target)) : link.target;
    if (found.target === null) violations.push({ path: link.path, reason: 'target-unresolved', expected });
    else if (found.target !== expected) violations.push({ path: link.path, reason: 'target-changed', expected, actual: found.target });
  }
  for (const path of actual.keys()) violations.push({ path, reason: 'unexpected-link' });
  return { ok: violations.length === 0, entriesVisited: observed.entriesVisited,
    checkedLinks: snapshot.links.length, violations };
}
