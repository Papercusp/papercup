/**
 * session-archive-hook.ts — the end-of-session FAST PATH
 * (plan session-db-archive-retire-dirs-2026-07-10 P-004).
 *
 * markAdvSessionEnded (adv-sessions.ts) fires scheduleArchiveForAdvSession(id)
 * fire-and-forget via dynamic import. After a short SETTLE delay (the CLI may
 * flush final transcript lines just after the end report — bootstrap-su's end
 * beacon arrives while the process is still exiting), the hook:
 *   1. resolves the adv row → a SessionArchiveRef (per-CLI session root),
 *   2. runs ingestFileNow on the session's transcript(s) so the session_turns
 *      recall INDEX has the tail before the file disappears,
 *   3. archiveAndDeleteSession — archive committed + sha-verified BEFORE any
 *      unlink; a post-archive write refuses deletion (left for the P-006
 *      reconciler to re-archive).
 *
 * Flag-gated by FLAGS.SESSION_ARCHIVE_AT_END (default ON; kill-switch). Fails
 * CLOSED on flag-system errors: skipping the fast path just means dirs
 * accumulate like the old world until the reconciler runs — never data loss.
 */

import { join } from 'node:path';
import { getOrgPg } from '@papercusp/db-org';
import { getFlag } from '@papercusp/flags/server';
import { FLAGS } from '@papercusp/flags';
import { codexHomeForSessionKey, sessionClaudeRoot } from '@papercusp/orchestrator/session-launch-dirs';
import { ompSessionsRoot } from './omp-sessions';
import { ingestFileNow } from './search/session-ingest';
import {
  archiveAndDeleteSession,
  collectSessionFiles,
  type ArchiveSessionResult,
  type DeleteArchivedResult,
  type SessionArchiveRef,
  type SessionArchiveStore,
} from './session-archive';

/** Settle window between the end report and the archive pass. */
const SETTLE_DELAY_MS = 15_000;

export interface AdvRowForArchive {
  id: number;
  agent: string | null; // 'claude' | 'codex' | 'omp' | null
  mode: string; // 'omp' | 'console'
  cwd: string | null;
  coord_owner_id: string | null;
  session_id: string | null; // native CLI uuid
}

export interface ArchiveRoots {
  /** ~/.papercusp/session-claude — per-owner CLAUDE_CONFIG_DIRs live under it. */
  claudeSessionRoot: string;
  codexHomeFor: (advSessionId: number) => string;
  ompRoot: string;
}

export function defaultArchiveRoots(): ArchiveRoots {
  return {
    claudeSessionRoot: sessionClaudeRoot(),
    codexHomeFor: (id) => codexHomeForSessionKey(id),
    ompRoot: ompSessionsRoot(),
  };
}

/** Pure resolver: adv row → archive ref (null = not resolvable; the disk-side
 *  reconciler sweep is the catch-all for those). */
export function resolveArchiveRefForAdvRow(
  row: AdvRowForArchive,
  roots: ArchiveRoots,
): SessionArchiveRef | null {
  if (!row.session_id) return null;
  const agent = row.agent ?? (row.mode === 'omp' ? 'omp' : null);
  const base = {
    sessionId: row.session_id,
    owner: row.coord_owner_id,
    cwd: row.cwd,
    advSessionId: row.id,
    archivedBy: 'exit-hook' as const,
  };
  switch (agent) {
    case 'claude':
      if (!row.coord_owner_id) return null;
      return { ...base, sourceKind: 'claude', sessionRoot: join(roots.claudeSessionRoot, row.coord_owner_id) };
    case 'codex':
      return { ...base, sourceKind: 'codex', sessionRoot: roots.codexHomeFor(row.id) };
    case 'omp':
      return { ...base, sourceKind: 'omp', sessionRoot: roots.ompRoot };
    default:
      return null;
  }
}

export interface ArchiveHookDeps {
  loadRow?: (advSessionId: number) => Promise<AdvRowForArchive | null>;
  roots?: ArchiveRoots;
  store?: SessionArchiveStore;
  ingestFile?: (filePath: string) => Promise<unknown>;
}

async function loadAdvRow(advSessionId: number): Promise<AdvRowForArchive | null> {
  const { sql } = getOrgPg();
  const rows = await sql<AdvRowForArchive[]>`
    SELECT id, agent, mode, cwd, coord_owner_id, session_id
      FROM harness_shared.adv_sessions
     WHERE id = ${advSessionId}`;
  return rows[0] ?? null;
}

export interface ArchiveHookResult {
  ok: boolean;
  reason?: 'row_not_found' | 'unresolvable' | ArchiveSessionResult['reason'];
  archive?: ArchiveSessionResult;
  delete?: DeleteArchivedResult;
}

/** The actual pass — exported with injectable deps for tests + the P-006
 *  reconciler (which calls it directly, no settle timer). */
export async function runArchiveForAdvSession(
  advSessionId: number,
  deps: ArchiveHookDeps = {},
): Promise<ArchiveHookResult> {
  const row = await (deps.loadRow ?? loadAdvRow)(advSessionId);
  if (!row) return { ok: false, reason: 'row_not_found' };
  const ref = resolveArchiveRefForAdvRow(row, deps.roots ?? defaultArchiveRoots());
  if (!ref) {
    console.warn(
      `[session-archive] adv ${advSessionId} not resolvable (agent=${row.agent}, owner=${row.coord_owner_id}, native=${row.session_id}) — left for the disk-side reconciler`,
    );
    return { ok: false, reason: 'unresolvable' };
  }
  // Final ingest: the recall index gets the transcript tail BEFORE the file
  // is deleted. Best-effort per file — an ingest failure never blocks archival
  // (the archive itself preserves the bytes the index missed).
  const ingest = deps.ingestFile ?? ingestFileNow;
  try {
    for (const f of await collectSessionFiles(ref)) {
      if (!f.rel.endsWith('.jsonl')) continue;
      try {
        await ingest(f.abs);
      } catch (e) {
        console.warn(`[session-archive] final ingest failed for ${f.rel}: ${(e as Error)?.message ?? e}`);
      }
    }
  } catch (e) {
    console.warn(`[session-archive] final-ingest enumeration failed: ${(e as Error)?.message ?? e}`);
  }
  const r = deps.store
    ? await archiveAndDeleteSession(ref, deps.store)
    : await archiveAndDeleteSession(ref);
  if (!r.archive.ok) {
    // 'no_files' is normal for --no-session-persistence / already-archived
    // sessions (D-004); anything else deserves a visible line.
    if (r.archive.reason !== 'no_files') {
      console.warn(`[session-archive] adv ${advSessionId} archive failed: ${r.archive.reason}`);
    }
    return { ok: false, reason: r.archive.reason, archive: r.archive };
  }
  if (r.delete && !r.delete.ok) {
    console.warn(
      `[session-archive] adv ${advSessionId} archived but ${r.delete.refused.length} file(s) refused deletion (post-archive writes) — reconciler will re-archive`,
    );
  } else {
    console.log(
      `[session-archive] adv ${advSessionId} (${ref.sourceKind}/${ref.sessionId}): archived ${r.archive.fileCount} file(s), ${r.archive.bytesRaw}B → ${r.archive.bytesStored}B, deleted ${r.delete?.deleted ?? 0}`,
    );
  }
  return { ok: true, archive: r.archive, delete: r.delete };
}

/** The markAdvSessionEnded entry point: flag-gate, settle, run. */
export async function scheduleArchiveForAdvSession(
  advSessionId: number,
  opts?: { delayMs?: number },
): Promise<void> {
  const enabled = await getFlag(FLAGS.SESSION_ARCHIVE_AT_END, 'system').catch(() => false);
  if (!enabled) return;
  const t = setTimeout(() => {
    void runArchiveForAdvSession(advSessionId).catch((e) =>
      console.warn(`[session-archive] adv ${advSessionId} pass failed: ${(e as Error)?.message ?? e}`),
    );
  }, opts?.delayMs ?? SETTLE_DELAY_MS);
  t.unref?.();
}
