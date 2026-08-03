/**
 * GET /api/internal/managed-timers — THIS process's live managed-timer registry.
 *
 * The federation seam for `schedule:inventory` (EI-19445595198254637). Every
 * operator-shaped process on the box — the operator (:3070), staging (:3170),
 * `papercup-bg-host.service` (:3271) — boots the same `bin/hono-host.ts`, so every
 * one of them serves this route, and each answers about ITSELF. The operator's
 * inventory fans out over them (`schedule-federation.ts`) so a timer armed in
 * bg-host stops being structurally invisible to the surface built to inventory
 * timers.
 *
 * Two properties are load-bearing, not incidental:
 *
 * 1. **Pure in-memory.** `listManaged()` reads a module-scoped registry: no PG, no
 *    DBOS, no filesystem. That matters because the sibling most worth probing
 *    (bg-host) is also the one most likely to be contended — probing it must add no
 *    I/O of its own. This is deliberately NOT `collectScheduleInventory()`, which
 *    queries Postgres and DBOS and is the call that was measured returning zero
 *    bytes for 45s against :3271 (EI-19446421329946902).
 *
 * 2. **Never 5xx.** A registry read that throws is reported in the 200 body as
 *    `ok: false` + `error`, mirroring the PASS-WITH-NOTE contract of the sibling
 *    canary routes. A broken probe apparatus must not read to a naive caller as
 *    "this process is unhealthy".
 *
 * `auth: 'loopback'` — the only caller is another operator process on the same box.
 */
import { defineTool } from '@papercusp/agent-mcp';
import { listManaged } from '@papercusp/scheduled-registry';
import { describeProcessRole, ownHonoPort } from '../../../schedule-federation';

export default defineTool({
  method: 'GET',
  path: '/internal/managed-timers',
  auth: 'loopback',
  handler() {
    const identity = {
      process: describeProcessRole(),
      pid: process.pid,
      port: ownHonoPort(),
      uptimeSec: Math.round(process.uptime()),
    };
    try {
      return Response.json({ ok: true, ...identity, timers: listManaged() });
    } catch (e) {
      return Response.json({
        ok: false,
        ...identity,
        timers: [],
        error: e instanceof Error ? e.message : String(e),
      });
    }
  },
});
