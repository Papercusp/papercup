/** Pure Git/source collection shared with the finite code-intelligence worker.
 * Keep database, provider registration and operator initialization out of this graph.
 */
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CloneIndex } from './clone-index';
import { buildSymbolSnapshot, relativeSymbolModule } from '../../../../scripts/lib/code-intel-symbol-snapshot.mjs';
import { eligibleHistoryPath } from './history-path';
import type { ReuseMetricPopulation } from './reuse-measurement';

const time = (value: string): number => {
  const n = Date.parse(value);
  if (!Number.isFinite(n)) throw new Error('Valid recorded timestamp required');
  return n;
};
const lowerBound = (values: readonly number[], value: number): number => {
  let low = 0, high = values.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (values[middle]! < value) low = middle + 1; else high = middle;
  }
  return low;
};

export type ReuseSourcePhase = 'source-tree' | 'source-capture' | 'source-diff' | 'source-clones' | 'source-calls';

/** Exact source population plus net added line identities, never a saved ratio.
 * Reuse the maintained clone floor/normalization and syntax-bound call resolver.
 * Non-JS/TS additions or unavailable clone sources keep redundancy unknown.
 */
export function buildReuseSourcePopulation(input: {
  addedLines: Readonly<Record<string, readonly number[]>>;
  complete: boolean;
  onProgress?: (phase: ReuseSourcePhase) => void;
} & ({ sources: readonly { path: string; source: string }[] } | {
  sourcePaths: readonly string[];
  readSource: (path: string) => string;
})) {
  // The Git collector supplies an immutable, disk-backed reader. Keep only
  // per-file clone records and syntax units, rather than the whole source tree.
  const sources = 'sources' in input ? new Map(input.sources.map(s => [s.path, s.source])) : null;
  const paths = ('sources' in input ? input.sources.map(s => s.path) : input.sourcePaths).filter(eligibleHistoryPath);
  if (new Set(paths).size !== paths.length) throw new Error('Duplicate source identity');
  const readSource = 'sources' in input ? (path: string) => sources!.get(path)! : input.readSource;
  const added = new Map(Object.entries(input.addedLines).filter(([path]) => eligibleHistoryPath(path)).map(([path, lines]) => {
    if (lines.some(n => !Number.isSafeInteger(n) || n < 1)) throw new Error('Positive added line identities required');
    return [path, [...new Set(lines)].sort((a, b) => a - b)] as const;
  }));
  const index = new CloneIndex({ includeNear: false });
  const addedByFunction = new Map<string, number[]>();
  input.onProgress?.('source-clones');
  for (const path of paths.filter(path => /\.tsx?$/.test(path))) {
    const source = readSource(path);
    const { file } = index.update({ path, source });
    const lineStarts = [0], lines = added.get(path) ?? [];
    for (let i = 0; i < source.length; i++) if (source.charCodeAt(i) === 10) lineStarts.push(i + 1);
    for (const fn of file.functions) {
      const end = lowerBound(lineStarts, Math.max(fn.start, fn.end - 1) + 1);
      addedByFunction.set(fn.id, lines.slice(lowerBound(lines, fn.line), lowerBound(lines, end + 1)));
    }
  }
  const duplicated = new Set<string>();
  const addedIn = (fn: { id: string }) => addedByFunction.get(fn.id)!;
  for (const family of index.families('renamed', { crossFile: false, includeTests: true })) {
    // Preserve an existing copy where possible. If every copy is added, the
    // lexicographically first location is the one necessary implementation.
    const members = [...family.members].sort((a, b) => Number(addedIn(a).length > 0) - Number(addedIn(b).length > 0)
      || a.path.localeCompare(b.path) || a.start - b.start);
    for (const member of members.slice(1)) for (const n of addedIn(member)) duplicated.add(`${member.path}:${n}`);
  }
  const files = paths.filter(path => /\.[cm]?[jt]sx?$/.test(path)), fileSet = new Set(files);
  input.onProgress?.('source-calls');
  const snapshot = buildSymbolSnapshot({ files, readSource,
    resolveModule: (path, specifier) => relativeSymbolModule(path, specifier, fileSet), includeCallCensus: true });
  return { addedNonGeneratedLines: [...added.values()].reduce((n, lines) => n + lines.length, 0),
    duplicateAddedLines: duplicated.size,
    lineCensusComplete: input.complete && index.getFiles().every(file => file.status === 'indexed' || file.status === 'excluded')
      && [...added.keys()].every(path => /\.tsx?$/.test(path)
      && index.getFile(path)?.status === 'indexed'),
    calls: (snapshot.callCensus ?? []) as ReuseMetricPopulation['calls'],
    callCensusComplete: input.complete && snapshot.stats.skippedFiles === 0 && !snapshot.stats.truncated,
    method: { cloneVersion: index.version, callKnowledge: snapshot.knowledge,
      sourcePopulation: [...paths].sort(), addedLinePopulation: [...added].map(([path, lines]) => ({ path, lines: [...lines].sort((a,b) => a-b) })),
      limitations: snapshot.limitations } };
}

/** Bounded immutable Git capture. Reading working-tree bytes would silently mix
 * today's source with yesterday's scheduled measurement window. Gitlinks remain
 * explicit unknowns here; no submodule's mutable checkout is substituted.
 */
export async function collectReuseSourcePopulation(root: string, start: string, end: string, captureRoot = tmpdir(),
  onProgress?: (phase: ReuseSourcePhase) => void) {
  if (time(start) >= time(end)) throw new Error('Valid half-open source window required');
  onProgress?.('source-tree');
  const gitBytes = (args: string[], input?: string) => new Promise<Buffer>((resolve, reject) => {
    const child = execFile('git', ['--literal-pathspecs', '-C', root, ...args], { encoding: 'buffer', timeout: 30_000,
      maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } },
    (error, stdout) => error ? reject(error) : resolve(stdout));
    child.stdin?.end(input);
  });
  const git = async (args: string[], input?: string) => (await gitBytes(args, input)).toString('utf8');
  const commitAt = async (at: string) => (await git(['rev-list', '--first-parent', '-1', `--before=${new Date(time(at) - 1).toISOString()}`, 'HEAD'])).trim();
  const [base, commit] = await Promise.all([commitAt(start), commitAt(end)]);
  if (!base || !commit || await git(['rev-parse', '--is-shallow-repository']).then(x => x.trim()) !== 'false')
    throw new Error('Complete source-window ancestry unavailable');
  const tree = (await git(['ls-tree', '-rlz', '--full-tree', commit])).split('\0').filter(Boolean).map(line => {
    const tab = line.indexOf('\t'), [mode, kind, blob, size] = line.slice(0, tab).trim().split(/\s+/);
    return { mode, kind, blob, size: Number(size), path: line.slice(tab + 1) };
  });
    const selected = tree.filter(s => s.kind === 'blob' && /^(100644|100755)$/.test(s.mode!)
      && eligibleHistoryPath(s.path) && /\.[cm]?[jt]sx?$/.test(s.path));
  if (selected.length > 25_000) throw new Error('Source population exceeds bounded collector');
  // Reuse the existing per-file parser bounds. A cumulative byte ceiling made
  // an otherwise supported repository permanently unmeasurable. Immutable
  // blobs spill to this invocation's private directory and are read one at a
  // time by both maintained indexes; no checkout or durable store is created.
  const capture = mkdtempSync(join(captureRoot, 'reuse-source-capture-'));
  const sourceFiles = new Map<string, string>();
  try {
    onProgress?.('source-capture');
    // Bound each chunk by bytes as well as identities. Sixteen small files per
    // process spent most of the finite worker budget repeatedly starting Git.
    for (let i = 0; i < selected.length;) {
      const batch: typeof selected = [];
      let bytes = 0;
      while (i < selected.length && batch.length < 256) {
        const entry = selected[i]!;
        if (!Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > 2_000_000)
          throw new Error('Incomplete bounded Git blob population');
        if (batch.length && bytes + entry.size > 32 * 1024 * 1024) break;
        batch.push(entry); bytes += entry.size; i++;
      }
      const out = await gitBytes(['cat-file', '--batch'], batch.map(s => s.blob).join('\n') + '\n');
      let offset = 0;
      for (const entry of batch) {
        const endHeader = out.indexOf(10, offset), [blob, kind, rawSize] = out.subarray(offset, endHeader).toString().split(' '), size = Number(rawSize);
        if (blob !== entry.blob || kind !== 'blob' || !Number.isSafeInteger(size) || size < 0 || size > 2_000_000
          || out[endHeader + 1 + size] !== 10) throw new Error('Incomplete bounded Git blob population');
        const file = join(capture, blob!);
        writeFileSync(file, out.subarray(endHeader + 1, endHeader + 1 + size));
        sourceFiles.set(entry.path, file);
        offset = endHeader + 2 + size;
      }
    }
    onProgress?.('source-diff');
    const rawChanges = (await git(['diff', '--raw', '-z', '--no-renames', base, commit])).split('\0');
    const changes = new Map<string, string>();
    for (let i = 0; i < rawChanges.length - 1; i += 2) {
      const status = /^:\d{6} \d{6} [0-9a-f]+ [0-9a-f]+ ([A-Z])$/.exec(rawChanges[i]!);
      const path = rawChanges[i + 1]!;
      if (!status || !path) throw new Error('Incomplete Git diff identity population');
      if (eligibleHistoryPath(path)) changes.set(path, status[1]!);
    }
    const paths = [...changes.keys()];
    const addedLines: Record<string, number[]> = {};
    const binaryChangedPaths: string[] = [];
    // NUL-delimited raw identities and their patches are emitted in the same
    // order. Never decode a path from a quoted patch heading. Bound each batch
    // and split only on output overflow, preserving the existing per-path cap.
    const readDiffs = async (batch: string[], expected: Map<string, number>): Promise<void> => {
      if (!batch.length) return;
      let output: string;
      try {
        output = await git(['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--unified=0',
          '--raw', '-z', '--patch', base, commit, '--', ...batch]);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' || batch.length < 2) throw error;
        const middle = Math.floor(batch.length / 2);
        await readDiffs(batch.slice(0, middle), expected); await readDiffs(batch.slice(middle), expected); return;
      }
      const boundary = output.indexOf('\0\0');
      if (boundary < 0) throw new Error('Incomplete Git diff identity population');
      const raw = output.slice(0, boundary).split('\0');
      const patches = output.slice(boundary + 2).split(/^diff --git /m).slice(1);
      const identities = raw.filter((_, index) => index % 2 === 1);
      if (raw.length !== batch.length * 2 || patches.length !== batch.length
        || new Set(identities).size !== batch.length || identities.some(path => !batch.includes(path)))
        throw new Error('Incomplete Git diff identity population');
      for (let i = 0; i < identities.length; i++) {
        const path = identities[i]!, patch = patches[i]!;
        const lines: number[] = [];
        for (const match of patch.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
          const first = Number(match[1]), count = match[2] === undefined ? 1 : Number(match[2]);
          for (let n = first; n < first + count; n++) lines.push(n);
        }
        if (lines.length !== expected.get(path)) throw new Error('Incomplete Git added-line population');
        if (lines.length) addedLines[path] = lines;
      }
    };
    const readChanges = async (batch: string[]): Promise<void> => {
      // New files have one exact contiguous added-line population. Numstat
      // supplies its size (and binary unknowns) without transferring gigabytes
      // of report bodies merely to discard everything except hunk headers.
      const stats = (await git(['diff', '--no-ext-diff', '--no-textconv', '--no-renames',
        '--unified=0', '--no-patch', '--numstat', '-z', base, commit, '--', ...batch])).split('\0').filter(Boolean);
      const seen = new Set<string>(), modified = new Map<string, number>();
      for (const stat of stats) {
        const first = stat.indexOf('\t'), second = stat.indexOf('\t', first + 1);
        const path = stat.slice(second + 1), added = stat.slice(0, first), removed = stat.slice(first + 1, second);
        if (first < 0 || second < 0 || !batch.includes(path) || seen.has(path))
          throw new Error('Incomplete Git diff identity population');
        seen.add(path);
        if (added === '-' && removed === '-') { binaryChangedPaths.push(path); continue; }
        const count = Number(added);
        if (!/^\d+$/.test(added) || !/^\d+$/.test(removed) || !Number.isSafeInteger(count))
          throw new Error('Incomplete Git added-line population');
        if (!count) continue;
        if (changes.get(path) === 'A') addedLines[path] = Array.from({ length: count }, (_, i) => i + 1);
        else modified.set(path, count);
      }
      if (seen.size !== batch.length) throw new Error('Incomplete Git diff identity population');
      await readDiffs([...modified.keys()], modified);
    };
    const chunks = Array.from({ length: Math.ceil(paths.length / 128) }, (_, i) => paths.slice(i * 128, (i + 1) * 128));
    let nextChunk = 0;
    const diffs = await Promise.allSettled(Array.from({ length: Math.min(4, chunks.length) }, async () => {
      while (nextChunk < chunks.length) await readChanges(chunks[nextChunk++]!);
    }));
    const failed = diffs.find(result => result.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
    // Concurrent completion order must not change the population identity.
    const orderedAddedLines = Object.fromEntries(paths.filter(path => addedLines[path]).map(path => [path, addedLines[path]!]));
    const population = buildReuseSourcePopulation({ sourcePaths: [...sourceFiles.keys()],
      readSource: path => readFileSync(sourceFiles.get(path)!, 'utf8'),
      addedLines: orderedAddedLines, complete: !tree.some(s => s.kind === 'commit'), onProgress });
    return { ...population,
      addedNonGeneratedLines: binaryChangedPaths.length ? null : population.addedNonGeneratedLines,
      duplicateAddedLines: binaryChangedPaths.length ? null : population.duplicateAddedLines,
      lineCensusComplete: population.lineCensusComplete && binaryChangedPaths.length === 0,
      method: { ...population.method,
        ...(binaryChangedPaths.length ? { binaryChangedPaths: binaryChangedPaths.sort() } : {}) },
      sourceRefs: [`git:${base}`, `git:${commit}`], base, commit };
  } finally { rmSync(capture, { recursive: true, force: true }); }
}
