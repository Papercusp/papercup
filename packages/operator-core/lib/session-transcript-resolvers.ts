/**
 * session-transcript-resolvers — locate the on-disk transcript file for a
 * CODEX or OMP session, the non-claude legs of the agents-roster thinking pane
 * (claude resolution lives in claude-sessions.ts `findSessionTranscript`).
 *
 * Both resolvers are cheap bounded walks (a handful of readdirs, never an
 * all-owners sweep) and cache POSITIVE resolutions — a transcript path is
 * stable once written, so repeat opens cost one stat. Misses are NOT cached:
 * the thinking endpoint polls for a not-yet-written transcript (a live session
 * pre-first-turn) and must see it the moment it appears.
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { codexHomeForSessionKey } from '@papercusp/orchestrator/session-launch-dirs';

/** ~/.omp/agent/sessions — mirrors omp-sessions.ts (kept lazy for the same
 *  bundler reason: `homedir()` at module scope breaks the vite renderer stub). */
function defaultOmpSessionsRoot(): string {
  return join(homedir(), '.omp', 'agent', 'sessions');
}

const codexPathCache = new Map<string, string>();
const ompPathCache = new Map<string, string>();

/** Test seam. */
export function __resetTranscriptResolverCaches(): void {
  codexPathCache.clear();
  ompPathCache.clear();
}

async function statMtime(p: string): Promise<number | null> {
  try {
    return (await fs.stat(p)).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * The NEWEST codex rollout jsonl for a tracked codex session — codex keys its
 * per-session CODEX_HOME by the adv-session row id and writes rollouts at
 * `<home>/sessions/<yyyy>/<mm>/<dd>/rollout-<ts>-<uuid>.jsonl`. Newest-by-mtime
 * because a resumed session may add a second rollout file. Null until codex
 * takes its first turn (no sessions dir yet).
 */
export async function findCodexRolloutPath(
  sessionKey: string | number,
  opts: { homeOverride?: string } = {},
): Promise<string | null> {
  const cacheKey = String(sessionKey);
  const cached = codexPathCache.get(cacheKey);
  if (cached) {
    if ((await statMtime(cached)) !== null) return cached;
    codexPathCache.delete(cacheKey);
  }
  const root = join(opts.homeOverride ?? codexHomeForSessionKey(sessionKey), 'sessions');
  let best: { path: string; mtime: number } | null = null;
  // Bounded walk: sessions/<yyyy>/<mm>/<dd>/rollout-*.jsonl — one home, ≤4 levels.
  let years: string[];
  try {
    years = await fs.readdir(root);
  } catch {
    return null;
  }
  for (const y of years) {
    let months: string[];
    try {
      months = await fs.readdir(join(root, y));
    } catch {
      continue;
    }
    for (const m of months) {
      let days: string[];
      try {
        days = await fs.readdir(join(root, y, m));
      } catch {
        continue;
      }
      for (const d of days) {
        let files: string[];
        try {
          files = await fs.readdir(join(root, y, m, d));
        } catch {
          continue;
        }
        for (const f of files) {
          if (!f.startsWith('rollout-') || !f.endsWith('.jsonl')) continue;
          const p = join(root, y, m, d, f);
          const mtime = await statMtime(p);
          if (mtime !== null && (!best || mtime > best.mtime)) best = { path: p, mtime };
        }
      }
    }
  }
  if (best) codexPathCache.set(cacheKey, best.path);
  return best?.path ?? null;
}

/**
 * A codex rollout jsonl matched by its ROLLOUT UUID (the trailing uuid of
 * `rollout-<ts>-<uuid>.jsonl`) under the GLOBAL `~/.codex` home — the id the
 * session-turns transcript index keys codex turns by (session-ingest's codex
 * adapter), so a transcript-search hit can deep-link a codex session that has
 * no adv-session row key (agents-pill-inactive-search-2026-07-09 P-005).
 * Same bounded ≤4-level walk as findCodexRolloutPath; newest mtime wins when
 * the uuid somehow appears twice. Null when the rollout no longer exists.
 */
export async function findCodexRolloutPathByUuid(
  rolloutId: string,
  opts: { homeOverride?: string } = {},
): Promise<string | null> {
  if (!/^[0-9a-f][0-9a-f-]{7,}$/i.test(rolloutId)) return null;
  const cacheKey = `uuid:${rolloutId}`;
  const cached = codexPathCache.get(cacheKey);
  if (cached) {
    if ((await statMtime(cached)) !== null) return cached;
    codexPathCache.delete(cacheKey);
  }
  const root = join(opts.homeOverride ?? join(homedir(), '.codex'), 'sessions');
  const wanted = `-${rolloutId.toLowerCase()}.jsonl`;
  let best: { path: string; mtime: number } | null = null;
  let years: string[];
  try {
    years = await fs.readdir(root);
  } catch {
    return null;
  }
  for (const y of years) {
    let months: string[];
    try { months = await fs.readdir(join(root, y)); } catch { continue; }
    for (const m of months) {
      let days: string[];
      try { days = await fs.readdir(join(root, y, m)); } catch { continue; }
      for (const d of days) {
        let files: string[];
        try { files = await fs.readdir(join(root, y, m, d)); } catch { continue; }
        for (const f of files) {
          if (!f.startsWith('rollout-') || !f.toLowerCase().endsWith(wanted)) continue;
          const p = join(root, y, m, d, f);
          const mtime = await statMtime(p);
          if (mtime !== null && (!best || mtime > best.mtime)) best = { path: p, mtime };
        }
      }
    }
  }
  if (best) codexPathCache.set(cacheKey, best.path);
  return best?.path ?? null;
}

/**
 * "Actively thinking" proxies for the roster's pulsing indicator — the codex /
 * omp analogues of claude-sessions' isSessionThinking: the session's transcript
 * file was appended within `activeMs`. Best-effort; false when unresolvable.
 */
export async function isCodexSessionThinking(
  sessionKey: string | number,
  opts: { nowMs?: number; activeMs?: number; homeOverride?: string } = {},
): Promise<boolean> {
  const p = await findCodexRolloutPath(sessionKey, { homeOverride: opts.homeOverride });
  if (!p) return false;
  const mtime = await statMtime(p);
  if (mtime === null) return false;
  return (opts.nowMs ?? Date.now()) - mtime < (opts.activeMs ?? 10_000);
}

export async function isOmpThreadThinking(
  threadId: string,
  opts: { nowMs?: number; activeMs?: number; rootOverride?: string } = {},
): Promise<boolean> {
  const p = await findOmpSessionPath(threadId, { rootOverride: opts.rootOverride });
  if (!p) return false;
  const mtime = await statMtime(p);
  if (mtime === null) return false;
  return (opts.nowMs ?? Date.now()) - mtime < (opts.activeMs ?? 10_000);
}

/**
 * The omp session jsonl for a thread id — omp stores sessions as
 * `~/.omp/agent/sessions/<cwd-encoded>/<timestamp>_<session-id>.jsonl` and the
 * adv row's `omp_thread_id` IS that session id, so the file is found by suffix
 * across the (bounded, per-cwd) session dirs.
 */
export async function findOmpSessionPath(
  threadId: string,
  opts: { rootOverride?: string } = {},
): Promise<string | null> {
  if (!/^[A-Za-z0-9_-]{6,}$/.test(threadId)) return null;
  const cached = ompPathCache.get(threadId);
  if (cached) {
    if ((await statMtime(cached)) !== null) return cached;
    ompPathCache.delete(threadId);
  }
  const root = opts.rootOverride ?? defaultOmpSessionsRoot();
  const suffix = `_${threadId}.jsonl`;
  let cwdDirs: string[];
  try {
    cwdDirs = await fs.readdir(root);
  } catch {
    return null;
  }
  for (const dir of cwdDirs) {
    let files: string[];
    try {
      files = await fs.readdir(join(root, dir));
    } catch {
      continue;
    }
    for (const f of files) {
      if (f.endsWith(suffix)) {
        const p = join(root, dir, f);
        ompPathCache.set(threadId, p);
        return p;
      }
    }
  }
  return null;
}
