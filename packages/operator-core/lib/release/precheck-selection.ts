/** Durable selection evidence. Kept independent of the worker's TypeScript config reader. */
import { createHash } from 'node:crypto';
import { canonicalJson } from '@papercusp/hash-chain';

export interface PinnedTestExclusion {
  path: string;
  pattern: string;
  config: string;
  evidence: Array<{ path: string; blob: string }>;
}
export interface PinnedPrecheckSelection {
  schemaVersion: 1;
  commit: string;
  excluded: PinnedTestExclusion[];
  unavailable?: string;
}
export interface PinnedSelectionCursor { after?: string; limit?: number; identity?: string }

export function parsePinnedPrecheckSelection(value: unknown): PinnedPrecheckSelection | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const hash = (v: unknown): v is string => typeof v === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(v);
  const path = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v === v.trim() && !v.startsWith('/') && !v.includes('\\') && !v.includes('\0') && v.split('/').every(part => part !== '' && part !== '.' && part !== '..');
  if (row.schemaVersion !== 1 || !hash(row.commit) || !Array.isArray(row.excluded) || (row.unavailable !== undefined && typeof row.unavailable !== 'string')) return null;
  const excluded: PinnedTestExclusion[] = [], seen = new Set<string>();
  for (const value of row.excluded) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const entry = value as Record<string, unknown>;
    if (!path(entry.path) || seen.has(entry.path) || typeof entry.pattern !== 'string' || !path(entry.config) || !Array.isArray(entry.evidence) || !entry.evidence.length) return null;
    const evidence: PinnedTestExclusion['evidence'] = [];
    for (const value of entry.evidence) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
      const proof = value as Record<string, unknown>;
      if (!path(proof.path) || !hash(proof.blob)) return null;
      evidence.push({ path: proof.path, blob: proof.blob });
    }
    seen.add(entry.path);
    excluded.push({ path: entry.path, pattern: entry.pattern, config: entry.config, evidence });
  }
  return { schemaVersion: 1, commit: row.commit, excluded, ...(typeof row.unavailable === 'string' ? { unavailable: row.unavailable } : {}) };
}

export function pinnedSelectionPage(selection: PinnedPrecheckSelection, input: PinnedSelectionCursor = {}) {
  const identity = createHash('sha256').update(canonicalJson(selection)).digest('hex');
  if (input.identity !== undefined && input.identity !== identity) throw new Error('selection cursor is stale; restart from the first page');
  const limit = input.limit ?? 40;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new Error('selection page limit must be between 1 and 200');
  const after = input.after === undefined ? -1 : selection.excluded.findIndex(row => row.path === input.after);
  if (input.after !== undefined && after < 0) throw new Error('selection cursor path is absent; restart from the first page');
  const rows = selection.excluded.slice(after + 1, after + 1 + limit);
  const remaining = selection.excluded.length - after - 1 - rows.length;
  return { schemaVersion: 1 as const, commit: selection.commit, identity, total: selection.excluded.length, rows, remaining,
    next: remaining ? { after: rows.at(-1)!.path, identity, limit } : null };
}
