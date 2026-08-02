/**
 * Self-rebinding accessor for LONG-LIVED admin pools (EI-19306394439939264).
 *
 * ## Why this exists
 *
 * A cached pool must never outlive the URL that justified it. `connection.ts` learned
 * that the hard way (EI-19285027465993737) and fixed it for the two MANAGED admin
 * clients by tracking the URL each pool was ACTUALLY BUILT WITH and rebinding through
 * {@link endStalePool}. The insight there is the load-bearing one: every earlier guard
 * asked *"what SHOULD we connect to?"*, and none asked *"what is the live pool actually
 * bound to?"* — so URL resolution kept returning the correct address the whole time the
 * pool was serving a dead one.
 *
 * That fix did not reach the ~25 hand-rolled module-scoped pools built as
 * `postgres(getHarnessAdminUrl(), { ...longLivedPoolConnectionOptions(label) })`, which
 * cache a pool in a module-level `let` and track no URL at all. They are the population
 * that actually failed on 2026-08-01 (WI-6739): `[await-event]`, `[harness-status-sweep]`,
 * `[expirable-registry]` and `[sync-sse] notify` logged 20,144 × `connect ECONNREFUSED
 * 127.0.0.1:20216` — a dead embedded-pg port — for ~100 minutes, until a manual restart.
 *
 * The outage was self-healable and simply did not self-heal. `:3070` has no `DATABASE_URL`
 * in the release `.env.local`, so it resolves via DISCOVERY; when the desktop's embedded PG
 * died and `~/.papercusp/embedded-pg.json` emptied, `getHarnessAdminUrl()` began correctly
 * returning the healthy native `:5432` fallback. A pool that compared itself against that
 * would have rebound on its very next use. These pools never asked.
 *
 * ## What this gives a call site
 *
 * Replace the module-level `let pool` + lazy `postgres(...)` with one call. On every use it
 * re-resolves the admin URL and, if the endpoint moved since the pool was built, drains the
 * stale pool (best-effort, non-blocking) and rebuilds. When the URL is stable — the
 * overwhelming common case — it returns the identical cached instance, so this is
 * behaviour-preserving apart from the rebind.
 *
 *   const db = () => getLongLivedAdminPool('operator-continue-chains', { max: 4, prepare: false });
 *
 * `longLivedPoolConnectionOptions(label)` (pg_stat_activity attribution + dead-client
 * zombie-detection GUCs) and `poolIdleTimeoutSec()` (postgres-js defaults `idle_timeout`
 * to 0 = never close, the root cause of a past saturation crit) are applied for you, so a
 * migrated site cannot forget either. `extra` is spread LAST so a call site keeps the final
 * say on `max`/`prepare`/`onnotice`.
 *
 * ## Deliberately NOT for LISTEN connections
 *
 * A `LISTEN` connection carries subscription state that a silent rebuild would drop: the
 * caller would keep a live handle that no longer receives notifications — a worse failure
 * than the one being fixed, because it is silent. Those sites (e.g. `pending-events-listener`,
 * `coord-inbox-bus`) need a rebind that also re-issues their `LISTEN`, which belongs with the
 * code that owns the subscription. Use this for TRANSACTIONAL pools only.
 */
import postgres from 'postgres';
import { endStalePool, longLivedPoolConnectionOptions, poolIdleTimeoutSec } from '@papercusp/db-org';

import { getHarnessAdminUrl } from './embedded-pg-discovery';

type Sql = ReturnType<typeof postgres>;
type PoolExtras = Parameters<typeof postgres>[1];

/** label → { the live pool, the URL it was BUILT with }. The second half is the fix. */
const _pools = new Map<string, { sql: Sql; url: string }>();

/**
 * Get (or lazily build) the long-lived admin pool registered under `label`, rebuilding it
 * if the resolved admin URL has moved since it was built.
 *
 * @param label stable identifier — also the `pcusp:<label>:p<pid>` application_name.
 * @param extra per-site postgres options (`max`, `prepare`, …); spread last, so it wins.
 */
export function getLongLivedAdminPool(label: string, extra?: PoolExtras): Sql {
  const url = getHarnessAdminUrl();
  const cached = _pools.get(label);
  if (cached) {
    // The whole point: compare against what the pool was BUILT with, not what
    // resolution last decided. Returns false (and does nothing) when they agree.
    if (!endStalePool(cached.sql, cached.url, url, label)) return cached.sql;
    _pools.delete(label);
  }
  const sql = postgres(url, {
    ...longLivedPoolConnectionOptions(label),
    idle_timeout: poolIdleTimeoutSec(),
    ...extra,
  });
  _pools.set(label, { sql, url });
  return sql;
}

/** The URL a label's pool is currently bound to (diagnostics/tests); null if unbuilt. */
export function boundAdminPoolUrl(label: string): string | null {
  return _pools.get(label)?.url ?? null;
}

/** Test-only — drops the registry so a test can observe a rebuild across URL changes. */
export function _resetLongLivedAdminPoolsForTests(): void {
  _pools.clear();
}
