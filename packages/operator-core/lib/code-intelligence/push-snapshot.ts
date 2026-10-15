/** P-034: read the maintained first-party dependency snapshot, never a live compiler. */
import { readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
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

export function parsePushSnapshot(text: string, now = Date.now()): PushSnapshot | null {
  let raw;
  try { raw = JSON.parse(text); } catch { return null; }
  if (raw?.schema !== 'graph-dependency-snapshot-v1' || raw.index?.backend !== 'first-party-imports'
    || !/^[a-f0-9]{40,64}$/i.test(raw.index?.lastCommit ?? '') || !Array.isArray(raw.edges)) return null;
  const generatedMs = Date.parse(raw.generatedAt);
  if (!Number.isFinite(generatedMs) || now - generatedMs > PUSH_SNAPSHOT_MAX_AGE_MS || generatedMs - now > 300_000) return null;
  const reverse = new Map<string, Set<string>>();
  const hashes = new Map<string, string>();
  for (const edge of raw.edges) {
    if (!safeSnapshotPath(edge?.importer) || !safeSnapshotPath(edge?.imported)
      || !/^[a-f0-9]{64}$/i.test(edge.importerSha256 ?? '')) continue;
    const consumers = reverse.get(edge.imported) ?? new Set<string>();
    consumers.add(edge.importer); reverse.set(edge.imported, consumers);
    hashes.set(edge.importer, edge.importerSha256);
  }
  if (!reverse.size) return null;
  const byName = new Map<string, SnapshotSymbol[]>();
  const metadata = raw.symbols;
  const site = (value: any) => safeSnapshotPath(value?.path) && Number.isSafeInteger(value.line) && value.line > 0
    && Number.isSafeInteger(value.column) && value.column > 0 && /^[a-f0-9]{64}$/i.test(value.sha256 ?? '');
  if (metadata?.schema === 'code-intel-symbol-snapshot-v1' && metadata.knowledge === 'syntax-bound' && Array.isArray(metadata.symbols)) {
    for (const row of metadata.symbols) {
      if (!site(row) || typeof row.id !== 'string' || !/^[A-Za-z_$][\w$]*$/.test(row.name)
        || typeof row.signature !== 'string' || !Array.isArray(row.aliases) || !Array.isArray(row.callers)) continue;
      const symbol: SnapshotSymbol = { ...row, signature: row.signature.slice(0, 300),
        sources: Array.isArray(row.sources) && row.sources.length <= 512 && row.sources.every((source: any) =>
          safeSnapshotPath(source?.path) && /^[a-f0-9]{64}$/i.test(source.sha256 ?? '')) ? row.sources : undefined,
        aliases: row.aliases.filter((name: unknown) => typeof name === 'string' && /^[A-Za-z_$][\w$]*$/.test(name)),
        callers: row.callers.filter((caller: any) => site(caller) && typeof caller.spelling === 'string').slice(0, 500) };
      for (const name of new Set([symbol.name, ...symbol.aliases])) {
        const rows = byName.get(name) ?? []; rows.push(symbol); byName.set(name, rows);
      }
    }
  }
  return { commit: raw.index.lastCommit, generatedAt: raw.generatedAt, generatedMs,
    importers: new Map([...reverse].map(([path, paths]) => [path, [...paths].sort()])), hashes, symbols: byName };
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
    current.loading = readFile(dependencySnapshotPath(repo), 'utf8')
      .then(text => { current.snapshot = parsePushSnapshot(text); })
      .catch(error => { current.snapshot = null; if (error?.code !== 'ENOENT') console.warn('[code-intel-push] snapshot unavailable:', String(error).slice(0, 200)); })
      .finally(() => { current.loading = null; });
  }
  return entry.snapshot && now - entry.snapshot.generatedMs <= PUSH_SNAPSHOT_MAX_AGE_MS ? entry.snapshot : null;
}
