/**
 * Account failover + load-distribution pool for the inference gateway (EI-535).
 *
 * Two jobs:
 *   1. DISTRIBUTE the fleet's UNPINNED egress ACROSS the whole pool. `active()` round-robins over
 *      the accounts that still have budget, so concurrent load spreads evenly instead of piling onto
 *      one account. (Before 2026-06-18 the pool egressed the whole fleet through ONE fixed `active`
 *      account; under the fleet's concurrent opus load that single account short-term-429'd
 *      continuously while the other 6 accounts sat IDLE — the owner-reported "accounts unused / it's
 *      not a real rate limit, the router is broken" bug. The 5h-exhaustion failover below never fired
 *      for short-term/per-minute throttles, so nothing ever spread the load.)
 *   2. FAIL OVER off an account that's out of budget. `onExhausted` marks an account out of rotation
 *      until its reset (a 5h unified-budget exhaustion, a hard usage cap, or a short bare-429 pace),
 *      and hands the retry loop the next account that still has budget. An exhausted account rejoins
 *      the rotation once its reset passes. Only when ALL accounts are exhausted does egress pause.
 *
 * Header-pinned requests (`select`, x-papercusp-account) bypass round-robin and stay on their own
 * credential for cache-affinity — a bee keeps its warm per-credential cache regardless of rotation.
 *
 * Pure + synchronous (a small Map + a cursor); the credential refresh + token getters live in the
 * resolvers the entries wrap (launch.ts). `now()` is injectable for tests.
 */
import type { ActiveAccount, AccountPool } from './gateway';

export interface FailoverPoolOptions {
  now?: () => number;
  log?: (level: 'info' | 'warn' | 'error', msg: string) => void;
}

const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;

export function createFailoverPool(entries: readonly ActiveAccount[], opts: FailoverPoolOptions = {}): AccountPool {
  if (entries.length === 0) throw new Error('createFailoverPool: at least one account is required');
  const now = opts.now ?? (() => Date.now());
  const log = opts.log ?? (() => {});
  /** accountId → epoch ms its budget resets; an entry with a still-future value is skipped. */
  const exhaustedUntil = new Map<string, number>();
  /** Round-robin cursor — the NEXT index to consider, advanced on every `active()` so unpinned
   *  egress spreads across the whole pool instead of concentrating on one account. */
  let rrIdx = 0;
  /** The LIVE pool entries. Mutable so the gateway can HOT-RELOAD the account pool (B-HOT-1): an atomic
   *  swap via `reload()` re-points active()/onExhausted()/select() at the new set WITHOUT a gateway
   *  restart and WITHOUT changing this pool object's identity (the gateway holds this object for its
   *  whole lifetime). Initialised from the constructor `entries`. */
  let live: readonly ActiveAccount[] = entries.slice();

  const available = (e: ActiveAccount): boolean => {
    const until = exhaustedUntil.get(e.accountId);
    return until === undefined || until <= now();
  };

  /** The account to egress the next UNPINNED request through — round-robin across the accounts that
   *  still have budget, so the fleet's load distributes evenly. Falls back to plain round-robin
   *  (including paused accounts) only when EVERY account is currently exhausted, so the gateway still
   *  picks SOMETHING (the retry loop / governor then paces it) rather than starving. */
  function active(): ActiveAccount {
    for (let step = 0; step < live.length; step++) {
      const idx = (rrIdx + step) % live.length;
      if (available(live[idx])) {
        rrIdx = (idx + 1) % live.length;
        return live[idx];
      }
    }
    const idx = rrIdx % live.length;
    rrIdx = (idx + 1) % live.length;
    return live[idx];
  }

  /** Mark `exhaustedId` out of rotation until `resetAt`, and return the next DIFFERENT account that
   *  still has budget for the retry loop to rotate onto (null when none remain → egress pauses until
   *  a reset). Idempotent: re-exhausting an already-paused account just refreshes its reset. */
  function onExhausted(exhaustedId: string, resetAt: number): ActiveAccount | null {
    exhaustedUntil.set(exhaustedId, resetAt > now() ? resetAt : now() + FIVE_HOURS_MS);
    for (let step = 0; step < live.length; step++) {
      const idx = (rrIdx + step) % live.length;
      if (live[idx].accountId !== exhaustedId && available(live[idx])) {
        rrIdx = (idx + 1) % live.length;
        log('warn', `inference-gateway: '${exhaustedId}' out of rotation → '${live[idx].accountId}'`);
        return live[idx];
      }
    }
    log('error', `inference-gateway: '${exhaustedId}' exhausted and no other account has budget — egress pauses until reset`);
    return null;
  }

  /** Clear an account's out-of-rotation pause AHEAD of its reset — the dual of onExhausted. Called when a
   *  half-open egress probe confirms the proxy RECOVERED, so a token-healthy account rejoins rotation the
   *  instant its transport is healthy again, instead of sitting out the full circuit window (owner-reported
   *  2026-06-21: flaky proxies kept healthy accounts out 60s → empty-pool "all throttled" sheds). No-op if
   *  the account wasn't paused. */
  function readmit(accountId: string): void {
    if (exhaustedUntil.delete(accountId)) {
      log('warn', `inference-gateway: '${accountId}' readmitted to rotation (egress proxy recovered)`);
    }
  }

  /** Per-request cache-affinity routing (inference-gateway-multi-credential-routing P-002):
   *  the pool entry named by the `x-papercusp-account` header, or null when unknown (the gateway
   *  falls back to active()). Pins a bee to its account regardless of which one is `active` — a
   *  failover moves `active`, but a header-pinned request stays on its own credential's cache. */
  function select(accountId: string): ActiveAccount | null {
    return live.find((e) => e.accountId === accountId) ?? null;
  }

  /** HOT-RELOAD the pool (B-HOT-1): atomically swap the live entries to `next` WITHOUT a gateway
   *  restart. The pool object identity is preserved (the gateway's captured `pool` reference keeps
   *  working), the round-robin cursor is clamped to the new length, and the exhausted-state map is
   *  pruned of accounts that LEFT the pool — a still-present paused account KEEPS its pause across the
   *  swap. Throws on an empty set: the gateway must always have at least one egress account. */
  function reload(next: readonly ActiveAccount[]): void {
    if (next.length === 0) throw new Error('createFailoverPool.reload: at least one account is required');
    live = next.slice();
    const presentIds = new Set(live.map((e) => e.accountId));
    for (const id of [...exhaustedUntil.keys()]) if (!presentIds.has(id)) exhaustedUntil.delete(id);
    rrIdx = rrIdx % live.length;
    log('info', `inference-gateway: account pool hot-reloaded → [${live.map((e) => e.accountId).join(', ')}]`);
  }

  /** Accounts currently IN rotation (budget available, not paused) — the live capacity denominator the
   *  priority-tier `/stats` reports. Counts the same `available()` predicate `active()` round-robins over. */
  function healthyCount(): number {
    return live.reduce((n, e) => n + (available(e) ? 1 : 0), 0);
  }

  return { active, onExhausted, select, reload, readmit, healthyCount };
}
