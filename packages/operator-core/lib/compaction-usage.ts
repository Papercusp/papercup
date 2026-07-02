/**
 * compaction-usage.ts — best-effort per-session context-size estimator.
 * agent-managed-compaction-2026-07-01 (P-007 / P-009).
 *
 * Resolves a session's transcript from its coord ownerId (via adv_sessions) and
 * estimates current context tokens as transcript-bytes/4 — a cheap, monotonic
 * "how full am I" gauge (fs.stat only, no content read). Runs OFF the per-turn hot
 * path: the compaction-compliance watchdog calls it on a cadence and caches the
 * result on coord_presence.context_tokens; the inbox usage signal reads that cached
 * value. Degrades to null (never throws) when a transcript can't be resolved.
 *
 * v1 targets Claude (interactive AND spawned — adv_sessions maps both). OMP
 * self-compacts natively and Codex has no compaction, so both return null for now
 * (a follow-up can add OMP via OmpSessionUsage).
 */
import * as fs from 'node:fs';
import { findSessionTranscript } from './claude-sessions';

export interface SessionRef {
  /** Backend: 'claude' | 'omp' | 'codex' | null (unknown → treated as claude). */
  agent: string | null;
  /** The backend session id (Claude UUID / OMP thread / codex rollout). */
  sessionId: string | null;
}

/** The raw JSONL key Claude writes on a compaction-summary entry. Text that
 *  merely MENTIONS the key inside a string is escaped (\"isCompactSummary\"),
 *  so matching the raw byte form is unambiguous (EI-6410). */
const COMPACT_BOUNDARY_MARKER = '"isCompactSummary":true';
/** Bound the backward boundary scan. Not-found within the cap ⇒ ≥cap bytes
 *  since any compaction ⇒ the estimate is over every real limit anyway. */
const BOUNDARY_SCAN_CAP = 8 * 1024 * 1024;
/** Files below this skip the scan entirely (they can't be near any limit). */
const BOUNDARY_SCAN_MIN = 1024 * 1024;

/**
 * tokens ≈ bytes SINCE THE LAST COMPACTION / 4 (EI-6410: the transcript JSONL
 * accumulates across compactions, so whole-file/4 is monotonic and reads a
 * compacted session at 150–250%+ of its limit forever — false over-limit
 * warnings and compact-loops). Small files stay stat-only; larger ones scan a
 * bounded tail for the last compaction-summary entry and count from there.
 */
export function tokensFromFileSize(pathStr: string): number | null {
  try {
    const size = fs.statSync(pathStr).size;
    if (size < BOUNDARY_SCAN_MIN) return Math.floor(size / 4);
    const start = Math.max(0, size - BOUNDARY_SCAN_CAP);
    const fd = fs.openSync(pathStr, 'r');
    try {
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      const idx = buf.lastIndexOf(COMPACT_BOUNDARY_MARKER);
      const sinceBytes = idx === -1 ? size : buf.length - idx;
      return Math.floor(sinceBytes / 4);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

/**
 * Estimate a session's current context tokens from a resolved SessionRef.
 * Claude (+ unknown) → transcript bytes/4; OMP/Codex → null in v1.
 */
export async function estimateContextTokens(ref: SessionRef, owner?: string | null): Promise<number | null> {
  if (!ref.sessionId) return null;
  if (ref.agent === 'omp' || ref.agent === 'codex') return null;
  try {
    // Pass the coord `owner` hint: an interactive/spawned session's transcript lives under
    // ~/.papercusp/session-claude/<owner>/projects, so the hint takes findSessionTranscript's
    // FAST PATH (one owner-root readdir) instead of the full 12k-owner-dir sweep. Without it,
    // the compaction watchdog polling many owners on a cadence re-swept every isolation root
    // per call — the fs-churn that bloated the background host to tens of GB.
    const p = await findSessionTranscript(ref.sessionId, { owner: owner ?? null });
    return p ? tokensFromFileSize(p) : null;
  } catch {
    return null;
  }
}

/** Resolve a session's {agent, sessionId} from its coord ownerId via adv_sessions. */
export async function resolveSessionRef(ownerId: string): Promise<SessionRef | null> {
  try {
    const { getOrgPg } = await import('@papercusp/db-org');
    const rows = await getOrgPg().sql<{ agent: string | null; session_id: string | null }[]>`
      SELECT agent, session_id
        FROM harness_shared.adv_sessions
       WHERE coord_owner_id = ${ownerId} AND session_id IS NOT NULL
       LIMIT 1
    `;
    if (!rows.length) return null;
    return { agent: rows[0].agent, sessionId: rows[0].session_id };
  } catch {
    return null;
  }
}

/** Best-effort context-token estimate for a session by its coord ownerId. */
export async function estimateContextTokensForOwner(ownerId: string): Promise<number | null> {
  const ref = await resolveSessionRef(ownerId);
  return ref ? estimateContextTokens(ref, ownerId) : null;
}

/** The context-death signature Claude writes into the transcript when the
 *  request exceeds the model window — the silent fleet-member killer
 *  (context-trimming-tiers P-019: 6 members died on it, 2026-07-01). */
export const CONTEXT_DEATH_MARKER = 'Prompt is too long';

/** How much transcript tail to scan for the death marker. The error lands as
 *  the final entry, but a hook/summary line can trail it — 8KB is plenty. */
const DEATH_TAIL_BYTES = 8_192;

/**
 * P-019 context-death detector: does this owner's transcript TAIL carry the
 * "Prompt is too long" window-overflow error? Best-effort (null transcript /
 * read error → false). fs reads only the tail, never the whole file.
 */
export async function detectContextDeathForOwner(ownerId: string): Promise<boolean> {
  try {
    const ref = await resolveSessionRef(ownerId);
    if (!ref?.sessionId || ref.agent === 'omp' || ref.agent === 'codex') return false;
    const { findSessionTranscript } = await import('./claude-sessions');
    const p = await findSessionTranscript(ref.sessionId, { owner: ownerId });
    if (!p) return false;
    const size = fs.statSync(p).size;
    const start = Math.max(0, size - DEATH_TAIL_BYTES);
    const fd = fs.openSync(p, 'r');
    try {
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      return buf.toString('utf8').includes(CONTEXT_DEATH_MARKER);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

/**
 * Best-effort MODEL SPEC (`<id>[:effort]`, possibly carrying the `[1m]` window
 * marker) for a session owner — the window signal `defaultCompactionLimitForSpec`
 * keys on (context-trimming-tiers P-002/P-006).
 *
 * Source 1: a `--model` in the recorded launch argv (adv_sessions) — the only
 * PER-SESSION truth. Source 2 (fallback when no `--model` was recorded): the
 * session config dir's `settings.json` `model` field. Order matters: that
 * `settings.json` is a SYMLINK back to the shared `~/.claude/settings.json`
 * (interactive-claude-config mirror), so it reports the BOX-DEFAULT model —
 * checking it first handed every `psu --model=sonnet` fleet member the
 * opus[1m] 500k limit on a 200k window, a guaranteed context death
 * (context-trimming-tiers P-031 gap 1, 2026-07-02). argv-first fails safe:
 * a conservative spec on a big window is deliberate leanness; a big spec on a
 * 200k window is fatal. null when neither resolves — callers treat null as the
 * conservative 200k window.
 */
export async function resolveModelSpecForOwner(ownerId: string): Promise<string | null> {
  try {
    const { getOrgPg } = await import('@papercusp/db-org');
    const rows = await getOrgPg().sql<{ launch_argv: unknown }[]>`
      SELECT launch_argv
        FROM harness_shared.adv_sessions
       WHERE coord_owner_id = ${ownerId} AND launch_argv IS NOT NULL
       ORDER BY started_at DESC
       LIMIT 1
    `;
    const argv = rows[0]?.launch_argv;
    if (Array.isArray(argv)) {
      for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (typeof a !== 'string') continue;
        if (a.startsWith('--model=')) {
          const v = a.slice('--model='.length).trim();
          if (v) return v;
        }
        if (a === '--model' && typeof argv[i + 1] === 'string') {
          const v = (argv[i + 1] as string).trim();
          if (v) return v;
        }
      }
    }
  } catch {
    /* best-effort — fall through to settings.json */
  }
  // Guard the path join: owner ids are our own (su-/s-/pus- UUIDs), but never
  // let a hostile id escape the session-claude root.
  if (ownerId && !ownerId.includes('/') && !ownerId.includes('..')) {
    try {
      const { papercuspSessionClaudeBase } = await import('./claude-sessions');
      const path = await import('node:path');
      const p = path.join(papercuspSessionClaudeBase(), ownerId, 'settings.json');
      const j = JSON.parse(fs.readFileSync(p, 'utf8')) as { model?: unknown };
      if (typeof j.model === 'string' && j.model.trim()) return j.model.trim();
    } catch {
      /* unresolvable */
    }
  }
  return null;
}
