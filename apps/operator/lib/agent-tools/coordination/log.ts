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

import { getOrgPg } from '@restart/db-org';
import { PgCoordLog } from '@papercusp/coordination/event-log';
import { ensureCoordEventLogTable } from '@/lib/ensure-schema';

export const coordLog = new PgCoordLog({
  getSql: () => getOrgPg().sql,
  ensureSchema: ensureCoordEventLogTable,
});
