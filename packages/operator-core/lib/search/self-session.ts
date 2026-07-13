/**
 * Resolve the CALLING agent's own live transcript file — the `session:'self'`
 * sugar (session-search-scope-2026-07-05 P-005; compaction-context-loss D-002).
 *
 * Why this exists: after a compaction the agent's pre-compaction turns are
 * gone from context but STILL ON DISK in its transcript JSONL. The agent
 * cannot know its own transcript path (psu isolates Claude sessions under
 * ~/.papercusp/session-claude/<ownerId>/…, and the psu-launched agent never
 * sees that path) — so the server resolves it from the caller's coord
 * ownerId, client-neutrally:
 *
 *   1. The psu-pty discovery record (~/.papercusp/psu-pty/<owner>.json)
 *      names the hosted CLI (`command`: claude | omp | codex) and its args —
 *      a `--resume <uuid>`-style arg pins the exact session id.
 *   2. claude → ~/.papercusp/session-claude/<ownerId>/projects/** (per-owner
 *      isolation dirs — dir name IS the coord ownerId), falling back to
 *      ~/.claude/projects/** for non-isolated sessions.
 *      omp    → ~/.omp/agent/sessions/<munged-cwd>/<ts>_<uuid>.jsonl
 *      codex  → ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl
 *   3. No uuid in args (a fresh, un-resumed session) → the newest .jsonl in
 *      the owner's isolation dir (claude only — omp/codex have no per-owner
 *      dir, so without a uuid we return null and the caller degrades to an
 *      owner-filtered index search).
 *
 * Read-only + fail-soft: any miss returns null; callers degrade gracefully.
 */

import { open, readFile, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, basename } from 'node:path';

const HOME = homedir();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface SelfSession {
  sourceKind: 'claude' | 'omp' | 'codex';
  sessionId: string;
  filePath: string;
}

interface ActiveSessionRow {
  id: number;
  agent: string | null;
  session_id: string | null;
  omp_thread_id: string | null;
}

export interface ResolveSelfSessionOptions {
  home?: string;
  loadActiveSessions?: (ownerId: string) => Promise<ActiveSessionRow[]>;
  codexHomeForSession?: (id: number) => string;
}

/** Mirror of psu-pty-discovery's sanitizeKey (kept trivial on purpose). */
function sanitizeKey(ownerId: string): string {
  return String(ownerId || 'unknown').replace(/[^A-Za-z0-9._-]/g, '_');
}

async function listJsonlUnder(root: string): Promise<string[]> {
  try {
    const names = (await readdir(root, { recursive: true })) as string[];
    return names.filter((n) => n.endsWith('.jsonl')).map((n) => join(root, n));
  } catch {
    return [];
  }
}

async function newestOf(paths: string[]): Promise<string | null> {
  let best: { p: string; m: number } | null = null;
  for (const p of paths) {
    try {
      const s = await stat(p);
      if (!best || s.mtimeMs > best.m) best = { p, m: s.mtimeMs };
    } catch {
      /* raced */
    }
  }
  return best?.p ?? null;
}

/** Read the native thread id from Codex's bounded prompt-history tail. */
async function newestCodexHistorySessionId(filePath: string): Promise<string | null> {
  let fh: Awaited<ReturnType<typeof open>> | null = null;
  try {
    fh = await open(filePath, 'r');
    const s = await fh.stat();
    const size = Math.min(s.size, 1024 * 1024);
    if (size <= 0) return null;
    const buf = Buffer.alloc(size);
    await fh.read(buf, 0, size, s.size - size);
    const lines = buf.toString('utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      if (!lines[i]?.trim()) continue;
      try {
        const row = JSON.parse(lines[i]) as { session_id?: unknown };
        if (typeof row.session_id === 'string' && UUID_RE.test(row.session_id)) return row.session_id;
      } catch {
        /* a bounded tail may begin mid-line */
      }
    }
  } catch {
    /* absent / raced */
  } finally {
    await fh?.close().catch(() => undefined);
  }
  return null;
}

async function defaultActiveSessions(ownerId: string): Promise<ActiveSessionRow[]> {
  try {
    const { getOrgPg } = await import('@papercusp/db-org');
    const { sql } = getOrgPg();
    return await sql<ActiveSessionRow[]>`
      SELECT id, agent, session_id, omp_thread_id
        FROM harness_shared.adv_sessions
       WHERE coord_owner_id = ${ownerId} AND ended_at IS NULL
       ORDER BY started_at DESC
       LIMIT 5`;
  } catch {
    return [];
  }
}

/** Resolve the caller's live transcript. Fail-soft: null when unresolvable. */
export async function resolveSelfSession(
  ownerId: string,
  opts: ResolveSelfSessionOptions = {},
): Promise<SelfSession | null> {
  if (!ownerId) return null;
  const home = opts.home ?? HOME;
  const activeSessions = await (opts.loadActiveSessions ?? defaultActiveSessions)(ownerId);

  // 1. The psu-pty discovery record → hosted CLI + a session uuid when present.
  let command: string | null = null;
  let uuid: string | null = null;
  try {
    const raw = await readFile(join(home, '.papercusp', 'psu-pty', `${sanitizeKey(ownerId)}.json`), 'utf8');
    const rec = JSON.parse(raw) as { command?: string; args?: unknown };
    command = typeof rec.command === 'string' ? rec.command : null;
    if (Array.isArray(rec.args)) {
      for (const a of rec.args) if (typeof a === 'string' && UUID_RE.test(a)) { uuid = a; break; }
    }
  } catch {
    /* no live pty record — fall through to the claude isolation-dir path */
  }

  // A fresh psu Codex launch has an adv-session row before it has a native
  // session id or discovery record. The row still identifies its client and
  // isolated CODEX_HOME; defaulting such a launch to Claude made self-recall
  // impossible by construction.
  if (!command) command = activeSessions.find((r) => r.agent)?.agent ?? null;
  if (!uuid) {
    const native = activeSessions.find((r) => r.session_id && UUID_RE.test(r.session_id))?.session_id;
    if (native) uuid = native;
  }

  const kind: SelfSession['sourceKind'] =
    command === 'omp' ? 'omp' : command === 'codex' ? 'codex' : 'claude';

  if (kind === 'claude') {
    const roots = [
      join(home, '.papercusp', 'session-claude', ownerId, 'projects'),
      // Non-isolated interactive sessions land in the global dir.
      ...(uuid ? [join(home, '.claude', 'projects')] : []),
    ];
    for (const root of roots) {
      const files = await listJsonlUnder(root);
      if (!files.length) continue;
      if (uuid) {
        const hit = files.find((f) => basename(f, '.jsonl') === uuid);
        if (hit) return { sourceKind: 'claude', sessionId: uuid, filePath: hit };
        continue;
      }
      const newest = await newestOf(files);
      if (newest) return { sourceKind: 'claude', sessionId: basename(newest, '.jsonl'), filePath: newest };
    }
    return null;
  }

  if (kind === 'omp') {
    if (!uuid) return null;
    const files = await listJsonlUnder(join(home, '.omp', 'agent', 'sessions'));
    const hit = files.find((f) => basename(f, '.jsonl').endsWith(`_${uuid}`));
    return hit ? { sourceKind: 'omp', sessionId: uuid, filePath: hit } : null;
  }
  const files: string[] = [];
  // Fleet codex sessions live in PER-SESSION homes (su-codex-homes/session-
  // <advId>), not the shared ~/.codex — resolve via the owner's open adv rows
  // first (session-db-archive-retire-dirs P-015; before this a live fleet
  // codex session could never resolve `session:'self'`). Fail-soft to the
  // shared root.
  for (const r of activeSessions.filter((row) => row.agent === 'codex')) {
    const codexHome = opts.codexHomeForSession
      ? opts.codexHomeForSession(r.id)
      : join(home, '.papercusp', 'su-codex-homes', `session-${r.id}`);
    const isolated = await listJsonlUnder(join(codexHome, 'sessions'));
    files.push(...isolated);
    const pinned = uuid
      ? isolated.find((f) => basename(f, '.jsonl').toLowerCase().endsWith(uuid.toLowerCase()))
      : await newestOf(isolated);
    if (pinned) {
      const stem = basename(pinned, '.jsonl');
      const parsed = stem.match(/([0-9a-f]{8}-[0-9a-f-]{27,})$/i)?.[1] ?? uuid;
      if (parsed) return { sourceKind: 'codex', sessionId: parsed, filePath: pinned };
    }

    // Codex 0.144+ can update state_5.sqlite/history.jsonl while the recorded
    // rollout_path is absent. history.jsonl is user-turn-only, but pinning and
    // indexing it is strictly better than an unscoped owner fallback.
    const historyPath = join(codexHome, 'history.jsonl');
    const historyId = await newestCodexHistorySessionId(historyPath);
    if (historyId) return { sourceKind: 'codex', sessionId: historyId, filePath: historyPath };
  }
  if (!uuid) return null;
  files.push(...(await listJsonlUnder(join(home, '.codex', 'sessions'))));
  const hit = files.find((f) => basename(f, '.jsonl').toLowerCase().endsWith(uuid.toLowerCase()));
  return hit ? { sourceKind: 'codex', sessionId: uuid, filePath: hit } : null;
}
