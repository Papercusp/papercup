/**
 * psu-pty host-event ingest + retention (psu-pty-turn-boundary-generalization-2026-09-22,
 * P-007 / D-006).
 *
 * THE PROBLEM THIS SOLVES. The psu-pty host records delivery outcomes with appendHostEvent()
 * into one JSONL file per owner. Two things were wrong with that tier:
 *
 *   1. It was UNQUERYABLE. Measured 2026-09-22: 15,014 files, 139 MB, oldest 2026-07-12. A
 *      fleet-wide "what fraction of wakes actually reached their agent" question meant scanning
 *      139 MB of loose files, so in practice nobody asked it.
 *   2. It had NO RETENTION OF ANY KIND. Each file is front-truncated at 256 KB, so a single
 *      file is bounded -- but the POPULATION is not, and had been growing unbounded for ten
 *      weeks. Retention here is therefore about FILE COUNT, not file size.
 *
 * WHY INGEST RATHER THAN MOVE THE WRITE. appendHostEvent is synchronous and fail-soft by
 * contract and runs on teardown/crash paths, so it must not acquire a pool or block (D-006).
 * The file stays the local write-ahead log; this routine is the tier that makes it queryable
 * and bounded.
 *
 * ORDERING IS THE SAFETY PROPERTY. Ingest happens BEFORE GC, and a file is deleted only if its
 * rows are known-persisted. A GC that ran first -- or that deleted a file whose insert failed --
 * would destroy the only copy of exactly the diagnostic rows this plan exists to preserve.
 */
import { createHash } from 'node:crypto';
import { readFile, readdir, stat, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../workspace-registry';

/** How long an ingested row is kept in Postgres before the retention sweep drops it. */
export const HOST_EVENT_ROW_RETENTION_DAYS_DEFAULT = 90;

/**
 * How stale a JSONL file must be before GC may delete it.
 *
 * This is NOT a tuning knob -- it is the liveness guard. A running session appends to its file
 * continuously, so mtime is the evidence that no host still owns it. Deleting a file whose host
 * is alive would truncate that session's log mid-flight and lose rows written between the last
 * ingest and the delete. Keep this comfortably longer than the longest plausible idle gap of a
 * live session.
 */
export const HOST_EVENT_FILE_RETENTION_DAYS_DEFAULT = 14;

/** Bound the work per tick so one sweep cannot monopolise a routine tick or the pool. */
export const HOST_EVENT_MAX_FILES_PER_RUN_DEFAULT = 500;

const DAY_MS = 86_400_000;

export interface PsuPtyHostEventsIngestOptions {
  sql?: Sql;
  workspaceId?: string;
  /** Directory holding the per-owner `<owner>.events.jsonl` files. */
  dir?: string;
  rowRetentionDays?: number;
  fileRetentionDays?: number;
  maxFilesPerRun?: number;
  /** Report what would happen without inserting or deleting anything. */
  dryRun?: boolean;
  now?: () => number;
}

export interface PsuPtyHostEventsIngestResult {
  filesScanned: number;
  filesIngested: number;
  rowsRead: number;
  rowsInserted: number;
  /** Rows the file contained that could not be parsed, or lacked `ts`/`kind`. Never fatal. */
  rowsMalformed: number;
  filesDeleted: number;
  /** Files old enough to GC but NOT deleted because their ingest did not succeed. */
  filesRetainedUningested: number;
  rowsExpired: number;
  rowRetentionDays: number;
  fileRetentionDays: number;
  dryRun: boolean;
}

/** Stable stringify so a digest does not change with JS key insertion order. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
}

/**
 * Dedupe key for one event row.
 *
 * The tuple is JSON-encoded as an ARRAY rather than joined with a separator byte, deliberately.
 * A separator has to be a character that cannot occur in the parts, which pushes toward a
 * control byte such as NUL -- and a raw control byte in source is refused by
 * `lint:no-control-bytes` (a green-checkpoint leg), besides making the file unsearchable by
 * ripgrep and binary to `git diff`. JSON encoding makes the boundaries unambiguous with no
 * separator at all: ["a","bc"] and ["ab","c"] encode differently, so two distinct tuples
 * cannot collide into one digest.
 */
export function hostEventDigest(
  ownerId: string,
  ts: string,
  kind: string,
  payload: Record<string, unknown>,
): string {
  return createHash('sha256').update(canonical([ownerId, ts, kind, payload])).digest('hex');
}

/** `su-abc.events.jsonl` -> `su-abc`; anything else -> null (never guess an owner). */
export function ownerIdFromEventLogFilename(filename: string): string | null {
  const m = /^(.+)\.events\.jsonl$/.exec(filename);
  return m && m[1] ? m[1] : null;
}

interface ParsedRows {
  rows: Array<{
    workspace_id: string;
    owner_id: string;
    ts: string;
    kind: string;
    payload: Record<string, unknown>;
    row_digest: string;
  }>;
  malformed: number;
}

export function parseHostEventFile(
  workspaceId: string,
  ownerId: string,
  text: string,
): ParsedRows {
  const rows: ParsedRows['rows'] = [];
  let malformed = 0;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      // Expected, not exceptional: the file is front-truncated mid-line when it exceeds its
      // size cap, so the FIRST line after a truncation is routinely a partial record. Count it
      // and move on -- refusing the whole file over one severed line would discard the other
      // ~thousand good rows in it.
      malformed++;
      continue;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      malformed++;
      continue;
    }
    const rec = parsed as Record<string, unknown>;
    const ts = typeof rec.ts === 'string' ? rec.ts : null;
    const kind = typeof rec.kind === 'string' ? rec.kind : null;
    if (!ts || !kind || Number.isNaN(Date.parse(ts))) {
      malformed++;
      continue;
    }
    const payload: Record<string, unknown> = { ...rec };
    delete payload.ts;
    delete payload.kind;
    rows.push({
      workspace_id: workspaceId,
      owner_id: ownerId,
      ts,
      kind,
      payload,
      row_digest: hostEventDigest(ownerId, ts, kind, payload),
    });
  }
  return { rows, malformed };
}

export function defaultHostEventDir(): string {
  return process.env.PAPERCUSP_PSU_PTY_DIR || join(homedir(), '.papercusp', 'psu-pty');
}

export async function ingestPsuPtyHostEvents(
  opts: PsuPtyHostEventsIngestOptions = {},
): Promise<PsuPtyHostEventsIngestResult> {
  const sql = opts.sql ?? getOrgPg().sql;
  const ws = opts.workspaceId ?? activeWorkspaceId();
  const dir = opts.dir ?? defaultHostEventDir();
  const now = opts.now ?? Date.now;
  const dryRun = opts.dryRun === true;

  const rowRetentionDays =
    Number.isFinite(opts.rowRetentionDays) && (opts.rowRetentionDays as number) > 0
      ? (opts.rowRetentionDays as number)
      : HOST_EVENT_ROW_RETENTION_DAYS_DEFAULT;
  const fileRetentionDays =
    Number.isFinite(opts.fileRetentionDays) && (opts.fileRetentionDays as number) > 0
      ? (opts.fileRetentionDays as number)
      : HOST_EVENT_FILE_RETENTION_DAYS_DEFAULT;
  const maxFilesPerRun =
    Number.isFinite(opts.maxFilesPerRun) && (opts.maxFilesPerRun as number) > 0
      ? (opts.maxFilesPerRun as number)
      : HOST_EVENT_MAX_FILES_PER_RUN_DEFAULT;

  const result: PsuPtyHostEventsIngestResult = {
    filesScanned: 0,
    filesIngested: 0,
    rowsRead: 0,
    rowsInserted: 0,
    rowsMalformed: 0,
    filesDeleted: 0,
    filesRetainedUningested: 0,
    rowsExpired: 0,
    rowRetentionDays,
    fileRetentionDays,
    dryRun,
  };

  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    // No directory yet (a box that has never run a psu session) is a no-op, not a failure.
    return result;
  }

  const candidates = entries.filter((e) => e.endsWith('.events.jsonl')).slice(0, maxFilesPerRun);
  const fileGcCutoff = now() - fileRetentionDays * DAY_MS;

  for (const filename of candidates) {
    const ownerId = ownerIdFromEventLogFilename(filename);
    if (!ownerId) continue;
    const path = join(dir, filename);
    result.filesScanned++;

    let text: string;
    let mtimeMs: number;
    try {
      const st = await stat(path);
      mtimeMs = st.mtimeMs;
      text = await readFile(path, 'utf8');
    } catch {
      // Raced with the owning host (rotation, or the session ended and cleaned up). Skip.
      continue;
    }

    const { rows, malformed } = parseHostEventFile(ws, ownerId, text);
    result.rowsRead += rows.length;
    result.rowsMalformed += malformed;

    let ingested = false;
    if (rows.length === 0) {
      // An empty/unparseable file has nothing to lose, so it is safe to let GC consider it.
      ingested = true;
    } else if (dryRun) {
      ingested = true;
    } else {
      try {
        // Chunked so one enormous file cannot build a single oversized statement.
        for (let i = 0; i < rows.length; i += 500) {
          const chunk = rows.slice(i, i + 500);
          // JSONB BINDING ON THIS CLIENT IS A FOOTGUN WITH TWO OPPOSITE WRONG ANSWERS, so it
          // is spelled out rather than left for the next reader to rediscover:
          //   - sql.json() THROWS on the getOrgPg client ("Buffer.byteLength received Object",
          //     EI-607 / agent-insights/postgres-js-jsonb-binding); and
          //   - on the default-config db() pool the opposite holds -- JSON.stringify there
          //     DOUBLE-ENCODES, storing a jsonb STRING that reads back as a string.
          // This is the getOrgPg client, so it needs the explicit stringify + ::jsonb cast.
          //
          // The multi-row `sql(rows, ...cols)` helper has nowhere to put a per-column cast,
          // which is also why it does not typecheck here (TS2769: a Record<string, unknown>
          // is not a bindable parameter). UNNEST of one array per column keeps it to a single
          // statement per chunk AND makes every column's type explicit at the boundary.
          const inserted = await sql`
            INSERT INTO harness_shared.psu_pty_host_events
                        (workspace_id, owner_id, ts, kind, payload, row_digest)
                 SELECT * FROM unnest(
                          ${chunk.map((r) => r.workspace_id)}::text[],
                          ${chunk.map((r) => r.owner_id)}::text[],
                          ${chunk.map((r) => r.ts)}::timestamptz[],
                          ${chunk.map((r) => r.kind)}::text[],
                          ${chunk.map((r) => JSON.stringify(r.payload))}::jsonb[],
                          ${chunk.map((r) => r.row_digest)}::text[]
                        )
            ON CONFLICT (row_digest) DO NOTHING
          `;
          result.rowsInserted += inserted.count ?? 0;
        }
        ingested = true;
      } catch {
        // Leave the file alone. An un-ingested file MUST NOT be GC'd below.
        ingested = false;
      }
    }
    if (ingested) result.filesIngested++;

    if (mtimeMs < fileGcCutoff) {
      if (!ingested) {
        result.filesRetainedUningested++;
      } else if (!dryRun) {
        try {
          await unlink(path);
          result.filesDeleted++;
        } catch {
          /* another sweep or the host removed it first */
        }
      } else {
        result.filesDeleted++;
      }
    }
  }

  if (!dryRun) {
    const expired = await sql`
      DELETE FROM harness_shared.psu_pty_host_events
       WHERE workspace_id = ${ws}
         AND ts < now() - ${`${rowRetentionDays} days`}::interval
    `;
    result.rowsExpired = expired.count ?? 0;
  }

  return result;
}
