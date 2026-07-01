/**
 * claude-sessions — find / search / read Claude Code chat transcripts
 * (~/.claude/projects/<encoded-cwd>/<session-id>.jsonl), the Claude-Code analogue
 * of omp-sessions.ts. Backs the dev:claude_session tool (EI-4911): there was no
 * first-class way to find a prior Claude session, so continuing one meant
 * hand-grepping hundreds of transcript JSONLs.
 *
 * Reliable core: LIST by cwd + recency (cheap — a bounded head-read for `cwd` +
 * the file mtime). Bonus: bounded content SEARCH (the transcript is a lossy,
 * non-canonical secondary — a final message is often not persisted verbatim, and
 * markers match incidentally; the code + work-item/plan ledger is the real source
 * of truth, so treat a search hit as a lead, not proof).
 *
 * Every fs entrypoint takes an optional `root` so tests point at a fixture dir
 * instead of the real $HOME.
 */

import { promises as fs } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';

export function defaultClaudeProjectsRoot(): string {
  return join(homedir(), '.claude', 'projects');
}

/**
 * Base dir holding per-session ISOLATED Claude configs:
 * ~/.papercusp/session-claude/<coord-owner-id>/ . psu/su CONSOLE sessions run
 * under a per-session CLAUDE_CONFIG_DIR keyed by the owner id, so their
 * transcripts live at <base>/<owner>/projects/<encoded-cwd>/<session-id>.jsonl —
 * NOT under ~/.claude/projects (EI-5790 / reference_session_launch_dirs_unified_keying).
 */
export function papercuspSessionClaudeBase(): string {
  return join(homedir(), '.papercusp', 'session-claude');
}

/**
 * Every Claude `projects/` root to scan: the global ~/.claude/projects PLUS each
 * per-session isolation root ~/.papercusp/session-claude/<owner>/projects. Without
 * the isolation roots, a psu/su console session is invisible to dev:claude_session
 * (the bug that made `su-…` console transcripts unfindable). Fail-soft: a missing
 * or unreadable isolation base yields the global root only. Params are injectable
 * for tests.
 */
export async function claudeProjectsRoots(
  globalRoot: string = defaultClaudeProjectsRoot(),
  isolationBase: string = papercuspSessionClaudeBase(),
): Promise<string[]> {
  const roots = [globalRoot];
  try {
    for (const owner of await fs.readdir(isolationBase)) {
      roots.push(join(isolationBase, owner, 'projects'));
    }
  } catch {
    // no isolation base (or unreadable) — global root only
  }
  return roots;
}

/**
 * Resolve the transcript jsonl for a Claude session by its id — the
 * `<session-id>.jsonl` handle, searched across every projects root (global +
 * per-session isolation). Returns the first match's absolute path, or null.
 * A targeted stat-only walk (readdir the project dirs, stat the one target file),
 * so it stays cheap even with thousands of transcripts. Powers the agents-roster
 * live-thinking view for INTERACTIVE (non-bee) sessions, which — unlike a
 * spawned bee's harness run-log — keep their timeline in this transcript.
 */
export async function findSessionTranscript(
  sessionId: string,
  roots?: string[],
): Promise<string | null> {
  if (!/^[A-Za-z0-9_.-]{6,}$/.test(sessionId)) return null;
  const file = `${sessionId}.jsonl`;
  for (const root of roots ?? (await claudeProjectsRoots())) {
    let projectDirs: string[];
    try {
      projectDirs = await fs.readdir(root);
    } catch {
      continue; // root unreadable
    }
    for (const projDir of projectDirs) {
      const p = join(root, projDir, file);
      try {
        await fs.access(p);
        return p;
      } catch {
        /* not in this project dir */
      }
    }
  }
  return null;
}

/**
 * Decode a Claude project dir name to a cwd hint. Claude encodes the cwd by
 * replacing '/' with '-', which is NOT invertible when a real path segment
 * contains a dash — so this is a FALLBACK hint only; prefer the `cwd` read from a
 * record (extractCwdFromHead).
 */
export function decodeProjectDir(name: string): string {
  return name.replace(/-/g, '/');
}

/** Pull the first `"cwd":"…"` out of a head chunk without a full JSON parse. */
export function extractCwdFromHead(head: string): string | null {
  const m = /"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(head);
  if (!m) return null;
  try {
    return JSON.parse(`"${m[1]}"`) as string;
  } catch {
    return m[1];
  }
}

interface TranscriptRecord {
  type?: string;
  cwd?: string;
  sessionId?: string;
  timestamp?: string;
  gitBranch?: string;
  message?: { role?: string; content?: unknown };
}

/** Extract plain text from a parsed record's message content (string or block array). */
export function recordText(rec: TranscriptRecord | null | undefined): string {
  const c = rec?.message?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c
      .map((b) => (b && typeof (b as { text?: unknown }).text === 'string' ? (b as { text: string }).text : ''))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

/** A trimmed snippet around the first case-insensitive match of `query` in `text`. */
export function firstMatchSnippet(text: string, query: string, radius = 90): { index: number; snippet: string } | null {
  if (!query) return null;
  const i = text.toLowerCase().indexOf(query.toLowerCase());
  if (i < 0) return null;
  const start = Math.max(0, i - radius);
  const end = Math.min(text.length, i + query.length + radius);
  const snippet =
    (start > 0 ? '…' : '') + text.slice(start, end).replace(/\s+/g, ' ').trim() + (end < text.length ? '…' : '');
  return { index: i, snippet };
}

export interface ClaudeSessionMeta {
  sessionId: string;
  filePath: string;
  cwd: string | null;
  lastActivityMs: number; // file mtime — the reliable recency signal
  sizeBytes: number;
}

const HEAD_BYTES = 32_768;

async function readHead(filePath: string, bytes = HEAD_BYTES): Promise<string> {
  const fh = await fs.open(filePath, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await fh.read(buf, 0, bytes, 0);
    return buf.subarray(0, bytesRead).toString('utf8');
  } finally {
    await fh.close();
  }
}

async function listJsonlFiles(root: string): Promise<{ dir: string; filePath: string }[]> {
  let dirs: string[];
  try {
    dirs = await fs.readdir(root);
  } catch {
    return [];
  }
  const out: { dir: string; filePath: string }[] = [];
  for (const d of dirs) {
    const full = join(root, d);
    try {
      const st = await fs.stat(full);
      if (!st.isDirectory()) continue;
      for (const f of await fs.readdir(full)) {
        if (f.endsWith('.jsonl')) out.push({ dir: d, filePath: join(full, f) });
      }
    } catch {
      // unreadable dir — skip, never fail the whole scan
    }
  }
  return out;
}

async function metaForFile(dir: string, filePath: string): Promise<ClaudeSessionMeta | null> {
  try {
    const st = await fs.stat(filePath);
    const head = await readHead(filePath).catch(() => '');
    const cwd = extractCwdFromHead(head) ?? (dir ? decodeProjectDir(dir) : null);
    return {
      sessionId: basename(filePath).replace(/\.jsonl$/, ''),
      filePath,
      cwd,
      lastActivityMs: st.mtimeMs,
      sizeBytes: st.size,
    };
  } catch {
    return null;
  }
}

/** All session metas under `root`, newest-first, optionally filtered by cwd substring. */
export async function allClaudeSessionMetas(opts: { root?: string; roots?: string[]; cwd?: string } = {}): Promise<ClaudeSessionMeta[]> {
  // Explicit roots/root win (tests); otherwise scan global + per-session isolation roots.
  const scanRoots = opts.roots ?? (opts.root ? [opts.root] : await claudeProjectsRoots());
  const fileLists = await Promise.all(scanRoots.map((r) => listJsonlFiles(r)));
  const files = fileLists.flat();
  const metas = (await Promise.all(files.map((f) => metaForFile(f.dir, f.filePath)))).filter(
    (m): m is ClaudeSessionMeta => m != null,
  );
  let rows = metas;
  if (opts.cwd) {
    const needle = opts.cwd.toLowerCase();
    rows = rows.filter((m) => (m.cwd ?? '').toLowerCase().includes(needle));
  }
  rows.sort((a, b) => b.lastActivityMs - a.lastActivityMs);
  return rows;
}

/** List sessions newest-first (bounded). The reliable "which session for project X around date Y" read. */
export async function listClaudeSessions(opts: { root?: string; roots?: string[]; cwd?: string; limit?: number } = {}): Promise<{
  sessions: ClaudeSessionMeta[];
  total: number;
  truncated: boolean;
}> {
  const limit = Math.min(Math.max(opts.limit ?? 30, 1), 200);
  const all = await allClaudeSessionMetas(opts);
  return { sessions: all.slice(0, limit), total: all.length, truncated: all.length > limit };
}

export interface ClaudeSessionMatch extends ClaudeSessionMeta {
  matchCount: number;
  snippet: string;
}

async function readUpTo(filePath: string, maxBytes: number): Promise<string> {
  const fh = await fs.open(filePath, 'r');
  try {
    const buf = Buffer.alloc(maxBytes);
    const { bytesRead } = await fh.read(buf, 0, maxBytes, 0);
    return buf.subarray(0, bytesRead).toString('utf8');
  } finally {
    await fh.close();
  }
}

/** Bounded content search across transcripts. Lossy by nature — see the module note. */
export async function searchClaudeSessions(opts: {
  root?: string;
  roots?: string[];
  query: string;
  cwd?: string;
  limit?: number;
  maxFilesScanned?: number;
  perFileMaxBytes?: number;
}): Promise<{ matches: ClaudeSessionMatch[]; filesScanned: number; filesTotal: number; truncated: boolean }> {
  const query = opts.query.trim();
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
  const maxFiles = Math.min(Math.max(opts.maxFilesScanned ?? 400, 1), 2000);
  const perFileMaxBytes = Math.min(Math.max(opts.perFileMaxBytes ?? 1_000_000, 1024), 5_000_000);
  if (!query) return { matches: [], filesScanned: 0, filesTotal: 0, truncated: false };

  const all = await allClaudeSessionMetas({ ...(opts.root ? { root: opts.root } : {}), ...(opts.roots ? { roots: opts.roots } : {}), ...(opts.cwd ? { cwd: opts.cwd } : {}) });
  const candidates = all.slice(0, maxFiles); // newest-first, so a scan cap keeps the most-relevant
  const q = query.toLowerCase();
  const matches: ClaudeSessionMatch[] = [];

  for (const meta of candidates) {
    let content: string;
    try {
      content = await readUpTo(meta.filePath, perFileMaxBytes);
    } catch {
      continue;
    }
    const lc = content.toLowerCase();
    let count = 0;
    let idx = lc.indexOf(q);
    while (idx >= 0) {
      count++;
      idx = lc.indexOf(q, idx + q.length);
    }
    if (count === 0) continue;
    // A clean snippet from the first matching record's text, falling back to raw.
    let snippet = '';
    for (const line of content.split('\n')) {
      if (!line.toLowerCase().includes(q)) continue;
      try {
        const s = firstMatchSnippet(recordText(JSON.parse(line) as TranscriptRecord), query);
        if (s) {
          snippet = s.snippet;
          break;
        }
      } catch {
        // not JSON / no text — keep scanning lines
      }
    }
    if (!snippet) snippet = firstMatchSnippet(content, query)?.snippet ?? '';
    matches.push({ ...meta, matchCount: count, snippet });
  }

  matches.sort((a, b) => b.matchCount - a.matchCount || b.lastActivityMs - a.lastActivityMs);
  return {
    matches: matches.slice(0, limit),
    filesScanned: candidates.length,
    filesTotal: all.length,
    truncated: matches.length > limit || all.length > candidates.length,
  };
}

export interface ClaudeTurn {
  i: number;
  type: string;
  role: string | null;
  ts: string | null;
  text: string;
}

/** Read one session into a compact, bounded turn list (the most-recent `limit` turns). */
export async function readClaudeSession(opts: { filePath: string; limit?: number }): Promise<{
  sessionId: string;
  cwd: string | null;
  gitBranch: string | null;
  firstTs: string | null;
  lastTs: string | null;
  totalRecords: number;
  turns: ClaudeTurn[];
  truncated: boolean;
} | null> {
  let raw: string;
  try {
    raw = await fs.readFile(opts.filePath, 'utf8');
  } catch {
    return null;
  }
  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 2000);
  const lines = raw.split('\n').filter(Boolean);
  let cwd: string | null = null;
  let gitBranch: string | null = null;
  let firstTs: string | null = null;
  let lastTs: string | null = null;
  const turns: ClaudeTurn[] = [];
  let i = 0;
  for (const ln of lines) {
    let rec: TranscriptRecord;
    try {
      rec = JSON.parse(ln) as TranscriptRecord;
    } catch {
      continue;
    }
    if (rec.cwd && !cwd) cwd = rec.cwd;
    if (rec.gitBranch && !gitBranch) gitBranch = rec.gitBranch;
    if (rec.timestamp) {
      if (!firstTs) firstTs = rec.timestamp;
      lastTs = rec.timestamp;
    }
    if (rec.type === 'user' || rec.type === 'assistant') {
      const text = recordText(rec);
      turns.push({
        i: i++,
        type: rec.type,
        role: rec.message?.role ?? null,
        ts: rec.timestamp ?? null,
        text: text.length > 2000 ? `${text.slice(0, 2000)}…` : text,
      });
    }
  }
  const truncated = turns.length > limit;
  return {
    sessionId: basename(opts.filePath).replace(/\.jsonl$/, ''),
    cwd,
    gitBranch,
    firstTs,
    lastTs,
    totalRecords: lines.length,
    turns: truncated ? turns.slice(-limit) : turns,
    truncated,
  };
}
