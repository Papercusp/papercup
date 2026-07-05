/**
 * Session-transcript ingest — the episodic verbatim index feeder
 * (session-search-scope-2026-07-05 P-003 / D-003; compaction-context-loss
 * D-001 "index, don't summarize harder").
 *
 * ONE `harness_shared.session_turns` table fed by an ADAPTER REGISTRY:
 *   * `claude`      — Claude Code JSONL (~/.claude/projects/** and the psu
 *                     isolation dirs ~/.papercusp/session-claude/<owner>/projects/**)
 *   * `omp`         — OMP JSONL (~/.omp/agent/sessions/<munged-cwd>/*.jsonl)
 *   * `codex`       — Codex rollouts (~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl)
 *   * `agent_chat`  — harness_shared.agent_chats_consolidated transcript JSONB
 *
 * Design invariants:
 *   * INCREMENTAL: per-file (source_kind, file_path) → byte_offset bookkeeping
 *     in session_ingest_state; JSONL is append-only so tailing is cheap. Only
 *     COMPLETE lines are consumed (a partially-flushed last line waits for the
 *     next tick).
 *   * BOUNDED per tick: file/turn/byte caps below — the corpus is ~23k files /
 *     ~10 GB on a mature box, so a tick NEVER tries to swallow history in one
 *     go; the tailer converges across ticks (newest-mtime first, so recent
 *     sessions — the ones agents actually search — index first).
 *   * TEXT TURNS ONLY (v1): user + assistant text parts. Tool results /
 *     thinking blocks are bulk noise for recall (tool calls already live in
 *     tool_invocations); the full source line remains on disk for
 *     sessions:read.
 *   * TRUNCATED + REDACTED at ingest: 8k chars/turn; common secret shapes
 *     scrubbed. The index is for recall, not archival — the JSONL is the
 *     archive.
 *   * COMPACTION-SAFE by construction: compaction never deletes the JSONL, so
 *     the index can never lose pre-compaction turns; `ingestFileNow` gives the
 *     read-time freshness guarantee (self live-tail) client-neutrally
 *     (compaction-context-loss D-002 — hooks are optimizations, not
 *     dependencies).
 *   * Embeddings are NOT computed here — the embed-backfill sweep
 *     (search/embed-backfill.ts, bench admission lane) fills
 *     `text_embedding` asynchronously; ingest must never block on network.
 */

import { open, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, basename } from 'node:path';
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { getFlag } from '@papercusp/flags/server';
import { FLAGS } from '@papercusp/flags';

/** How far back a source file's mtime may be and still get ingested. */
const INGEST_WINDOW_DAYS = 45;
/** Retention for indexed turns (the JSONL remains the archive past this). */
const RETENTION_DAYS = 45;
/** Per-tick caps — the tailer converges across ticks, never gulps. */
const MAX_FILES_PER_TICK = 200;
const MAX_TURNS_PER_TICK = 4000;
const MAX_BYTES_PER_FILE_PER_TICK = 5 * 1024 * 1024;
const MAX_CHATS_PER_TICK = 50;
/** Per-turn text cap (chars). */
const TEXT_CAP = 8000;
/** Skip micro-turns ("ok", "y") — noise for recall. */
const MIN_TEXT_LEN = 3;

export type SourceKind = 'claude' | 'omp' | 'codex' | 'agent_chat';

export interface ParsedTurn {
  ts: Date | null;
  speaker: 'user' | 'assistant';
  text: string;
  cwd?: string | null;
  sessionId?: string | null;
}

export interface IngestStats {
  filesScanned: number;
  filesIngested: number;
  turnsInserted: number;
  chatsIngested: number;
  errors: number;
  durationMs: number;
  skipped?: string;
}

/** Common credential shapes scrubbed at ingest (defense-in-depth — transcripts
 * can contain pasted secrets; the INDEX must not become a secret store). */
const SECRET_RE =
  /\b(sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{40,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,})\b/g;

/** Injected boilerplate prefixes that would pollute recall — not real speech. */
const BOILERPLATE_PREFIXES = [
  '<system-reminder',
  '<local-command',
  '<command-name',
  '<user_instructions>',
  '<permissions instructions>',
  '<environment_context>',
  'Caveat: The messages below',
];

function cleanTurnText(raw: string): string | null {
  const t = raw.trim();
  if (t.length < MIN_TEXT_LEN) return null;
  for (const p of BOILERPLATE_PREFIXES) if (t.startsWith(p)) return null;
  return t.slice(0, TEXT_CAP).replace(SECRET_RE, '[redacted]');
}

/** Join the text parts of a message content (string or parts array). */
export function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const p of content) {
    if (!p || typeof p !== 'object') continue;
    const part = p as { type?: string; text?: string };
    if (typeof part.text !== 'string') continue;
    if (part.type === 'text' || part.type === 'input_text' || part.type === 'output_text') {
      parts.push(part.text);
    }
  }
  return parts.join('\n');
}

function parseTs(v: unknown): Date | null {
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/* ------------------------------------------------------------------ */
/* Per-client line parsers (exported for unit tests)                    */
/* ------------------------------------------------------------------ */

/** Claude Code line → turn. Lines: {type:'user'|'assistant', message:{role,content}, timestamp, cwd, sessionId}. */
export function parseClaudeLine(line: string): ParsedTurn | null {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (obj.type !== 'user' && obj.type !== 'assistant') return null;
  const message = obj.message as { role?: string; content?: unknown } | undefined;
  if (!message) return null;
  const speaker = message.role === 'user' ? 'user' : message.role === 'assistant' ? 'assistant' : null;
  if (!speaker) return null;
  const text = cleanTurnText(textFromContent(message.content));
  if (!text) return null;
  return {
    ts: parseTs(obj.timestamp),
    speaker,
    text,
    cwd: typeof obj.cwd === 'string' ? obj.cwd : null,
    sessionId: typeof obj.sessionId === 'string' ? obj.sessionId : null,
  };
}

/** OMP line → turn. Lines: {type:'message', timestamp, message:{role, content:[{type:'text',text}]}}. */
export function parseOmpLine(line: string): ParsedTurn | null {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (obj.type !== 'message') return null;
  const message = obj.message as { role?: string; content?: unknown } | undefined;
  if (!message) return null;
  const speaker = message.role === 'user' ? 'user' : message.role === 'assistant' ? 'assistant' : null;
  if (!speaker) return null;
  const text = cleanTurnText(textFromContent(message.content));
  if (!text) return null;
  return { ts: parseTs(obj.timestamp), speaker, text };
}

/** Codex rollout line → turn. Lines: {timestamp, type:'response_item', payload:{type:'message', role, content:[{type:'input_text'|'output_text', text}]}}. */
export function parseCodexLine(line: string): ParsedTurn | null {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (obj.type !== 'response_item') return null;
  const payload = obj.payload as { type?: string; role?: string; content?: unknown } | undefined;
  if (!payload || payload.type !== 'message') return null;
  const speaker = payload.role === 'user' ? 'user' : payload.role === 'assistant' ? 'assistant' : null;
  if (!speaker) return null; // 'developer'/'system' = injected instructions, skip
  const text = cleanTurnText(textFromContent(payload.content));
  if (!text) return null;
  return { ts: parseTs(obj.timestamp), speaker, text };
}

/* ------------------------------------------------------------------ */
/* Adapter registry                                                     */
/* ------------------------------------------------------------------ */

/** A transcript root + how many DIRECTORY levels sit between it and the
 * .jsonl files. Depth-bounded traversal is load-bearing: a blind
 * `readdir({recursive:true})` over ~/.papercusp/session-claude descends into
 * 15k+ per-session Claude-config clones (statsig caches, todos, …) — millions
 * of dentries, observed HANGING the sweep for minutes (2026-07-05). The
 * transcript layouts are fixed-shape, so we only walk the known levels. */
interface RootSpec {
  root: string;
  dirDepth: number;
}

interface FileAdapter {
  sourceKind: Exclude<SourceKind, 'agent_chat'>;
  roots: () => RootSpec[];
  parseLine: (line: string) => ParsedTurn | null;
  /** Best-effort provenance derived from the file path. */
  meta: (filePath: string) => { sessionId: string; owner: string | null };
}

const HOME = homedir();

export const FILE_ADAPTERS: FileAdapter[] = [
  {
    sourceKind: 'claude',
    roots: () => [
      // ~/.claude/projects/<munged-cwd>/<uuid>.jsonl
      { root: join(HOME, '.claude', 'projects'), dirDepth: 1 },
      // ~/.papercusp/session-claude/<ownerId>/projects/<munged-cwd>/<uuid>.jsonl
      { root: join(HOME, '.papercusp', 'session-claude'), dirDepth: 3 },
    ],
    parseLine: parseClaudeLine,
    meta: (filePath) => {
      // psu isolation dir carries the launching session's owner dir:
      // ~/.papercusp/session-claude/<ownerDir>/projects/<munged-cwd>/<uuid>.jsonl
      const m = filePath.match(/\/session-claude\/([^/]+)\//);
      return { sessionId: basename(filePath, '.jsonl'), owner: m ? m[1] : null };
    },
  },
  {
    sourceKind: 'omp',
    // ~/.omp/agent/sessions/<munged-cwd>/<ts>_<uuid>.jsonl
    roots: () => [{ root: join(HOME, '.omp', 'agent', 'sessions'), dirDepth: 1 }],
    parseLine: parseOmpLine,
    meta: (filePath) => {
      // <ts>_<uuid>.jsonl — the uuid is the session id.
      const stem = basename(filePath, '.jsonl');
      const us = stem.indexOf('_');
      return { sessionId: us >= 0 ? stem.slice(us + 1) : stem, owner: null };
    },
  },
  {
    sourceKind: 'codex',
    // ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl
    roots: () => [{ root: join(HOME, '.codex', 'sessions'), dirDepth: 3 }],
    parseLine: parseCodexLine,
    meta: (filePath) => {
      // rollout-<ts>-<uuid>.jsonl → uuid tail is the session id.
      const stem = basename(filePath, '.jsonl');
      const m = stem.match(/([0-9a-f]{8}-[0-9a-f-]{27,})$/i);
      return { sessionId: m ? m[1] : stem, owner: null };
    },
  },
];

/** Collect *.jsonl exactly `dirDepth` directory levels under `root` (BFS,
 * never descending past the known layout — see RootSpec). */
async function jsonlAtDepth(root: string, dirDepth: number): Promise<string[]> {
  let dirs = [root];
  for (let d = 0; d < dirDepth; d += 1) {
    const next: string[] = [];
    for (const dir of dirs) {
      try {
        for (const e of await readdir(dir, { withFileTypes: true })) {
          if (e.isDirectory()) next.push(join(dir, e.name));
        }
      } catch { /* absent / raced — skip */ }
    }
    dirs = next;
    if (!dirs.length) return [];
  }
  const files: string[] = [];
  for (const dir of dirs) {
    try {
      for (const e of await readdir(dir, { withFileTypes: true })) {
        if (e.isFile() && e.name.endsWith('.jsonl')) files.push(join(dir, e.name));
      }
    } catch { /* skip */ }
  }
  return files;
}

/* ------------------------------------------------------------------ */
/* Tailer                                                               */
/* ------------------------------------------------------------------ */

interface TurnRow {
  workspace_id: string;
  source_kind: string;
  session_id: string;
  turn_idx: number;
  /** ISO string — postgres-js's sql(rows) bulk-insert helper rejects Date values. */
  ts: string | null;
  owner: string | null;
  harness_slug: string | null;
  cwd: string | null;
  speaker: string;
  text: string;
}

async function listCandidateFiles(
  adapter: FileAdapter,
  sinceMs: number,
): Promise<Array<{ path: string; size: number; mtimeMs: number }>> {
  const out: Array<{ path: string; size: number; mtimeMs: number }> = [];
  for (const spec of adapter.roots()) {
    const paths = await jsonlAtDepth(spec.root, spec.dirDepth);
    for (const p of paths) {
      try {
        const s = await stat(p);
        if (!s.isFile() || s.mtimeMs < sinceMs || s.size === 0) continue;
        out.push({ path: p, size: s.size, mtimeMs: s.mtimeMs });
      } catch {
        /* raced deletion — skip */
      }
    }
  }
  return out;
}

/** Read complete lines from `filePath` starting at `offset`, bounded. Returns
 * the parsed-turn list + the new offset (end of last complete line). */
async function readNewLines(
  filePath: string,
  offset: number,
  parseLine: (l: string) => ParsedTurn | null,
): Promise<{ turns: ParsedTurn[]; newOffset: number }> {
  const fh = await open(filePath, 'r');
  try {
    const s = await fh.stat();
    if (s.size <= offset) return { turns: [], newOffset: offset };
    const toRead = Math.min(s.size - offset, MAX_BYTES_PER_FILE_PER_TICK);
    const buf = Buffer.alloc(toRead);
    await fh.read(buf, 0, toRead, offset);
    const chunk = buf.toString('utf8');
    const lastNl = chunk.lastIndexOf('\n');
    if (lastNl < 0) return { turns: [], newOffset: offset }; // partial line — wait
    const usable = chunk.slice(0, lastNl + 1);
    const turns: ParsedTurn[] = [];
    for (const line of usable.split('\n')) {
      if (!line.trim()) continue;
      const t = parseLine(line);
      if (t) turns.push(t);
    }
    return { turns, newOffset: offset + Buffer.byteLength(usable, 'utf8') };
  } finally {
    await fh.close();
  }
}

async function insertTurns(sql: Sql, rows: TurnRow[]): Promise<number> {
  if (!rows.length) return 0;
  // ON CONFLICT DO NOTHING: idempotent re-ingest (e.g. a reset offset) can
  // never duplicate — the PK is (workspace_id, source_kind, session_id, turn_idx).
  const r = await sql`
    INSERT INTO harness_shared.session_turns ${sql(
      rows as unknown as Record<string, unknown>[],
      'workspace_id', 'source_kind', 'session_id', 'turn_idx', 'ts',
      'owner', 'harness_slug', 'cwd', 'speaker', 'text',
    )}
    ON CONFLICT DO NOTHING
  `;
  return r.count ?? rows.length;
}

interface IngestState {
  byte_offset: number;
  turn_count: number;
}

async function readState(sql: Sql, sourceKind: string, filePath: string): Promise<IngestState> {
  const rows = await sql<Array<{ byte_offset: string | number; turn_count: number }>>`
    SELECT byte_offset, turn_count FROM harness_shared.session_ingest_state
     WHERE source_kind = ${sourceKind} AND file_path = ${filePath}
  `;
  if (!rows.length) return { byte_offset: 0, turn_count: 0 };
  return { byte_offset: Number(rows[0].byte_offset), turn_count: rows[0].turn_count };
}

async function writeState(
  sql: Sql,
  sourceKind: string,
  filePath: string,
  st: IngestState & { sessionId?: string | null; mtimeMs?: number; lastError?: string | null },
): Promise<void> {
  await sql`
    INSERT INTO harness_shared.session_ingest_state
      (source_kind, file_path, byte_offset, turn_count, session_id, mtime_ms, last_error, updated_at)
    VALUES (${sourceKind}, ${filePath}, ${st.byte_offset}, ${st.turn_count},
            ${st.sessionId ?? null}, ${st.mtimeMs ?? null}, ${st.lastError ?? null}, now())
    ON CONFLICT (source_kind, file_path) DO UPDATE SET
      byte_offset = EXCLUDED.byte_offset,
      turn_count  = EXCLUDED.turn_count,
      session_id  = COALESCE(EXCLUDED.session_id, harness_shared.session_ingest_state.session_id),
      mtime_ms    = EXCLUDED.mtime_ms,
      last_error  = EXCLUDED.last_error,
      updated_at  = now()
  `;
}

/** Tail ONE file now (bounded, incremental). The read-time freshness lever:
 * sessions:search { session:'self' } and the post-compaction orient call this
 * on the caller's own transcript so the last few minutes are never a blind
 * spot — client-neutral (compaction-context-loss D-002). */
export async function ingestFileNow(filePath: string): Promise<{ inserted: number }> {
  const adapter = FILE_ADAPTERS.find((a) => a.roots().some((r) => filePath.startsWith(r.root)));
  if (!adapter) return { inserted: 0 };
  const { sql } = getOrgPg();
  let inserted = 0;
  // A single file can exceed the per-call byte cap — loop until drained (bounded
  // by the file size; this is one file, not the fleet).
  for (let guard = 0; guard < 32; guard += 1) {
    const st = await readState(sql, adapter.sourceKind, filePath);
    const { turns, newOffset } = await readNewLines(filePath, st.byte_offset, adapter.parseLine);
    if (newOffset === st.byte_offset) break;
    const meta = adapter.meta(filePath);
    const rows: TurnRow[] = turns.map((t, i) => ({
      workspace_id: 'default',
      source_kind: adapter.sourceKind,
      session_id: t.sessionId ?? meta.sessionId,
      turn_idx: st.turn_count + i,
      ts: t.ts ? t.ts.toISOString() : null,
      owner: meta.owner,
      harness_slug: null,
      cwd: t.cwd ?? null,
      speaker: t.speaker,
      text: t.text,
    }));
    inserted += await insertTurns(sql, rows);
    await writeState(sql, adapter.sourceKind, filePath, {
      byte_offset: newOffset,
      turn_count: st.turn_count + turns.length,
      sessionId: meta.sessionId,
    });
  }
  return { inserted };
}

/* ------------------------------------------------------------------ */
/* agent_chat sync (PG → PG; transcript JSONB → turns)                  */
/* ------------------------------------------------------------------ */

const CHAT_HWM_PATH = '__hwm__';

async function syncAgentChats(sql: Sql, budget: { turns: number }): Promise<number> {
  const hwmRows = await sql<Array<{ mtime_ms: string | number | null }>>`
    SELECT mtime_ms FROM harness_shared.session_ingest_state
     WHERE source_kind = 'agent_chat' AND file_path = ${CHAT_HWM_PATH}
  `;
  const hwm = hwmRows.length ? Number(hwmRows[0].mtime_ms ?? 0) : 0;

  const chats = await sql<
    Array<{
      workspace_id: string;
      harness_slug: string;
      id: string;
      transcript: Array<{ ts?: string; role?: string; content?: unknown }> | null;
      updated_at: string | number;
    }>
  >`
    SELECT workspace_id, harness_slug, id, transcript, updated_at
      FROM harness_shared.agent_chats_consolidated
     WHERE updated_at > ${hwm} AND transcript IS NOT NULL
     ORDER BY updated_at ASC
     LIMIT ${MAX_CHATS_PER_TICK}
  `;
  if (!chats.length) return 0;

  let ingested = 0;
  let maxUpdated = hwm;
  for (const chat of chats) {
    // Budget check BEFORE advancing the high-water mark — a chat skipped for
    // budget must be re-fetched next tick, so the hwm may only cover chats we
    // actually processed.
    if (budget.turns <= 0) break;
    const transcript = Array.isArray(chat.transcript) ? chat.transcript : [];
    const key = `chat:${chat.workspace_id}:${chat.harness_slug}:${chat.id}`;
    const st = await readState(sql, 'agent_chat', key);
    if (transcript.length <= st.turn_count) {
      maxUpdated = Math.max(maxUpdated, Number(chat.updated_at)); // processed: nothing new
      continue;
    }
    const rows: TurnRow[] = [];
    for (let i = st.turn_count; i < transcript.length; i += 1) {
      const t = transcript[i];
      const speaker = t.role === 'user' ? 'user' : t.role === 'assistant' ? 'assistant' : null;
      if (!speaker) continue;
      const text = cleanTurnText(typeof t.content === 'string' ? t.content : textFromContent(t.content));
      if (!text) continue;
      rows.push({
        workspace_id: chat.workspace_id,
        source_kind: 'agent_chat',
        session_id: chat.id,
        turn_idx: i,
        ts: parseTs(t.ts)?.toISOString() ?? null,
        owner: null,
        harness_slug: chat.harness_slug,
        cwd: null,
        speaker,
        text,
      });
    }
    ingested += await insertTurns(sql, rows);
    await writeState(sql, 'agent_chat', key, {
      byte_offset: 0,
      turn_count: transcript.length,
      sessionId: chat.id,
    });
    budget.turns -= rows.length;
    maxUpdated = Math.max(maxUpdated, Number(chat.updated_at)); // processed
  }
  await writeState(sql, 'agent_chat', CHAT_HWM_PATH, {
    byte_offset: 0,
    turn_count: 0,
    mtimeMs: maxUpdated,
  });
  return ingested;
}

/* ------------------------------------------------------------------ */
/* Retention                                                            */
/* ------------------------------------------------------------------ */

/** Batched retention prune — the index stays bounded; the JSONL stays the
 * archive. Called from the daily retention tick (periodic-workflows.ts). */
export async function pruneSessionTurnsOnce(): Promise<{ deleted: number }> {
  const { sql } = getOrgPg();
  let deleted = 0;
  for (let i = 0; i < 40; i += 1) {
    const r = await sql`
      DELETE FROM harness_shared.session_turns
       WHERE ctid IN (
         SELECT ctid FROM harness_shared.session_turns
          WHERE COALESCE(ts, ingested_at) < now() - make_interval(days => ${RETENTION_DAYS})
          LIMIT 5000
       )
    `;
    deleted += r.count ?? 0;
    if ((r.count ?? 0) < 5000) break;
  }
  // Bookkeeping rows for files idle past the window are dead weight.
  await sql`
    DELETE FROM harness_shared.session_ingest_state
     WHERE updated_at < now() - make_interval(days => ${RETENTION_DAYS * 2})
       AND file_path <> ${CHAT_HWM_PATH}
  `;
  return { deleted };
}

/* ------------------------------------------------------------------ */
/* The periodic tick                                                    */
/* ------------------------------------------------------------------ */

// Single-flight pinned to globalThis (perf rule A18): tsx/dual-path imports can
// instantiate this module twice; a module-scoped flag would not dedupe.
const __stateKey = Symbol.for('papercusp.sessionIngestState');
interface SweepState { running: boolean; last: IngestStats | null }
const __sweep: SweepState = (() => {
  const g = globalThis as typeof globalThis & { [__stateKey]?: SweepState };
  if (!g[__stateKey]) g[__stateKey] = { running: false, last: null };
  return g[__stateKey]!;
})();

export function getLastSessionIngestStats(): IngestStats | null {
  return __sweep.last;
}

/** One bounded ingest sweep across every adapter. Never throws. */
export async function runSessionIngestOnce(): Promise<IngestStats> {
  const started = Date.now();
  const stats: IngestStats = {
    filesScanned: 0, filesIngested: 0, turnsInserted: 0, chatsIngested: 0, errors: 0, durationMs: 0,
  };
  if (__sweep.running) return { ...stats, skipped: 'already_running' };
  __sweep.running = true;
  try {
    let enabled = true;
    try {
      enabled = await getFlag(FLAGS.SESSION_SEARCH, 'system:session-ingest');
    } catch {
      /* fail-open: flag default is ON */
    }
    if (!enabled) return { ...stats, skipped: 'flag_off' };

    const { sql } = getOrgPg();
    const sinceMs = Date.now() - INGEST_WINDOW_DAYS * 24 * 3600 * 1000;
    const budget = { turns: MAX_TURNS_PER_TICK };

    for (const adapter of FILE_ADAPTERS) {
      if (budget.turns <= 0) break;
      let candidates: Array<{ path: string; size: number; mtimeMs: number }> = [];
      try {
        candidates = await listCandidateFiles(adapter, sinceMs);
      } catch (err) {
        stats.errors += 1;
        console.warn(`[session-ingest] ${adapter.sourceKind} enumerate failed: ${(err as Error).message}`);
        continue;
      }
      // Newest first: recent sessions index first; history back-fills over ticks.
      candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
      // Bulk-load this adapter's ingest state ONCE — a per-file SELECT at ~23k
      // candidate files was minutes of serial round-trips (perf anti-pattern
      // A1: per-item queries in a loop; observed live 2026-07-05).
      const stateRows = await sql<Array<{ file_path: string; byte_offset: string | number; turn_count: number }>>`
        SELECT file_path, byte_offset, turn_count
          FROM harness_shared.session_ingest_state
         WHERE source_kind = ${adapter.sourceKind}
      `;
      const stateMap = new Map<string, IngestState>(
        stateRows.map((r) => [r.file_path, { byte_offset: Number(r.byte_offset), turn_count: r.turn_count }]),
      );
      let filesThisAdapter = 0;
      for (const cand of candidates) {
        if (budget.turns <= 0 || filesThisAdapter >= MAX_FILES_PER_TICK) break;
        stats.filesScanned += 1;
        try {
          const st = stateMap.get(cand.path) ?? { byte_offset: 0, turn_count: 0 };
          if (cand.size <= st.byte_offset) continue; // nothing new
          filesThisAdapter += 1;
          const { turns, newOffset } = await readNewLines(cand.path, st.byte_offset, adapter.parseLine);
          if (newOffset === st.byte_offset) continue;
          const meta = adapter.meta(cand.path);
          const rows: TurnRow[] = turns.map((t, i) => ({
            workspace_id: 'default',
            source_kind: adapter.sourceKind,
            session_id: t.sessionId ?? meta.sessionId,
            turn_idx: st.turn_count + i,
            ts: t.ts ? t.ts.toISOString() : null,
            owner: meta.owner,
            harness_slug: null,
            cwd: t.cwd ?? null,
            speaker: t.speaker,
            text: t.text,
          }));
          stats.turnsInserted += await insertTurns(sql, rows);
          await writeState(sql, adapter.sourceKind, cand.path, {
            byte_offset: newOffset,
            turn_count: st.turn_count + turns.length,
            sessionId: meta.sessionId,
            mtimeMs: cand.mtimeMs,
          });
          stats.filesIngested += 1;
          budget.turns -= turns.length;
        } catch (err) {
          stats.errors += 1;
          // Record the error WITHOUT touching offsets — resetting byte_offset/
          // turn_count on a transient failure would restart turn_idx at 0 and
          // silently drop every subsequent turn to ON CONFLICT DO NOTHING.
          try {
            await sql`
              UPDATE harness_shared.session_ingest_state
                 SET last_error = ${(err as Error).message.slice(0, 300)}, updated_at = now()
               WHERE source_kind = ${adapter.sourceKind} AND file_path = ${cand.path}
            `;
          } catch { /* bookkeeping best-effort */ }
        }
      }
    }

    if (budget.turns > 0) {
      try {
        stats.chatsIngested = await syncAgentChats(sql, budget);
      } catch (err) {
        stats.errors += 1;
        console.warn(`[session-ingest] agent_chat sync failed: ${(err as Error).message}`);
      }
    }

    stats.durationMs = Date.now() - started;
    __sweep.last = stats;
    return stats;
  } finally {
    __sweep.running = false;
  }
}
