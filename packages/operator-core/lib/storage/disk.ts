/**
 * On-disk store helpers for the Storage page (storage-settings-page-2026-06-15
 * P-003): root resolution, recursive sizing, top-level entry enumeration, and a
 * FAIL-CLOSED protected-set gather so a live/resumable agent session is never
 * collected.
 *
 * Session-dir trimming reuses the audited session-dir-gc planner (a dir is only
 * collectible once it is neither live nor resumable AND past the retention
 * window); this module just supplies the protected set + sizing. Server-only.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  defaultSessionDirRoots,
  discoverSessionDirCandidates,
  type SessionDirCandidate,
  type ProtectedSessionIdentity,
} from '../session-dir-gc';
import { scratchRoot } from '../scratch-uri';
import type { DiskStorageCategory } from './categories';

/** A top-level entry under a disk store: the unit a trim considers. */
export interface DiskEntry {
  /** absolute path of the entry (dir or file). */
  path: string;
  /** last-modified ms — the retention clock. */
  mtimeMs: number;
  /** recursive size in bytes (best-effort; see dirSizeBytes). */
  sizeBytes: number;
  /** session-dir protected-set key (owner id / session key); undefined for plain stores. */
  protectKey?: string;
  /** which protected dimension `protectKey` matches. */
  protectKeyKind?: SessionDirCandidate['keyKind'];
}

/** Whole-dir roots for the plain stores (session-dirs resolve via defaultSessionDirRoots;
 *  glob-files resolve via globRoot, NOT here — they never enumerate a whole dir). */
export function plainStoreRoots(store: 'scratch' | 'flight-recorder'): string[] {
  switch (store) {
    case 'scratch':
      return [scratchRoot()];
    case 'flight-recorder':
      return [join(homedir(), '.papercusp', 'flight-recorder')];
  }
}

/** Resolve a glob-files category's root from its rootKind (keeps categories.ts fs/os-free). */
function globRoot(rootKind: 'papercusp-home'): string {
  switch (rootKind) {
    case 'papercusp-home':
      return join(homedir(), '.papercusp');
  }
}

/**
 * Recursive byte size of a path. Iterative (no deep recursion), best-effort
 * (skips unreadable entries), and capped at `maxEntries` so a pathological tree
 * can never hang a settings read — a capped walk slightly under-counts, which is
 * acceptable for a usage display. A single file returns its own size.
 */
export function dirSizeBytes(path: string, maxEntries = 400_000): number {
  let total = 0;
  let seen = 0;
  const stack: string[] = [path];
  while (stack.length > 0) {
    if (seen >= maxEntries) break;
    const cur = stack.pop()!;
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(cur);
    } catch {
      continue; // raced removal / permission — skip
    }
    if (st.isDirectory()) {
      let names: string[];
      try {
        names = readdirSync(cur);
      } catch {
        continue;
      }
      for (const n of names) stack.push(join(cur, n));
    } else if (st.isFile()) {
      total += st.size;
      seen += 1;
    }
    // symlinks: statSync follows; a broken link throws → skipped above. We do not
    // descend into symlinked dirs twice because session-claude mirrors are symlinks
    // whose targets live outside the root — statSync on the link entry itself is a
    // dir/file of the target; to avoid double-counting the user's real ~/.claude we
    // only size what readdir yields under the store root.
  }
  return total;
}

/**
 * Enumerate the trim units of a disk category with size + mtime. For session-dirs
 * each candidate carries its protected-set key so a trim can exclude live
 * sessions; for plain stores each top-level child is one entry; for glob-files
 * ONLY the prefix+suffix-matching files under the resolved root (never the whole
 * root — e.g. ~/.papercusp holds everything).
 */
export function listDiskEntries(cat: DiskStorageCategory): DiskEntry[] {
  if (cat.store === 'session-dirs') {
    return discoverSessionDirCandidates(defaultSessionDirRoots()).map((c) => ({
      path: c.path,
      mtimeMs: c.mtimeMs,
      sizeBytes: dirSizeBytes(c.path),
      protectKey: c.key,
      protectKeyKind: c.keyKind,
    }));
  }
  if (cat.store === 'glob-files') {
    if (!cat.glob) return [];
    const root = globRoot(cat.glob.rootKind);
    const { prefix, suffix } = cat.glob;
    if (!existsSync(root)) return [];
    let names: string[];
    try {
      names = readdirSync(root);
    } catch {
      return [];
    }
    const out: DiskEntry[] = [];
    for (const name of names) {
      if (!name.startsWith(prefix) || !name.endsWith(suffix)) continue;
      const path = join(root, name);
      try {
        const st = statSync(path);
        if (!st.isFile()) continue; // glob-files matches FILES only
        out.push({ path, mtimeMs: st.mtimeMs, sizeBytes: st.size });
      } catch {
        continue;
      }
    }
    return out;
  }
  const out: DiskEntry[] = [];
  for (const root of plainStoreRoots(cat.store)) {
    if (!existsSync(root)) continue;
    let names: string[];
    try {
      names = readdirSync(root);
    } catch {
      continue;
    }
    for (const name of names) {
      const path = join(root, name);
      try {
        const st = statSync(path);
        out.push({ path, mtimeMs: st.mtimeMs, sizeBytes: dirSizeBytes(path) });
      } catch {
        continue; // raced removal — skip
      }
    }
  }
  return out;
}

export interface ProtectedGatherResult {
  ok: boolean;
  identity: ProtectedSessionIdentity;
}

/**
 * Gather the set of session identities that must NEVER be collected — the four
 * dimensions session-dir-gc documents: live coord_presence owners, non-terminal
 * spawned bees (`session_owner`), open adv_sessions (coord_owner + the session
 * key for codex homes), and active event_awaits (registered wakes). FAIL-CLOSED:
 * if any query throws we return ok:false so the caller refuses session-dir
 * deletion rather than sweeping with an empty (unsafe) protected set.
 */
export async function gatherProtectedSessionIdentity(
  sql: (strings: TemplateStringsArray, ...vals: unknown[]) => Promise<Array<Record<string, unknown>>>,
): Promise<ProtectedGatherResult> {
  const ownerIds = new Set<string>();
  const sessionKeys = new Set<string>();
  try {
    const presence = await sql`
      SELECT owner_id FROM harness_shared.coord_presence
       WHERE heartbeat_at > now() - interval '10 minutes'`;
    for (const r of presence) if (r.owner_id) ownerIds.add(String(r.owner_id));

    const bees = await sql`
      SELECT session_owner FROM harness_shared.spawned_agents
       WHERE session_owner IS NOT NULL AND finished_at IS NULL`;
    for (const r of bees) if (r.session_owner) ownerIds.add(String(r.session_owner));

    const adv = await sql`
      SELECT id, coord_owner_id FROM harness_shared.adv_sessions
       WHERE ended_at IS NULL`;
    for (const r of adv) {
      if (r.coord_owner_id) ownerIds.add(String(r.coord_owner_id));
      if (r.id != null) sessionKeys.add(String(r.id));
    }

    const awaits = await sql`
      SELECT subscriber_id FROM harness_shared.event_awaits
       WHERE fired_at IS NULL AND cancelled_at IS NULL`;
    for (const r of awaits) if (r.subscriber_id) ownerIds.add(String(r.subscriber_id));
  } catch {
    return { ok: false, identity: { ownerIds, sessionKeys } };
  }
  return { ok: true, identity: { ownerIds, sessionKeys } };
}
