import { createHash } from 'node:crypto';

const refuse = (reason) => { throw new Error(`restore_resume_refused: ${reason}`); };

/**
 * Plan a --use-list for a strict PG 18 parallel restore interrupted during INDEX
 * work. This is evidence parsing, not target reconciliation or permission to
 * restart a server. The caller must establish archive/target identity, stopped
 * workers, transaction rollback, and its cleanup deadline before executing it.
 *
 * PostgreSQL pg_backup_archiver.c emits serial "processing item" immediately
 * before restore_toc_entry(), then enters the parallel loop after that serial
 * prefix has returned. Parallel "finished item" precedes status handling, so
 * ANY error invalidates this evidence. Missing markers never mean missing data.
 */
export function planPgRestoreResume({ toc, log, exitOnError, interrupted }) {
  if (exitOnError !== true || interrupted !== true) refuse('strict interrupted attempt required');
  if (typeof toc !== 'string' || typeof log !== 'string') refuse('complete TOC and log required');
  if (!/^;\s+Dumped by pg_dump version: 18\./m.test(toc)) refuse('unsupported archive log protocol');
  // Leader/worker stderr can concatenate or double their prefixes. Recover
  // lifecycle record boundaries before anchoring; otherwise a completed index
  // can look unfinished and be scheduled a second time.
  const records = log.replace(/pg_restore: (?=(?:processing|launching|finished) item \d+ |entering main parallel loop|finished main parallel loop)/g, '\npg_restore: ');
  if (/pg_restore: (?:error|warning|fatal):|^\s*(?:ERROR|FATAL|PANIC|WARNING):|errors ignored on restore|worker process failed/mi.test(log))
    refuse('native error invalidates completion markers');
  const transition = 'pg_restore: entering main parallel loop';
  const parts = records.split(transition);
  if (parts.length !== 2 || /pg_restore: finished main parallel loop/.test(parts[1]))
    refuse('one interrupted parallel phase required');

  const entries = new Map();
  for (const line of toc.split('\n')) {
    if (!line || line.startsWith(';')) continue;
    const match = /^(\d+); \d+ \d+ (.+)$/.exec(line);
    if (!match) refuse('malformed TOC entry');
    const id = Number(match[1]);
    if (!Number.isSafeInteger(id) || id < 1 || entries.has(id)) refuse('invalid or duplicate TOC id');
    entries.set(id, { line, description: match[2] });
  }
  if (!entries.size) refuse('empty TOC');
  const serial = new Set();
  const completed = new Set();
  for (const match of parts[0].matchAll(/^pg_restore: processing item (\d+) (.+)$/gm)) {
    const id = Number(match[1]);
    if (serial.has(id)) refuse('repeated serial item');
    serial.add(id);
    // Native session/database pseudo-items can be absent from --list output.
    if (!entries.has(id)) {
      if (!/^(?:ENCODING |STDSTRINGS |SEARCHPATH |DATABASE )/.test(match[2]))
        refuse('serial item absent from pinned TOC');
    } else completed.add(id);
  }
  if (!serial.size) refuse('serial prefix missing');
  const launched = new Set();
  const finished = new Set();
  for (const match of parts[1].matchAll(/^pg_restore: (launching|finished) item (\d+) (.+)$/gm)) {
    const id = Number(match[2]);
    if (!entries.has(id) || completed.has(id)) refuse('parallel item absent or already completed');
    if (match[1] === 'launching') {
      if (launched.has(id)) refuse('repeated parallel launch');
      launched.add(id);
    } else {
      if (!launched.has(id) || finished.has(id)) refuse('unmatched parallel completion');
      finished.add(id);
    }
  }
  const inFlight = [...launched].filter(id => !finished.has(id));
  if (!inFlight.length || inFlight.some(id => !entries.get(id).description.startsWith('INDEX ')))
    refuse('only interrupted atomic INDEX work is supported');
  for (const id of finished) completed.add(id);
  const remaining = [...entries.keys()].filter(id => !completed.has(id));
  const remainingList = toc.split('\n').map(line => {
    const match = /^(\d+);/.exec(line);
    return match && completed.has(Number(match[1])) ? `; completed by prior strict restore: ${line}` : line;
  }).join('\n');
  const sha256 = text => createHash('sha256').update(text).digest('hex');
  return {
    protocol: 'pg18-interrupted-parallel-index-v1',
    tocSha256: sha256(toc), logSha256: sha256(log), remainingList,
    completedIds: [...completed].sort((a, b) => a - b),
    remainingIds: remaining, inFlightIds: inFlight,
  };
}
