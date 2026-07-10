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

import { readFile, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, basename } from 'node:path';

const HOME = homedir();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface SelfSession {
  sourceKind: 'claude' | 'omp' | 'codex';
  sessionId: string;
  filePath: string;
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

/** Resolve the caller's live transcript. Fail-soft: null when unresolvable. */
export async function resolveSelfSession(ownerId: string): Promise<SelfSession | null> {
  if (!ownerId) return null;

  // 1. The psu-pty discovery record → hosted CLI + a session uuid when present.
  let command: string | null = null;
  let uuid: string | null = null;
  try {
    const raw = await readFile(join(HOME, '.papercusp', 'psu-pty', `${sanitizeKey(ownerId)}.json`), 'utf8');
    const rec = JSON.parse(raw) as { command?: string; args?: unknown };
    command = typeof rec.command === 'string' ? rec.command : null;
    if (Array.isArray(rec.args)) {
      for (const a of rec.args) if (typeof a === 'string' && UUID_RE.test(a)) { uuid = a; break; }
    }
  } catch {
    /* no live pty record — fall through to the claude isolation-dir path */
  }

  const kind: SelfSession['sourceKind'] =
    command === 'omp' ? 'omp' : command === 'codex' ? 'codex' : 'claude';

  if (kind === 'claude') {
    const roots = [
      join(HOME, '.papercusp', 'session-claude', ownerId, 'projects'),
      // Non-isolated interactive sessions land in the global dir.
      ...(uuid ? [join(HOME, '.claude', 'projects')] : []),
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

  // omp / codex: no per-owner isolation dir — a uuid from the args is required.
  if (!uuid) return null;
  if (kind === 'omp') {
    const files = await listJsonlUnder(join(HOME, '.omp', 'agent', 'sessions'));
    const hit = files.find((f) => basename(f, '.jsonl').endsWith(`_${uuid}`));
    return hit ? { sourceKind: 'omp', sessionId: uuid, filePath: hit } : null;
  }
  const files: string[] = [];
  // Fleet codex sessions live in PER-SESSION homes (su-codex-homes/session-
  // <advId>), not the shared ~/.codex — resolve via the owner's open adv rows
  // first (session-db-archive-retire-dirs P-015; before this a live fleet
  // codex session could never resolve `session:'self'`). Fail-soft to the
  // shared root.
  try {
    const { getOrgPg } = await import('@papercusp/db-org');
    const { sql } = getOrgPg();
    const rows = await sql<Array<{ id: number }>>`
      SELECT id FROM harness_shared.adv_sessions
       WHERE coord_owner_id = ${ownerId} AND agent = 'codex' AND ended_at IS NULL
       ORDER BY started_at DESC
       LIMIT 3`;
    const { codexHomeForSessionKey } = await import('@papercusp/orchestrator/session-launch-dirs');
    for (const r of rows) {
      files.push(...(await listJsonlUnder(join(codexHomeForSessionKey(r.id), 'sessions'))));
    }
  } catch {
    /* PG unavailable — the shared root below still works for non-fleet runs */
  }
  files.push(...(await listJsonlUnder(join(HOME, '.codex', 'sessions'))));
  const hit = files.find((f) => basename(f, '.jsonl').toLowerCase().endsWith(uuid.toLowerCase()));
  return hit ? { sourceKind: 'codex', sessionId: uuid, filePath: hit } : null;
}
