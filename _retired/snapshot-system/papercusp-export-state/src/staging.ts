/**
 * Filesystem walk + denylist staging — §15.5 step 5.
 *
 * Walks `projectDir` recursively, copies allowed files into
 * `<staging>/source/`, and records exclusions for the manifest.
 *
 * Pre-tarball size caps (§15.4) are enforced here, before tarball
 * composition begins, so we fail fast.
 */

import { promises as fs, createReadStream, createWriteStream } from 'node:fs';
import { join, relative, sep, dirname } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { effectiveDenylist, matchDeny, type CaptureOptions } from './denylist';

export interface StageEntry {
  /** Relative POSIX path under `source/`. */
  rel: string;
  /** Absolute source path on the substrate machine. */
  abs: string;
  /** File size in bytes. */
  bytes: number;
}

export interface StagedFs {
  files: StageEntry[];
  excluded: { path: string; reason: string }[];
  totalBytes: number;
}

const SOFT_CAP_BYTES = 200 * 1024 * 1024; // 200 MB — warn
const HARD_CAP_BYTES = 1024 * 1024 * 1024; // 1 GB — refuse

export class SnapshotTooLargeError extends Error {
  constructor(message: string, public bytes: number, public top: StageEntry[]) {
    super(message);
    this.name = 'SnapshotTooLargeError';
  }
}

export async function stageProjectFiles(args: {
  projectDir: string;
  stagingDir: string;
  capture?: CaptureOptions;
  /** Ignore the soft-cap warning (caller has accepted the size). */
  acceptSoftCap?: boolean;
  signal?: AbortSignal;
}): Promise<StagedFs> {
  const denylist = effectiveDenylist(args.capture);
  const sourceDir = join(args.stagingDir, 'source');
  await fs.mkdir(sourceDir, { recursive: true });

  // Phase 1: discover (no copy yet) so we can enforce caps before any I/O.
  const discovered: StageEntry[] = [];
  const excluded: { path: string; reason: string }[] = [];

  await walk(args.projectDir, args.projectDir, async (abs, rel, stat) => {
    if (args.signal?.aborted) throw new Error('aborted');
    const match = matchDeny(rel, denylist);
    if (match) {
      excluded.push({ path: rel, reason: match.reason });
      return 'skip';
    }
    if (stat.isFile()) {
      discovered.push({ rel, abs, bytes: stat.size });
    }
    return 'enter';
  });

  const totalBytes = discovered.reduce((s, e) => s + e.bytes, 0);
  if (totalBytes > HARD_CAP_BYTES) {
    discovered.sort((a, b) => b.bytes - a.bytes);
    throw new SnapshotTooLargeError(
      `snapshot exceeds 1 GB hard cap (${(totalBytes / 1e6).toFixed(1)} MB pre-compression)`,
      totalBytes,
      discovered.slice(0, 5),
    );
  }
  if (totalBytes > SOFT_CAP_BYTES && !args.acceptSoftCap) {
    discovered.sort((a, b) => b.bytes - a.bytes);
    throw new SnapshotTooLargeError(
      `snapshot exceeds 200 MB soft cap (${(totalBytes / 1e6).toFixed(1)} MB); pass acceptSoftCap to override`,
      totalBytes,
      discovered.slice(0, 5),
    );
  }

  // Phase 2: copy.
  for (const e of discovered) {
    if (args.signal?.aborted) throw new Error('aborted');
    const dest = join(sourceDir, ...e.rel.split('/'));
    await fs.mkdir(dirname(dest), { recursive: true });
    await pipeline(createReadStream(e.abs), createWriteStream(dest));
  }

  return { files: discovered, excluded, totalBytes };
}

type WalkVerdict = 'enter' | 'skip';

async function walk(
  root: string,
  dir: string,
  visit: (abs: string, rel: string, stat: import('node:fs').Stats) => Promise<WalkVerdict>,
): Promise<void> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw e;
  }
  for (const ent of entries) {
    const abs = join(dir, ent.name);
    let stat: import('node:fs').Stats;
    try {
      stat = await fs.lstat(abs);
    } catch {
      continue;
    }
    if (stat.isSymbolicLink()) continue;
    const rel = relative(root, abs).split(sep).join('/');
    const verdict = await visit(abs, rel, stat);
    if (verdict === 'skip') continue;
    if (stat.isDirectory()) {
      await walk(root, abs, visit);
    }
  }
}

/**
 * Copies `<projectDir>/.papercusp/<subset>` into `<staging>/state/harness/`,
 * then computes the union of paths captured.
 *
 * §15.4 — `state/harness/` carries `notes/`, `memory/`, `proposals/`,
 * `plan-review.md`, `validation-contract.md`. Other `.papercusp/` content
 * (snapshots staging, runs/) is excluded by the main denylist already.
 */
export async function stageHarnessSubset(args: {
  projectDir: string;
  stagingDir: string;
  capture?: CaptureOptions;
  signal?: AbortSignal;
}): Promise<StageEntry[]> {
  const harnessSrc = join(args.projectDir, '.papercusp');
  const harnessDest = join(args.stagingDir, 'state', 'harness');
  const out: StageEntry[] = [];

  // Subset of .papercusp/ to capture
  const subsetPatterns = [
    'notes',
    'memory',
    'proposals',
    'plan-review.md',
    'validation-contract.md',
  ];

  await fs.mkdir(harnessDest, { recursive: true });
  for (const sub of subsetPatterns) {
    const absSub = join(harnessSrc, sub);
    let stat: import('node:fs').Stats;
    try {
      stat = await fs.lstat(absSub);
    } catch {
      continue;
    }
    if (stat.isFile()) {
      const dest = join(harnessDest, sub);
      await pipeline(createReadStream(absSub), createWriteStream(dest));
      out.push({ rel: 'state/harness/' + sub, abs: absSub, bytes: stat.size });
    } else if (stat.isDirectory()) {
      await walk(absSub, absSub, async (abs, rel, st) => {
        if (args.signal?.aborted) throw new Error('aborted');
        if (!st.isFile()) return 'enter';
        const dest = join(harnessDest, sub, ...rel.split('/'));
        await fs.mkdir(dirname(dest), { recursive: true });
        await pipeline(createReadStream(abs), createWriteStream(dest));
        out.push({
          rel: 'state/harness/' + sub + '/' + rel,
          abs,
          bytes: st.size,
        });
        return 'enter';
      });
    }
  }
  return out;
}
