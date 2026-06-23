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

import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { PgCoordLog, DEFAULT_COORD_WORKSPACE } from '@papercusp/coordination/event-log';
import type { CoordEventLog } from '@papercusp/coordination/event-log';
import { FLAGS } from '@papercusp/flags';
import { getFlag, onFlagChange } from '@papercusp/flags/server';
import { activeWorkspaceId } from '../../workspace-registry';
import { systemDistinctId } from '../../flag-distinct-id';

// workspace-data-isolation-leaks-2026-06-17 F-C1: scope the coord plane to the
// ACTIVE workspace instead of the single shared `default` partition — flag-gated
// (papercusp-coord-per-workspace, default OFF, a reversible kill-switch). The
// PgCoordLog resolver must be SYNC, so cache the flag (machine-global) refreshed on
// an initial read + every flag change — exactly the lexicon/configure.ts pattern.
// While the cache is unloaded it reads false ⇒ 'default' (today's behavior, safe).
let coordPerWorkspaceOn = false;
/**
 * Re-read the COORD_PER_WORKSPACE flag into the sync cache. Fired on an initial
 * read + every flag change (the lexicon/configure.ts pattern). Exported so tests
 * can drive the cache DETERMINISTICALLY (set a flag override → await this →
 * assert) instead of racing the fire-and-forget module-load refresh — which is
 * brittle once the flag's DEFAULT flips (it graduated default-ON in WI-599).
 */
export async function refreshCoordPerWorkspace(): Promise<void> {
  try {
    coordPerWorkspaceOn = await getFlag(FLAGS.COORD_PER_WORKSPACE, systemDistinctId());
  } catch {
    coordPerWorkspaceOn = false;
  }
}
void refreshCoordPerWorkspace();
onFlagChange((key) => {
  if (key === null || key === FLAGS.COORD_PER_WORKSPACE) void refreshCoordPerWorkspace();
});

/** The coord scope to use NOW (F-C1): the request's active workspace when the
 *  flag is ON, else the legacy shared `default` partition. */
export function coordScopeWorkspace(): string {
  return coordPerWorkspaceOn ? activeWorkspaceId() : DEFAULT_COORD_WORKSPACE;
}

function makeDefaultLog(): CoordEventLog {
  return new PgCoordLog({
    getSql: () => getOrgPg().sql,
    // Tables are defined by the migration baseline now; the host seam is a no-op.
    ensureSchema: async () => {},
    // F-C1: resolve the workspace per call (flag-gated) so one operator coordLog
    // scopes coord to the request's workspace instead of one shared partition.
    getWorkspaceId: () => coordScopeWorkspace(),
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
  readEventsBounded: (surface, opts) => impl.readEventsBounded(surface, opts),
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

/**
 * The postgres handle the currently-configured backend reads/writes. A targeted
 * `coord_event_log` query (e.g. readAckedMsgIds' fast path) must run on THIS
 * handle — in production it's `getOrgPg().sql`, but a swapped seam (tests, a
 * non-default backend) points at a different DB, so reaching for `getOrgPg()`
 * independently would query the wrong database. Backends without a PG handle
 * (the in-memory double) fall back to `getOrgPg().sql` — those tests don't drive
 * the PG fast path.
 */
export function coordSql(): Sql {
  const maybe = impl as Partial<{ getSql: () => Sql }>;
  return typeof maybe.getSql === 'function' ? maybe.getSql() : getOrgPg().sql;
}

/**
 * Whether the currently-configured backend is the PG one — i.e. a targeted
 * `coord_event_log` query through `coordSql()` will hit the SAME store the seam
 * reads/writes. A swapped seam without a PG handle (the in-memory / fs double
 * used in tests) returns false: there `coordSql()` falls back to `getOrgPg()`,
 * which is a DIFFERENT (empty/unrelated) store, so a raw fast-path query would
 * silently return zero rows instead of the double's seeded data. Callers running
 * an EI-401-style SQL pushdown (readInbox / readAckedMsgIds) gate on this so the
 * pushdown is taken ONLY when it's guaranteed to read the seam's own store, and
 * the in-memory/fs seam keeps using the seam's `readLines` (correct, just slower).
 */
export function coordHasPgFastPath(): boolean {
  return typeof (impl as Partial<{ getSql: () => Sql }>).getSql === 'function';
}
