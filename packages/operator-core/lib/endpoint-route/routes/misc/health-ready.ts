/**
 * GET /api/health/ready — operator READINESS probe (`/api/health` stays pure
 * liveness).
 *
 * The hono listener binds BEFORE the heavyweight boot legs (DBOS system-DB
 * migration + launch), so a plain HTTP probe declares "up" on a process that
 * can still abort mid-boot. The gym-cycle runner did exactly that: its
 * llms.txt probe passed, the gym-operator then died mid-DBOS-migration
 * (native Napi::Error), and the cycle's first pipeline call surfaced only the
 * downstream wreckage — `column "was_forked_from" does not exist` on the
 * half-migrated dbos schema (EI-368).
 *
 * Semantics: ready = "the shape this host was configured for is up". A host
 * with DBOS enabled (PAPERCUSP_DBOS_ENABLE=1) is ready only once DBOS has
 * actually launched; a host without DBOS is ready as soon as HTTP serves.
 * 200 when ready, 503 while booting. Public + zero-DB for the same reason
 * /api/health is: boot supervisors hold no token yet.
 */
import { defineTool } from '@papercusp/agent-mcp';
import { dbosStarted } from '../../../dbos/bootstrap';

/** Pure readiness predicate (exported for tests). */
export function isReady(args: { dbosEnabled: boolean; dbosLaunched: boolean }): boolean {
  return args.dbosEnabled ? args.dbosLaunched : true;
}

export default defineTool({
  method: 'GET',
  path: '/health/ready',
  auth: 'public',
  handler() {
    const dbosEnabled = process.env.PAPERCUSP_DBOS_ENABLE === '1';
    const dbos = dbosStarted();
    const ready = isReady({ dbosEnabled, dbosLaunched: dbos });
    return Response.json(
      { ok: ready, ready, dbos, dbosEnabled, ts: new Date().toISOString() },
      { status: ready ? 200 : 503 },
    );
  },
});
