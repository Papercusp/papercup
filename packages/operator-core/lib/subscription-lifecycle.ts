/**
 * Subscription lifecycle (shared-reference-system-2026-11-13 P-002, closes
 * EI-28704054499880447).
 *
 * One home for the two rules every automatic subscription follows:
 *
 *  1. WHO may hold one. `isMachineIdentity` is the recipient predicate (the R-7
 *     predicate that R-11 reuses): a machine identity (a system principal such
 *     as `system:operator/s-…`, a routine, a durable spawn, a transport-only
 *     MCP caller, an unresolved alias) is never given an automatic `context` or
 *     `held_item` subscription. The skip is returned, never silent. An explicit
 *     follow is not automatic and is not affected.
 *
 *  2. WHEN a contextual one ends. `endSubscriberContexts` cancels the `context`
 *     reason when the subscriber's context ends: a clean session end, a session
 *     the liveness oracle reports ended (`sweepEndedSubscriberContexts`, run by
 *     the idle-session reaper), or context replacement (`bumpSessionEpoch` ends
 *     every contextual subscription from an earlier epoch). Explicit, held-item
 *     and blocker reasons are untouched (R-39); a row keeps living while any
 *     reason remains.
 *
 * Reused, not forked: the store methods live on PgEntitySubscriptionStore
 * (packages/coordination), the epoch on memory_session_epochs, liveness on the
 * one liveness oracle, and the agent-session registry is adv_sessions.
 */
import { getOrgPg } from '@papercusp/db-org';
import type { SubscriptionEndCause } from '@papercusp/coordination/capabilities';
import { isTransportOnlyIdentity } from './agent-tools/coordination/identity';
import { getCoordSubscriptionStore } from './agent-tools/coordination/subscription-store';
import { coordScopeWorkspace } from './agent-tools/coordination/log';
import { currentSessionEpoch } from './memory/session-epoch-ledger';

/** Identity families that are machines by construction, measured in
 *  coord_entity_subscriptions on 2026-11-15 and in EI-28704054499880447 (where
 *  `system:operator/s-…` principals received 99% of notify rows): system
 *  principals and senders, routines, durable spawns, admission rules, MCP
 *  callers. */
export const MACHINE_ID_PREFIXES = ['system:', 'system-', 'routine:', 'durable-spawn:', 'admission-rule:', 'mcp-call-'] as const;
/** Literal machine ids and unresolved aliases (no agent is ever named these). */
export const MACHINE_ID_LITERALS: ReadonlySet<string> = new Set(['system', 'human', 'self', 'loopback', 'substrate', 'unassigned']);

/** THE recipient predicate (R-7; reused by R-11's injection ports). Pure and
 *  deterministic, so every caller classifies an id the same way: a machine is
 *  an empty id, a machine literal or alias, a transport-only identity, or an id
 *  in a machine family. Any other id is an agent recipient. */
export function isMachineIdentity(id: string | null | undefined): boolean {
  const v = (id ?? '').trim();
  if (!v || MACHINE_ID_LITERALS.has(v.toLowerCase()) || isTransportOnlyIdentity(v)) return true;
  return MACHINE_ID_PREFIXES.some((p) => v.startsWith(p));
}

export type AutomaticReason = 'context' | 'held_item';

export type AutomaticSubscriptionFields =
  | { subscribe: true; reason: AutomaticReason; context_epoch?: number | null }
  | { subscribe: false; skipped: 'machine-identity' };

export interface AutomaticSubscriptionDeps {
  currentEpoch?: (subscriberId: string) => Promise<number>;
}

async function readCurrentEpoch(subscriberId: string): Promise<number | null> {
  try {
    return await currentSessionEpoch(getOrgPg().sql, subscriberId);
  } catch {
    return null;
  }
}

/** The fields an automatic subscribe stamps — or the explicit machine-identity
 *  skip. `context` carries the subscriber's current context epoch so a later
 *  context replacement can end it (a null epoch ends at the next replacement). */
export async function automaticSubscriptionFields(
  subscriberId: string,
  reason: AutomaticReason,
  deps: AutomaticSubscriptionDeps = {},
): Promise<AutomaticSubscriptionFields> {
  if (isMachineIdentity(subscriberId)) return { subscribe: false, skipped: 'machine-identity' };
  if (reason === 'held_item') return { subscribe: true, reason };
  const epoch = deps.currentEpoch ? await deps.currentEpoch(subscriberId) : await readCurrentEpoch(subscriberId);
  return { subscribe: true, reason, context_epoch: epoch };
}

export interface ContextEndResult {
  released: number;
  cancelled: number;
}

/** Store seam: the two PgEntitySubscriptionStore methods the lifecycle uses. */
export interface ContextEndStore {
  endContexts(input: { subscriberId: string; beforeEpoch?: number; cause: SubscriptionEndCause }): Promise<ContextEndResult>;
  listContextSubscribers(input: { after?: string; limit: number }): Promise<string[]>;
}

/** End the `context` reason of `subscriberId`'s subscriptions — all of them
 *  (session end), or with `beforeEpoch` only those added before that epoch
 *  (context replacement). Fail-soft: returns null and logs on error, because
 *  every caller is a lifecycle hook that must not fail its own work. */
export async function endSubscriberContexts(
  subscriberId: string,
  cause: SubscriptionEndCause,
  opts: { beforeEpoch?: number; store?: ContextEndStore } = {},
): Promise<ContextEndResult | null> {
  if (!subscriberId?.trim()) return null;
  try {
    const store = opts.store ?? getCoordSubscriptionStore();
    const r = await store.endContexts({ subscriberId, beforeEpoch: opts.beforeEpoch, cause });
    if (r.released > 0) {
      console.log(
        `[subscription-lifecycle] ${cause} for ${subscriberId}${opts.beforeEpoch != null ? ` (before epoch ${opts.beforeEpoch})` : ''}: ` +
          `released the context reason on ${r.released} subscription(s), cancelled ${r.cancelled}`,
      );
    }
    return r;
  } catch (e) {
    console.warn(`[subscription-lifecycle] ${cause} for ${subscriberId} failed: ${e instanceof Error ? e.message : e}`);
    return null;
  }
}

export interface EndedSweepDeps {
  store?: ContextEndStore;
  /** Owner ids among `ids` that the liveness oracle reports `ended`. */
  endedAmong?: (ids: readonly string[]) => Promise<Set<string>>;
  pageSize?: number;
}

export interface EndedSweepResult {
  dryRun: boolean;
  pages: number;
  scanned: number;
  ended: number;
  released: number;
  cancelled: number;
  /** Subscribers whose verdict could not be read this run (retried next run). */
  unjudged: number;
}

async function oracleEndedAmong(ids: readonly string[]): Promise<Set<string>> {
  const { resolveSessionStates } = await import('./agent-tools/coordination/liveness-oracle');
  const verdicts = await resolveSessionStates(ids.map((ownerId) => ({ ownerId })), { hydrateBatch: true });
  const out = new Set<string>();
  for (const [id, v] of verdicts) if (v.sessionState === 'ended') out.add(id);
  return out;
}

/** The reaper backstop for a session that died without a clean SessionEnd:
 *  pages through EVERY subscriber holding an active `context` reason (keyset,
 *  to exhaustion — no subscriber is skipped by a cap) and ends the contexts of
 *  each one the liveness oracle reports `ended`. A page whose verdicts fail is
 *  counted in `unjudged` and the sweep continues with the next page. */
export async function sweepEndedSubscriberContexts(
  opts: { dryRun?: boolean } & EndedSweepDeps = {},
): Promise<EndedSweepResult> {
  const store = opts.store ?? getCoordSubscriptionStore();
  const pageSize = Math.max(1, opts.pageSize ?? 200);
  const endedAmong = opts.endedAmong ?? oracleEndedAmong;
  const res: EndedSweepResult = { dryRun: opts.dryRun === true, pages: 0, scanned: 0, ended: 0, released: 0, cancelled: 0, unjudged: 0 };
  let after = '';
  for (;;) {
    const page = await store.listContextSubscribers({ after, limit: pageSize });
    if (page.length === 0) break;
    res.pages += 1;
    res.scanned += page.length;
    after = page[page.length - 1];
    let ended: Set<string>;
    try {
      ended = await endedAmong(page);
    } catch (e) {
      res.unjudged += page.length;
      console.warn(`[subscription-lifecycle] liveness verdicts for ${page.length} subscriber(s) failed: ${e instanceof Error ? e.message : e}`);
      continue;
    }
    for (const id of page) {
      if (!ended.has(id)) continue;
      res.ended += 1;
      if (res.dryRun) continue;
      const r = await endSubscriberContexts(id, 'session-ended-oracle', { store });
      if (r) {
        res.released += r.released;
        res.cancelled += r.cancelled;
      }
    }
    if (page.length < pageSize) break;
  }
  return res;
}

/** The fixed run key of the D-002 legacy cleanup. The snapshot table's
 *  UNIQUE (cleanup_run, subscription_id) makes every re-run idempotent. */
export const LEGACY_CLEANUP_RUN = 'p002-legacy-dead-subscriptions';

/** Days a session must have been ended before its legacy rows are dead. */
export const LEGACY_CLEANUP_ENDED_DAYS = 7;

export interface LegacyCleanupResult {
  dryRun: boolean;
  batches: number;
  cancelled: number;
  byCause: Record<string, number>;
  /** True when the last batch was full, so rows may remain for the next run. */
  more: boolean;
}

type LegacyCleanupSql = ReturnType<typeof getOrgPg>['sql'];

/** D-002 / EI-28704054499880447: snapshot, then cancel, the legacy subscriptions
 *  (reason not recorded, created before P-002) that are dead. Two cases only:
 *   - `session-ended`: a psu agent session with no presence row and no session
 *     open or ended within LEGACY_CLEANUP_ENDED_DAYS;
 *   - `machine-identity`: an ephemeral `system:operator/s-…` principal with no
 *     presence row (99% of notify rows in the EI's measurement).
 *  Every cancelled row is first copied whole into
 *  coord_entity_subscription_cleanup_snapshots, in the same statement, so it can
 *  be audited and restored. Work is bounded per call (maxBatches × batchSize)
 *  and durable: cancelled rows drop out of the predicate, so the next run
 *  continues where this one stopped and `more` says whether rows may remain. */
export async function cleanupLegacyDeadSubscriptions(opts: {
  dryRun?: boolean;
  batchSize?: number;
  maxBatches?: number;
  sql?: LegacyCleanupSql;
  workspaceId?: string;
} = {}): Promise<LegacyCleanupResult> {
  const sql = opts.sql ?? getOrgPg().sql;
  const ws = opts.workspaceId ?? coordScopeWorkspace();
  const batchSize = Math.max(1, opts.batchSize ?? 2000);
  const maxBatches = Math.max(1, opts.maxBatches ?? 10);
  const res: LegacyCleanupResult = { dryRun: opts.dryRun === true, batches: 0, cancelled: 0, byCause: {}, more: false };
  let after = 0;
  for (let i = 0; i < maxBatches; i++) {
    const candidates = sql`
      SELECT s.id,
             CASE WHEN s.subscriber_id LIKE 'system:operator/s-%' THEN 'machine-identity' ELSE 'session-ended' END AS cause
        FROM harness_shared.coord_entity_subscriptions AS s
       WHERE s.workspace_id = ${ws} AND s.cancelled_at IS NULL AND s.reasons IS NULL AND s.id > ${after}
         AND (s.subscriber_id LIKE 'system:operator/s-%'
              OR (s.subscriber_id ~ '^su-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                  AND NOT EXISTS (
                    SELECT 1 FROM harness_shared.adv_sessions AS a
                     WHERE a.coord_owner_id = s.subscriber_id
                       AND (a.ended_at IS NULL OR a.ended_at > now() - make_interval(days => ${LEGACY_CLEANUP_ENDED_DAYS})))))
         AND NOT EXISTS (
           SELECT 1 FROM harness_shared.coord_presence AS p
            WHERE p.workspace_id = s.workspace_id AND p.owner_id = s.subscriber_id)
       ORDER BY s.id
       LIMIT ${batchSize}`;
    const rows = res.dryRun
      ? await sql<{ id: string; cause: string }[]>`${candidates}`
      : await sql<{ id: string; cause: string }[]>`
          WITH cand AS (${candidates} FOR UPDATE OF s SKIP LOCKED),
          snap AS (
            INSERT INTO harness_shared.coord_entity_subscription_cleanup_snapshots
              (cleanup_run, subscription_id, workspace_id, subscriber_id, cause, row_data)
            SELECT ${LEGACY_CLEANUP_RUN}, s.id, s.workspace_id, s.subscriber_id, cand.cause, to_jsonb(s)
              FROM harness_shared.coord_entity_subscriptions AS s JOIN cand ON cand.id = s.id
            ON CONFLICT (cleanup_run, subscription_id) DO NOTHING
            RETURNING subscription_id, cause)
          UPDATE harness_shared.coord_entity_subscriptions AS s
             SET cancelled_at = now(), cancel_reason = 'cleanup:' || snap.cause
            FROM snap
           WHERE s.id = snap.subscription_id
          RETURNING s.id, snap.cause`;
    res.batches += 1;
    for (const r of rows) {
      res.cancelled += 1;
      res.byCause[r.cause] = (res.byCause[r.cause] ?? 0) + 1;
      const id = Number(r.id);
      if (id > after) after = id;
    }
    res.more = rows.length >= batchSize;
    if (!res.more) break;
  }
  return res;
}
