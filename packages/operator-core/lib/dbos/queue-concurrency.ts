/**
 * queue-concurrency.ts — hardware-adaptive DBOS WorkflowQueue concurrency
 * (app-wide-load-traps-2026-06-16 § E, F-E3).
 *
 * The six DBOS WorkflowQueue concurrency literals (4–8) are fixed values "tuned
 * for a big box". On a SMALL host (e.g. a 2-core laptop with an embedded
 * Postgres sharing the cores) they COMPOUND to ~28 concurrent durable workflows
 * that oversubscribe the box and starve the request loop. Cap each literal by the
 * host's derived `dbosQueueConcurrency` (= clamp(round(cores × (embeddedPg?0.5:1)),
 * 1, 32) — see @papercusp/resource-profile): a laptop drops every queue toward 1,
 * while a server keeps its big-box literal unchanged (the derived value is ≥ the
 * literal there).
 *
 * Deliberately a one-directional cap — it only ever scales DOWN on small hosts and
 * NEVER raises a server's queue concurrency, so it adds no new PG-connection
 * pressure (cf the pg-connection-exhaustion-too-many-clients insight: adaptive
 * sizing that scaled UP without raising the DB ceiling caused exhaustion). Raising
 * server-side durable concurrency is a separate, measured policy decision.
 */
import { getResourceProfile } from '../resource-profile';

/**
 * Pure clamp: a queue's host concurrency = its big-box `serverCeiling` scaled down
 * to `hostConcurrency`, floored at 1 (a queue must always drain). Pure + injectable
 * so it is testable without the memoized resource-profile singleton.
 */
export function clampQueueConcurrency(serverCeiling: number, hostConcurrency: number): number {
  return Math.max(1, Math.min(serverCeiling, hostConcurrency));
}

/**
 * A DBOS WorkflowQueue's concurrency for THIS host: its big-box `serverCeiling`
 * (the value tuned for a server), scaled down to the host's derived
 * `dbosQueueConcurrency`. Call at queue construction.
 */
export function queueConcurrency(serverCeiling: number): number {
  return clampQueueConcurrency(serverCeiling, getResourceProfile().dbosQueueConcurrency);
}
