/**
 * emit-session-compacted.ts — the bridge CLI that fires `session:compacted:<owner>`
 * after a psu /compact completes (event-await-discoverability-and-coverage-2026-07-03
 * P-103; the linchpin of the host wire — without it the host's spawn is a fail-soft
 * no-op and NO session-compacted event ever fires).
 *
 * WHO SPAWNS IT: apps/operator/scripts/psu-pty-host.mjs → fireSessionCompactedEvent
 * (step 4 of the mode:'compact' handler, once the output-idle busy-gate confirms the
 * compaction turn settled — never on the done.deferred drop). The host is a
 * deliberately-minimal standalone Node process (fs/net/pty only — NO PG pool, NO
 * operator HTTP client), so it CANNOT emit in-process; it spawns THIS short-lived,
 * detached `tsx` CLI, which DOES reach org-PG:
 *
 *   npx tsx emit-session-compacted.ts <ownerId> <focus?>
 *
 * CONNECTION: getOrgPg() (inside the emit chain) self-resolves org-PG from
 * ~/.papercusp/embedded-pg.json (or the native :5432 fallback) — no DATABASE_URL is
 * handed in. The emit fires into the single coord workspace (store.ts `eventsWs()`
 * pins DEFAULT_COORD_WORKSPACE), the same namespace every `events:await` registers
 * under, so the waiter's key matches regardless of who scoped what.
 *
 * LIFECYCLE: await the emit (awaits fired + wake deliveries durably queued in PG),
 * then process.exit(0) — postgres.js holds the event loop open, and the operator's
 * await sweeper (≤30s) delivers the queued wakes, so this process has nothing left to
 * do once the rows are committed.
 *
 * FAIL-SOFT: ANY failure (missing args, PG unreachable, emit error) exits 0 with a
 * stderr note — a missing compaction-wake must never surface as a host/session error,
 * and the awaiter still has its own timeout as the backstop.
 */

import {
  emitSessionCompactedEventAsync,
  parseSessionCompactedArgv,
} from '@papercusp/operator-core/lib/session-compacted-events';

async function main(): Promise<void> {
  const parsed = parseSessionCompactedArgv(process.argv);
  if (!parsed) {
    // No ownerId — nothing to fire (the host guards ownerId, but be defensive).
    process.exit(0);
  }
  try {
    await emitSessionCompactedEventAsync(parsed.owner, parsed.focus);
  } catch (e) {
    // Fail-soft: the wake is best-effort; the awaiter's timeout is the backstop.
    console.error(
      `[emit-session-compacted] emit failed for ${parsed.owner}: ${e instanceof Error ? e.message : String(e)}`,
    );
  } finally {
    // postgres.js keeps the process alive; exit explicitly once the emit has committed.
    process.exit(0);
  }
}

void main();
