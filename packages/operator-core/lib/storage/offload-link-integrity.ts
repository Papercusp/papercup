/** Link-safety companion to copy/checksum verification. Call under the offload's
 * existing quiescence/identity locks; this helper never copies or removes data.
 * Capture BEFORE moving the original, then verify the staged namespace and the
 * published destination before removing that original. A checksum of link text
 * alone cannot prove that a relocated link still reaches the same target.
 * Repeat source capture at cutover: path-prefix holder/pin checks cannot prove
 * quiescence when a regular file has another hard-link pathname outside the tree.
 */
import { lstat, opendir, readlink, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

interface LinkObservation {
  path: string;
  text: string;
  target: string | null;
}

export interface OffloadLinkSnapshot {
  sourceRoot: string;
  entriesVisited: number;
  links: Array<LinkObservation & { target: string }>;
}

export interface OffloadLinkScanOptions {
  /** Exhausting the budget throws; a partial scan is never a successful proof. */
  maxEntries?: number;
  signal?: AbortSignal;
}

export interface OffloadLinkViolation {
  path: string;
  reason: 'missing-link' | 'unexpected-link' | 'link-text-changed' | 'target-unresolved' | 'target-changed';
  expected?: string;
  actual?: string;
}

function within(root: string, target: string): boolean {
  const suffix = relative(root, target);
  return suffix === '' || (suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix));
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
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile()) {
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
  const observed = await scan(sourceRoot, options);
  const links = observed.links.map(link => {
    if (link.target === null) throw new Error(`Original offload link is unresolved: ${link.path}`);
    return { ...link, target: link.target };
  });
  return { sourceRoot: observed.root, entriesVisited: observed.entriesVisited, links };
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
