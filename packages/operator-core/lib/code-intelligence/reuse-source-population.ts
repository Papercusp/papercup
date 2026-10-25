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

/** Exact source population plus net added line identities, never a saved ratio.
 * Reuse the maintained clone floor/normalization and syntax-bound call resolver.
 * Non-JS/TS additions or unavailable clone sources keep redundancy unknown.
 */
export function buildReuseSourcePopulation(input: {
  addedLines: Readonly<Record<string, readonly number[]>>;
  complete: boolean;
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
    return [path, new Set(lines)] as const;
  }));
  const index = new CloneIndex();
  const addedByFunction = new Map<string, number[]>();
  for (const path of paths.filter(path => /\.tsx?$/.test(path))) {
    const source = readSource(path);
    const { file } = index.update({ path, source });
    for (const fn of file.functions) {
      const start = source.slice(0, fn.start).split('\n').length;
      const end = source.slice(0, Math.max(fn.start, fn.end - 1)).split('\n').length;
      addedByFunction.set(fn.id, [...(added.get(path) ?? [])].filter(n => n >= start && n <= end));
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
  const snapshot = buildSymbolSnapshot({ files, readSource,
    resolveModule: (path, specifier) => relativeSymbolModule(path, specifier, fileSet), includeCallCensus: true });
  return { addedNonGeneratedLines: [...added.values()].reduce((n, lines) => n + lines.size, 0),
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
export async function collectReuseSourcePopulation(root: string, start: string, end: string, captureRoot = tmpdir()) {
  if (time(start) >= time(end)) throw new Error('Valid half-open source window required');
  const git = (args: string[], input?: string) => new Promise<string>((resolve, reject) => {
    const child = execFile('git', ['-C', root, ...args], { encoding: 'utf8', timeout: 30_000,
      maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } },
    (error, stdout) => error ? reject(error) : resolve(stdout));
    child.stdin?.end(input);
  });
  const commitAt = async (at: string) => (await git(['rev-list', '--first-parent', '-1', `--before=${new Date(time(at) - 1).toISOString()}`, 'HEAD'])).trim();
  const [base, commit] = await Promise.all([commitAt(start), commitAt(end)]);
  if (!base || !commit || await git(['rev-parse', '--is-shallow-repository']).then(x => x.trim()) !== 'false')
    throw new Error('Complete source-window ancestry unavailable');
  const tree = (await git(['ls-tree', '-rz', '--full-tree', commit])).split('\0').filter(Boolean).map(line => {
    const tab = line.indexOf('\t'), [mode, kind, blob] = line.slice(0, tab).split(' ');
    return { mode, kind, blob, path: line.slice(tab + 1) };
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
    for (let i = 0; i < selected.length; i += 16) {
      const batch = selected.slice(i, i + 16);
      const out = Buffer.from(await git(['cat-file', '--batch'], batch.map(s => s.blob).join('\n') + '\n'));
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
    const paths = (await git(['diff', '--name-only', '-z', '--no-renames', base, commit])).split('\0').filter(eligibleHistoryPath);
    const addedLines: Record<string, number[]> = {};
    const binaryChangedPaths: string[] = [];
    for (const path of paths) {
      const patch = await git(['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--unified=0', base, commit, '--', path]);
      // A binary diff cannot supply a line denominator. Retain that limitation
      // without discarding the independent syntax and assignment populations.
      if (patch.includes('Binary files ')) { binaryChangedPaths.push(path); continue; }
      const lines: number[] = [];
      for (const match of patch.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
        const first = Number(match[1]), count = match[2] === undefined ? 1 : Number(match[2]);
        for (let n = first; n < first + count; n++) lines.push(n);
      }
      if (lines.length) addedLines[path] = lines;
    }
    const population = buildReuseSourcePopulation({ sourcePaths: [...sourceFiles.keys()],
      readSource: path => readFileSync(sourceFiles.get(path)!, 'utf8'),
      addedLines, complete: !tree.some(s => s.kind === 'commit') });
    return { ...population,
      addedNonGeneratedLines: binaryChangedPaths.length ? null : population.addedNonGeneratedLines,
      duplicateAddedLines: binaryChangedPaths.length ? null : population.duplicateAddedLines,
      lineCensusComplete: population.lineCensusComplete && binaryChangedPaths.length === 0,
      method: { ...population.method,
        ...(binaryChangedPaths.length ? { binaryChangedPaths: binaryChangedPaths.sort() } : {}) },
      sourceRefs: [`git:${base}`, `git:${commit}`], base, commit };
  } finally { rmSync(capture, { recursive: true, force: true }); }
}
