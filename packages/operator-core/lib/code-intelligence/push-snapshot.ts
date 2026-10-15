/** P-034: read the maintained first-party dependency snapshot, never a live compiler. */
import { readFile, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { addAbortSignal, Readable } from 'node:stream';
import { setImmediate as yieldToLoop } from 'node:timers/promises';
import { chain } from 'stream-chain';
import fun from 'stream-chain/fun.js';
import { parser } from 'stream-json';
import { pick } from 'stream-json/filters/pick.js';
import { streamValues } from 'stream-json/streamers/stream-values.js';
import { pinModuleState } from '@papercusp/module-singleton';
import { dependencySnapshotPath } from './dependency-snapshot-path';

export const PUSH_SNAPSHOT_MAX_AGE_MS = 24 * 60 * 60_000;
const REFRESH_MS = 60_000;
export const safeSnapshotPath = (value: unknown): value is string => typeof value === 'string'
  && value.length > 0 && value.length <= 4096 && !value.startsWith('/')
  && !/[\\\r\n\0]/.test(value) && !value.split('/').some(part => part === '..' || part === '.');

export interface PushSnapshot {
  commit: string;
  generatedAt: string;
  generatedMs: number;
  /** Static file imports, not symbol callers or proof of runtime execution. */
  importers: ReadonlyMap<string, readonly string[]>;
  hashes: ReadonlyMap<string, string>;
  symbols?: ReadonlyMap<string, readonly SnapshotSymbol[]>;
}

export interface SnapshotSymbol {
  id: string; name: string; path: string; line: number; column: number; sha256: string;
  signature: string; aliases: string[];
  /** Definition, forwarding modules and callers that underpin the snapshot answer. */
  sources?: { path: string; sha256: string }[];
  callers: { path: string; line: number; column: number; sha256: string; spelling: string; workspace?: string | null }[];
}

function snapshotBuilder() {
  const reverse = new Map<string, Set<string>>();
  const hashes = new Map<string, string>();
  const byName = new Map<string, SnapshotSymbol[]>();
  const addEdge = (edge: any) => {
    if (!safeSnapshotPath(edge?.importer) || !safeSnapshotPath(edge?.imported)
      || !/^[a-f0-9]{64}$/i.test(edge.importerSha256 ?? '')) return;
    const consumers = reverse.get(edge.imported) ?? new Set<string>();
    consumers.add(edge.importer); reverse.set(edge.imported, consumers);
    hashes.set(edge.importer, edge.importerSha256);
  };
  const site = (value: any) => safeSnapshotPath(value?.path) && Number.isSafeInteger(value.line) && value.line > 0
    && Number.isSafeInteger(value.column) && value.column > 0 && /^[a-f0-9]{64}$/i.test(value.sha256 ?? '');
  const addSymbol = (row: any) => {
    if (!site(row) || typeof row.id !== 'string' || !/^[A-Za-z_$][\w$]*$/.test(row.name)
      || typeof row.signature !== 'string' || !Array.isArray(row.aliases) || !Array.isArray(row.callers)) return;
    const symbol: SnapshotSymbol = { ...row, signature: row.signature.slice(0, 300),
      sources: Array.isArray(row.sources) && row.sources.length <= 512 && row.sources.every((source: any) =>
        safeSnapshotPath(source?.path) && /^[a-f0-9]{64}$/i.test(source.sha256 ?? '')) ? row.sources : undefined,
      aliases: row.aliases.filter((name: unknown) => typeof name === 'string' && /^[A-Za-z_$][\w$]*$/.test(name)),
      callers: row.callers.filter((caller: any) => site(caller) && typeof caller.spelling === 'string').slice(0, 500) };
    for (const name of new Set([symbol.name, ...symbol.aliases])) {
      const rows = byName.get(name) ?? []; rows.push(symbol); byName.set(name, rows);
    }
  };
  return { reverse, hashes, byName, addEdge, addSymbol };
}

function snapshotHeader(raw: any, now: number): { commit: string; generatedAt: string; generatedMs: number } | null {
  if (raw?.schema !== 'graph-dependency-snapshot-v1' || raw.index?.backend !== 'first-party-imports'
    || !/^[a-f0-9]{40,64}$/i.test(raw.index?.lastCommit ?? '') || !Array.isArray(raw.edges)) return null;
  const generatedMs = Date.parse(raw.generatedAt);
  if (!Number.isFinite(generatedMs) || now - generatedMs > PUSH_SNAPSHOT_MAX_AGE_MS || generatedMs - now > 300_000) return null;
  return { commit: raw.index.lastCommit, generatedAt: raw.generatedAt, generatedMs };
}

/** Small in-memory fixtures only; the serving loader below never parses a whole document. */
export function parsePushSnapshot(text: string, now = Date.now()): PushSnapshot | null {
  let raw;
  try { raw = JSON.parse(text); } catch { return null; }
  const header = snapshotHeader(raw, now);
  if (!header) return null;
  const builder = snapshotBuilder();
  for (const edge of raw.edges) builder.addEdge(edge);
  if (!builder.reverse.size) return null;
  if (raw.symbols?.schema === 'code-intel-symbol-snapshot-v1' && raw.symbols.knowledge === 'syntax-bound'
    && Array.isArray(raw.symbols.symbols)) {
    for (const row of raw.symbols.symbols) builder.addSymbol(row);
  }
  return { ...header, importers: new Map([...builder.reverse].map(([path, paths]) => [path, [...paths].sort()])),
    hashes: builder.hashes, symbols: builder.byName };
}

/** Row-wise assembly and bounded input chunks keep parsing AND indexing cooperative.
 * Only publish after EOF validates the complete JSON and metadata; partial/corrupt loads
 * never escape. Reuses the maintained stream-json parser rather than JSON.parse.
 */
export async function parsePushSnapshotStream(input: AsyncIterable<string>, now = Date.now(), signal?: AbortSignal): Promise<PushSnapshot | null> {
  const builder = snapshotBuilder();
  const metadata: any = {};
  let selected = '';
  let sawSymbols = false;
  let sliceStarted = performance.now();
  const cooperate = async () => {
    if (performance.now() - sliceStarted >= 4) {
      await yieldToLoop();
      sliceStarted = performance.now();
    }
  };
  async function* chunks() {
    for await (const chunk of input) {
      for (let offset = 0; offset < chunk.length; offset += 8192) {
        signal?.throwIfAborted();
        yield chunk.slice(offset, offset + 8192);
        await cooperate();
      }
    }
  }
  const pipeline = chain([
    Readable.from(chunks()),
    // Fuse synchronous token stages per bounded chunk. The default chain/gen
    // composition awaits each token; fun avoids millions of microtask hops.
    fun(
    parser({ streamValues: false }),
    pick({ filter: (path, token) => {
      const key = path.join('.');
      if (key === 'edges') metadata.edges = token?.name === 'startArray' ? [] : null;
      if (key === 'symbols.symbols') sawSymbols = token?.name === 'startArray';
      if (/^(schema|generatedAt|index|symbols\.schema|symbols\.knowledge|edges\.\d+|symbols\.symbols\.\d+)$/.test(key)) {
        selected = key;
        return true;
      }
      return false;
    } }),
    streamValues(),
    // Keep tagging synchronous with pick; async iteration may buffer multiple rows.
    (item: { value: unknown }) => ({ key: selected, value: item.value }),
    ),
  ]);
  if (signal) addAbortSignal(signal, pipeline);
  try {
    for await (const { key, value } of pipeline) {
      if (key.startsWith('edges.')) builder.addEdge(value);
      else if (key.startsWith('symbols.symbols.')) builder.addSymbol(value);
      else metadata[key] = value;
      await cooperate();
    }
    const header = snapshotHeader(metadata, now);
    if (!header || !builder.reverse.size) return null;
    if (!sawSymbols || metadata['symbols.schema'] !== 'code-intel-symbol-snapshot-v1'
      || metadata['symbols.knowledge'] !== 'syntax-bound') builder.byName.clear();
    const importers = new Map<string, string[]>();
    for (const [path, paths] of builder.reverse) {
      signal?.throwIfAborted();
      importers.set(path, [...paths].sort());
      await cooperate();
    }
    return { ...header, importers, hashes: builder.hashes, symbols: builder.byName };
  } catch {
    return null;
  } finally {
    pipeline.destroy();
  }
}

/** Bounded content checks, never a compiler or a synchronous read on the hook path.
 * A large proof, changed forwarding module or unreadable source suppresses the answer.
 */
export async function corroboratePushSources(root: string | undefined,
  sources: readonly { path: string; sha256: string }[], signal: AbortSignal): Promise<boolean> {
  if (!root || !sources.length || sources.length > 64 || signal.aborted) return false;
  let cursor = 0;
  let valid = true;
  await Promise.all(Array.from({ length: Math.min(8, sources.length) }, async () => {
    while (valid && !signal.aborted && cursor < sources.length) {
      const source = sources[cursor++]!;
      if (!safeSnapshotPath(source.path)) { valid = false; break; }
      try {
        const file = join(root, source.path);
        if ((await stat(file)).size > 2_000_000) { valid = false; break; }
        const bytes = await readFile(file, { signal });
        valid &&= createHash('sha256').update(bytes).digest('hex') === source.sha256;
      } catch { valid = false; }
    }
  }));
  return valid && !signal.aborted;
}

type Entry = { snapshot: PushSnapshot | null; checkedAt: number; loading: Promise<void> | null };
const state = pinModuleState('@papercusp/operator-core.code-intel-push-snapshots', () => ({ entries: new Map<string, Entry>() }));

/** Cold reads return immediately. One async load per repository; no timer or polling service. */
export function peekPushSnapshot(repo: string, now = Date.now()): PushSnapshot | null {
  let entry = state.entries.get(repo);
  if (!entry) {
    if (state.entries.size >= 8) state.entries.delete(state.entries.keys().next().value!);
    entry = { snapshot: null, checkedAt: -Infinity, loading: null }; state.entries.set(repo, entry);
  }
  if (!entry.loading && now - entry.checkedAt >= REFRESH_MS) {
    entry.checkedAt = now;
    const current = entry;
    current.loading = parsePushSnapshotStream(createReadStream(dependencySnapshotPath(repo), { encoding: 'utf8', highWaterMark: 8192 }))
      .then(snapshot => { current.snapshot = snapshot; })
      .catch(error => { current.snapshot = null; if (error?.code !== 'ENOENT') console.warn('[code-intel-push] snapshot unavailable:', String(error).slice(0, 200)); })
      .finally(() => { current.loading = null; });
  }
  return entry.snapshot && now - entry.snapshot.generatedMs <= PUSH_SNAPSHOT_MAX_AGE_MS ? entry.snapshot : null;
}
