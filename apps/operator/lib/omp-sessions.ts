/**
 * omp session-file discovery + reader.
 *
 * Links a Papercusp spawn_id (in harness_shared.spawned_agents) to an
 * omp session file under ~/.omp/agent/sessions/<cwd-encoded>/<ts>_<id>.jsonl
 * without any orchestrator changes. The link is computed at read time
 * from cwd + start-time hints — survives spawn exit, survives worktree
 * cleanup (omp's session files outlive their cwd).
 *
 * Doesn't try to be exact. Returns a best-match candidate with a
 * confidence score the caller can use to decide whether to display it.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getOrgPg } from '@restart/db-org';
import { loadHarnessRegistry } from './harness-registry';

const SESSIONS_ROOT = join(homedir(), '.omp', 'agent', 'sessions');

export interface OmpSessionMeta {
  /** UUIDv7 session id minted by omp. */
  id: string;
  /** Absolute path to the .jsonl file. */
  filePath: string;
  /** Recorded cwd from the session header. */
  cwd: string;
  /** ISO timestamp from the session header. */
  timestamp: string;
  /** First title omp inferred (may be empty until the model picks one). */
  title: string;
  /** "exact-cwd" | "cwd-prefix" | "time-only" — drives caller confidence. */
  matchKind: 'exact-cwd' | 'cwd-prefix' | 'time-only';
  /** ms between the spawn's started_at and this session's timestamp. */
  timeDriftMs: number;
}

export interface OmpSessionTurn {
  type: string;
  [k: string]: unknown;
}

interface SessionHeader {
  type: 'session';
  version: number;
  id: string;
  timestamp: string;
  cwd: string;
  title?: string;
}

function readHeader(filePath: string): SessionHeader | null {
  try {
    // Read just the first 4KB — the session header is the first line.
    const fd = require('node:fs').openSync(filePath, 'r');
    const buf = Buffer.alloc(4096);
    try {
      const n = require('node:fs').readSync(fd, buf, 0, 4096, 0);
      const text = buf.slice(0, n).toString('utf8');
      const newline = text.indexOf('\n');
      const line = newline === -1 ? text : text.slice(0, newline);
      const parsed = JSON.parse(line) as SessionHeader;
      if (parsed.type !== 'session' || !parsed.id) return null;
      return parsed;
    } finally {
      require('node:fs').closeSync(fd);
    }
  } catch {
    return null;
  }
}

function listAllSessionFiles(): string[] {
  if (!existsSync(SESSIONS_ROOT)) return [];
  const out: string[] = [];
  for (const dir of readdirSync(SESSIONS_ROOT)) {
    const dirPath = join(SESSIONS_ROOT, dir);
    try {
      if (!statSync(dirPath).isDirectory()) continue;
    } catch {
      continue;
    }
    for (const f of readdirSync(dirPath)) {
      if (!f.endsWith('.jsonl')) continue;
      out.push(join(dirPath, f));
    }
  }
  return out;
}

async function lookupSpawnHints(
  spawnId: string,
): Promise<{ startedAtMs: number; harnessSlug: string | null; projectPath: string | null } | null> {
  const { sql } = getOrgPg();
  const rows = (await sql`
    SELECT harness_slug, started_at
      FROM harness_shared.spawned_agents
     WHERE spawn_id = ${spawnId}
     LIMIT 1
  `) as Array<{ harness_slug: string | null; started_at: string | null }>;
  if (rows.length === 0) return null;
  const startedAtMs = rows[0].started_at ? new Date(rows[0].started_at).getTime() : 0;
  let projectPath: string | null = null;
  if (rows[0].harness_slug) {
    try {
      const reg = await loadHarnessRegistry();
      const project = reg.projects.find((p) => p.slug === rows[0].harness_slug);
      projectPath = project?.path ?? null;
    } catch {
      /* ignore */
    }
  }
  return {
    startedAtMs,
    harnessSlug: rows[0].harness_slug,
    projectPath,
  };
}

export async function findOmpSessionForSpawn(
  spawnId: string,
  windowMs = 60_000,
): Promise<OmpSessionMeta | null> {
  const hints = await lookupSpawnHints(spawnId);
  if (!hints || !hints.startedAtMs) return null;

  const files = listAllSessionFiles();
  let best: OmpSessionMeta | null = null;

  for (const filePath of files) {
    const header = readHeader(filePath);
    if (!header) continue;
    const ts = new Date(header.timestamp).getTime();
    if (!ts) continue;
    const drift = Math.abs(ts - hints.startedAtMs);
    if (drift > windowMs) continue;

    let matchKind: OmpSessionMeta['matchKind'] = 'time-only';
    if (hints.projectPath && header.cwd === hints.projectPath) {
      matchKind = 'exact-cwd';
    } else if (hints.projectPath && header.cwd.startsWith(hints.projectPath)) {
      matchKind = 'cwd-prefix';
    }

    // Score: exact-cwd > cwd-prefix > time-only; within same kind, lower drift wins.
    const kindScore = matchKind === 'exact-cwd' ? 0 : matchKind === 'cwd-prefix' ? 1 : 2;
    const bestKindScore = !best
      ? Infinity
      : best.matchKind === 'exact-cwd'
        ? 0
        : best.matchKind === 'cwd-prefix'
          ? 1
          : 2;
    if (
      !best ||
      kindScore < bestKindScore ||
      (kindScore === bestKindScore && drift < best.timeDriftMs)
    ) {
      best = {
        id: header.id,
        filePath,
        cwd: header.cwd,
        timestamp: header.timestamp,
        title: header.title ?? '',
        matchKind,
        timeDriftMs: drift,
      };
    }
  }
  return best;
}

export interface ReadOmpSessionInput {
  filePath: string;
  limit?: number;
}

export interface ReadOmpSessionResult {
  header: SessionHeader;
  turns: OmpSessionTurn[];
  totalLines: number;
  truncated: boolean;
}

export function readOmpSession(input: ReadOmpSessionInput): ReadOmpSessionResult | null {
  const limit = Math.max(1, Math.min(5000, input.limit ?? 500));
  if (!existsSync(input.filePath)) return null;
  let content: string;
  try {
    content = readFileSync(input.filePath, 'utf8');
  } catch {
    return null;
  }
  const lines = content.split('\n').filter((l) => l.trim() !== '');
  if (lines.length === 0) return null;

  let header: SessionHeader | null = null;
  const turns: OmpSessionTurn[] = [];
  for (const line of lines) {
    let parsed: OmpSessionTurn;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!header && parsed.type === 'session') {
      header = parsed as unknown as SessionHeader;
      continue;
    }
    turns.push(parsed);
    if (turns.length >= limit) break;
  }
  if (!header) return null;
  return {
    header,
    turns,
    totalLines: lines.length,
    truncated: lines.length > limit + 1,
  };
}
