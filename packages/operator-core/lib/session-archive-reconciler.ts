/**
 * session-archive-reconciler.ts — the BACKSTOP sweep
 * (plan session-db-archive-retire-dirs-2026-07-10 P-006, owner Q4).
 *
 * The fast path (session-archive-hook, fired from markAdvSessionEnded) misses
 * sessions whose process died without stamping: kill -9, OOM, host crash,
 * operator down at exit — the exact ghost class idle-session-reaper exists
 * for. This reconciler applies the same two-path doctrine to ARCHIVAL, one
 * bounded, idempotent tick at a time (hourly via periodic-workflows):
 *
 *  (a) DB-side: adv_sessions WHERE ended_at IS NOT NULL AND archived_at IS
 *      NULL (the migration-539 partial index) → runArchiveForAdvSession.
 *      Rows with NOTHING to archive (no native id, files already gone, a
 *      --no-session-persistence run — D-004) are stamped archived_at after a
 *      grace period so they leave the scan set: adv.archived_at means "needs
 *      no further archive attention"; the session_archives stamp row is the
 *      actual "archive exists" marker.
 *
 *  (b) disk-side: per-session dirs (claude owner dirs, codex homes — the
 *      session-dir-gc roots) whose identity is NOT in the live protected set
 *      (open adv row / live presence / running bee / armed wake — reused
 *      VERBATIM from session-dir-gc so the reapers can never disagree, the
 *      EI-311 rule) → every un-archived session id inside gets
 *      archive+delete; already-archived leftovers get the sha-checked delete.
 *      This same sweep IS the engine of the P-011 backlog drain. omp
 *      transcripts (flat files, no per-session dir) get the same treatment
 *      with an mtime grace, since a live omp session keeps its file fresh.
 *
 * Dir REMOVAL stays session-dir-gc's job — this module only ever removes the
 * files it has verifiably archived.
 */

import { join } from 'node:path';
import { readdir } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { getOrgPg } from '@papercusp/db-org';
import {
  defaultSessionDirRoots,
  gatherProtectedSessionIdentity,
  isProtected,
  sessionDirKey,
  type ProtectedSessionIdentity,
  type SessionDirRoot,
} from './session-dir-gc';
import { ompSessionsRoot } from './omp-sessions';
import { runArchiveForAdvSession, type ArchiveHookResult } from './session-archive-hook';
import {
  archiveAndDeleteSession,
  collectSessionFiles,
  deleteArchivedSessionFiles,
  listClaudeSessionIds,
  listCodexRolloutSessionIds,
  pgSessionArchiveStore,
  type SessionArchiveStore,
} from './session-archive';

/** Per-tick bounds — the reconciler converges over ticks, never gulps.
 *  DB rows are scanned wide (a stamp-out of a nothing-to-archive row is one
 *  cheap UPDATE — the pre-plan backlog is ~19k such rows) while actual
 *  ARCHIVE work per tick is capped separately. */
const MAX_DB_ROWS_PER_TICK = 500;
const MAX_DB_ARCHIVES_PER_TICK = 50;
const MAX_DIRS_PER_TICK = 100;
const MAX_OMP_FILES_PER_TICK = 200;
/** ended_at must be at least this old before a nothing-to-archive row is
 *  stamped out of the scan set (gives a slow final flush every chance). */
const NOTHING_TO_ARCHIVE_GRACE_MS = 60 * 60 * 1000;
/** An omp transcript must be quiet this long before the disk sweep takes it —
 *  a LIVE omp session keeps appending, so its mtime stays fresh. */
const OMP_FILE_GRACE_MS = 24 * 60 * 60 * 1000;
/** claude/codex session files must be quiet this long before the disk sweep
 *  touches them (WI-3859 F5). A raw/untracked resumed session has NO adv row
 *  and NO presence — the protected set cannot see it; its only signal is a
 *  fresh mtime. Without this grace the sweep would archive and DELETE a live
 *  transcript out from under the CLI that is appending to it. */
const QUIET_FILE_GRACE_MS = 60 * 60 * 1000;

export interface ReconcilerDb {
  listEndedUnarchived(limit: number): Promise<Array<{ id: number; endedAtMs: number }>>;
  stampArchivedAt(advSessionId: number): Promise<void>;
  countEndedUnarchived(): Promise<number>;
}

function pgReconcilerDb(): ReconcilerDb {
  return {
    async listEndedUnarchived(limit) {
      const { sql } = getOrgPg();
      const rows = await sql<Array<{ id: number; ended_at: Date }>>`
        SELECT id, ended_at FROM harness_shared.adv_sessions
         WHERE ended_at IS NOT NULL AND archived_at IS NULL
         ORDER BY ended_at ASC
         LIMIT ${limit}`;
      return rows.map((r) => ({ id: r.id, endedAtMs: new Date(r.ended_at).getTime() }));
    },
    async stampArchivedAt(advSessionId) {
      const { sql } = getOrgPg();
      await sql`
        UPDATE harness_shared.adv_sessions SET archived_at = now()
         WHERE id = ${advSessionId} AND archived_at IS NULL`;
    },
    async countEndedUnarchived() {
      const { sql } = getOrgPg();
      const rows = await sql<Array<{ n: string | number }>>`
        SELECT count(*) AS n FROM harness_shared.adv_sessions
         WHERE ended_at IS NOT NULL AND archived_at IS NULL`;
      return Number(rows[0]?.n ?? 0);
    },
  };
}

export interface ReconcileStats {
  dbScanned: number;
  dbArchived: number;
  /** Nothing-to-archive rows stamped out of the scan set (post-grace). */
  dbStampedEmpty: number;
  dbFailed: number;
  diskDirsScanned: number;
  diskSessionsArchived: number;
  diskLeftoversDeleted: number;
  diskFailed: number;
  /** Sessions skipped this tick: files still CHANGING (possibly a live
   *  untracked session the protected set cannot see) — retried once quiet. */
  diskSkippedFresh: number;
  ompFilesArchived: number;
  /** Gauge after the tick — the P-007 watchdog reads this trend. */
  endedUnarchivedRemaining: number;
  /** Set when the disk-side sweep was ABORTED before touching anything
   *  (fail-closed, mirrors session-dir-gc's degraded abort). */
  skippedDisk?: 'degraded-protected-set';
}

export interface ReconcilerDeps {
  db?: ReconcilerDb;
  store?: SessionArchiveStore;
  dirRoots?: SessionDirRoot[];
  ompRoot?: string;
  protectedIdentity?: ProtectedSessionIdentity;
  runAdvArchive?: (advSessionId: number) => Promise<ArchiveHookResult>;
  nowMs?: number;
}

async function dirents(dir: string): Promise<Dirent[]> {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

export async function runSessionArchiveReconcileOnce(deps: ReconcilerDeps = {}): Promise<ReconcileStats> {
  const db = deps.db ?? pgReconcilerDb();
  const store = deps.store ?? pgSessionArchiveStore();
  const nowMs = deps.nowMs ?? Date.now();
  const runAdv = deps.runAdvArchive ?? ((id: number) => runArchiveForAdvSession(id, { store }));
  const stats: ReconcileStats = {
    dbScanned: 0,
    dbArchived: 0,
    dbStampedEmpty: 0,
    dbFailed: 0,
    diskDirsScanned: 0,
    diskSessionsArchived: 0,
    diskLeftoversDeleted: 0,
    diskFailed: 0,
    diskSkippedFresh: 0,
    ompFilesArchived: 0,
    endedUnarchivedRemaining: 0,
  };

  // ── (a) DB-side: ended-but-unarchived adv rows ──────────────────────────
  for (const row of await db.listEndedUnarchived(MAX_DB_ROWS_PER_TICK)) {
    if (stats.dbArchived >= MAX_DB_ARCHIVES_PER_TICK) break; // archive-work cap; stamps stay cheap
    stats.dbScanned++;
    try {
      const r = await runAdv(row.id);
      if (r.ok) {
        stats.dbArchived++; // runArchiveForAdvSession stamps adv via the store
      } else if (
        (r.reason === 'no_files' || r.reason === 'unresolvable' || r.reason === 'row_not_found') &&
        nowMs - row.endedAtMs > NOTHING_TO_ARCHIVE_GRACE_MS
      ) {
        await db.stampArchivedAt(row.id);
        stats.dbStampedEmpty++;
      } else if (!r.ok && r.reason !== 'no_files' && r.reason !== 'unresolvable') {
        stats.dbFailed++;
      }
    } catch (e) {
      stats.dbFailed++;
      console.warn(`[session-archive-reconciler] adv ${row.id}: ${(e as Error)?.message ?? e}`);
    }
  }

  // ── (b) disk-side: unprotected per-session dirs with un-archived files ──
  const prot = deps.protectedIdentity ?? (await gatherProtectedSessionIdentity());
  // FAIL CLOSED (WI-3859 F3, mirrors runSessionDirGc): the protected-set reads
  // fail OPEN per-source, so a degraded set is INCOMPLETE — sweeping against it
  // with a working archive PG would archive and DELETE a live session's files
  // mid-flight. Skip the whole disk side this tick; the next one sweeps.
  if (prot.degraded) {
    console.warn(
      '[session-archive-reconciler] protected-set read DEGRADED (presence/PG unavailable) — disk-side sweep SKIPPED, nothing touched',
    );
    stats.skippedDisk = 'degraded-protected-set';
  }
  let dirBudget = stats.skippedDisk ? 0 : MAX_DIRS_PER_TICK;
  for (const rootSpec of deps.dirRoots ?? defaultSessionDirRoots()) {
    if (dirBudget <= 0) break;
    const sourceKind = rootSpec.keyKind === 'owner' ? ('claude' as const) : ('codex' as const);
    for (const d of await dirents(rootSpec.root)) {
      if (dirBudget <= 0) break;
      if (!d.isDirectory()) continue;
      const key = sessionDirKey(d.name, rootSpec.keyKind);
      if (isProtected({ keyKind: rootSpec.keyKind, key }, prot)) continue;
      const dirPath = join(rootSpec.root, d.name);
      const ids =
        sourceKind === 'claude'
          ? await listClaudeSessionIds(dirPath)
          : await listCodexRolloutSessionIds(dirPath);
      if (!ids.length) continue; // nothing archivable — dir removal is session-dir-gc's job
      dirBudget--;
      stats.diskDirsScanned++;
      for (const sessionId of ids) {
        try {
          // Quiet grace (WI-3859 F5): a fresh mtime may be a LIVE session the
          // protected set cannot see (a raw/untracked resume has no adv row
          // and no presence). Only touch sessions whose files stopped changing.
          const collected = await collectSessionFiles({ sourceKind, sessionId, sessionRoot: dirPath });
          const newestMs = collected.reduce((mx, f) => Math.max(mx, f.mtimeMs), 0);
          if (collected.length && nowMs - newestMs < QUIET_FILE_GRACE_MS) {
            stats.diskSkippedFresh++;
            continue;
          }
          if (await store.readStamp(sourceKind, sessionId)) {
            const del = await deleteArchivedSessionFiles(
              { sourceKind, sessionId, sessionRoot: dirPath },
              store,
            );
            stats.diskLeftoversDeleted += del.deleted;
            if (!del.ok && del.refused.length) {
              // bytes drifted since the stamp — re-archive fresh, then delete
              const r = await archiveAndDeleteSession(
                {
                  sourceKind,
                  sessionId,
                  sessionRoot: dirPath,
                  owner: sourceKind === 'claude' ? d.name : null,
                  advSessionId: sourceKind === 'codex' ? Number(key) || null : null,
                  archivedBy: 'reconciler',
                },
                store,
              );
              if (r.archive.ok) stats.diskSessionsArchived++;
            }
            continue;
          }
          const r = await archiveAndDeleteSession(
            {
              sourceKind,
              sessionId,
              sessionRoot: dirPath,
              owner: sourceKind === 'claude' ? d.name : null,
              advSessionId: sourceKind === 'codex' ? Number(key) || null : null,
              archivedBy: 'reconciler',
            },
            store,
          );
          if (r.archive.ok) stats.diskSessionsArchived++;
          else if (r.archive.reason !== 'no_files') stats.diskFailed++;
        } catch (e) {
          stats.diskFailed++;
          console.warn(
            `[session-archive-reconciler] ${sourceKind}/${sessionId} @ ${dirPath}: ${(e as Error)?.message ?? e}`,
          );
        }
      }
    }
  }

  // ── (b′) omp: flat transcripts, mtime-graced ────────────────────────────
  const ompRoot = deps.ompRoot ?? ompSessionsRoot();
  let ompBudget = MAX_OMP_FILES_PER_TICK;
  for (const d of await dirents(ompRoot)) {
    if (ompBudget <= 0) break;
    if (!d.isDirectory()) continue;
    for (const f of await dirents(join(ompRoot, d.name))) {
      if (ompBudget <= 0) break;
      if (!f.isFile() || !f.name.endsWith('.jsonl')) continue;
      const stem = f.name.slice(0, -'.jsonl'.length);
      const us = stem.indexOf('_');
      const sessionId = us >= 0 ? stem.slice(us + 1) : stem;
      try {
        const { lstat } = await import('node:fs/promises');
        const st = await lstat(join(ompRoot, d.name, f.name));
        if (!st.isFile() || nowMs - st.mtimeMs < OMP_FILE_GRACE_MS) continue;
        ompBudget--;
        if (await store.readStamp('omp', sessionId)) {
          const del = await deleteArchivedSessionFiles(
            { sourceKind: 'omp', sessionId, sessionRoot: ompRoot },
            store,
          );
          stats.diskLeftoversDeleted += del.deleted;
          continue;
        }
        const r = await archiveAndDeleteSession(
          { sourceKind: 'omp', sessionId, sessionRoot: ompRoot, archivedBy: 'reconciler' },
          store,
        );
        if (r.archive.ok) stats.ompFilesArchived++;
      } catch (e) {
        stats.diskFailed++;
        console.warn(`[session-archive-reconciler] omp/${sessionId}: ${(e as Error)?.message ?? e}`);
      }
    }
  }

  try {
    stats.endedUnarchivedRemaining = await db.countEndedUnarchived();
  } catch {
    /* gauge is best-effort */
  }
  return stats;
}
