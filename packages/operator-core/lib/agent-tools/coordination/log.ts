/**
 * log.ts — the operator's single CoordEventLog instance. Every extracted
 * channel module (messages, handoffs, escalations, plan-events) reads/writes
 * through this one seam.
 *
 * Backend: `PgCoordLog` over the org embedded-pg handle —
 * `harness_shared.coord_event_log`, workspace-scoped (default 'default',
 * parity with coord_presence). This is the FS→PG cutover
 * (coord-channels-pg-port P-005 / D-001 / D-002): channels now live in
 * Postgres alongside presence, not in `coord/*.jsonl`. The two host seams
 * are injected exactly as presence.ts wires PgPresenceStore — the org PG
 * handle (`getSql`) and the flag-gated table bootstrap (`ensureSchema`).
 */

import { getOrgPg } from '@papercusp/db-org';
import { PgCoordLog, DEFAULT_COORD_WORKSPACE } from '@papercusp/coordination/event-log';
import type { CoordEventLog } from '@papercusp/coordination/event-log';

function makeDefaultLog(): CoordEventLog {
  return new PgCoordLog({
    getSql: () => getOrgPg().sql,
    // Tables are defined by the migration baseline now; the host seam is a no-op.
    ensureSchema: async () => {},
  });
}

let impl: CoordEventLog = makeDefaultLog();

/**
 * Swap the backing CoordEventLog. Tests inject `new InMemoryCoordLog()` so the
 * channel modules exercise the real fold logic without touching — and
 * polluting — the live `harness_shared.coord_event_log`. Call `resetCoordLog()`
 * in afterEach to restore the PG backend.
 */
export function configureCoordLog(next: CoordEventLog): void {
  impl = next;
}

/** Restore the default PgCoordLog backend (afterEach in tests). */
export function resetCoordLog(): void {
  impl = makeDefaultLog();
}

/**
 * The operator's single CoordEventLog seam. A stable object that delegates to
 * the currently-configured backend, so the channel modules can `import
 * { coordLog }` once while tests swap the implementation underneath.
 */
export const coordLog: CoordEventLog = {
  appendLine: (surface, writerKey, line) => impl.appendLine(surface, writerKey, line),
  readLines: (surface, opts) => impl.readLines(surface, opts),
  putEvent: (surface, msgId, record) => impl.putEvent(surface, msgId, record),
  readEvents: (surface) => impl.readEvents(surface),
  getEvent: (surface, msgId) => impl.getEvent(surface, msgId),
};

/**
 * The coordination workspace the currently-configured backend reads/writes.
 * A caller running its OWN targeted `coord_event_log` query (e.g.
 * readAckedMsgIds' fast path) scopes it to THIS workspace so it stays
 * consistent with `coordLog.readLines` / `appendLine` — never assuming
 * `'default'`. PG backends expose `workspaceId`; the in-memory double and any
 * other generic backend don't, so fall back to the default scope.
 */
export function coordWorkspaceId(): string {
  return (impl as Partial<{ workspaceId: string }>).workspaceId ?? DEFAULT_COORD_WORKSPACE;
}
