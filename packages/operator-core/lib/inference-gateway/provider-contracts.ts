import type { AccountEgress } from '../deployment/account-pool';

/**
 * Provider-neutral account selected for one upstream attempt.
 *
 * This contract deliberately lives outside gateway.ts: pools, lane descriptors, and
 * failover policy must not depend on the request-handler monolith merely to name an
 * account. Credential/egress behavior remains explicit instead of being hidden behind
 * a provider-shaped `any` bag.
 */
export interface ActiveAccount {
  accountId: string;
  token(): Promise<string>;
  invalidateToken?(): void;
  /** Per-account upstream egress. Singular/legacy; superseded by a non-empty `egressPool`. */
  egress?: AccountEgress;
  /** Rotating egress bindings for one account; callers skip entries on per-IP cooldown. */
  egressPool?: AccountEgress[];
}

/**
 * Shared account-selection/failover contract used by every cloud gateway lane.
 * `active()` may advance a pool cursor; read-only callers use `peek()` or `entries()`.
 */
export interface AccountPool {
  /** Pick the next unpinned account. A caller may supply the shared health key (lower is better);
   *  omitting it preserves the pool's round-robin behavior exactly. */
  active(keyOf?: (account: ActiveAccount) => number): ActiveAccount;
  /** Mark one account exhausted and choose a replacement, optionally through the same health key. */
  onExhausted(
    exhaustedId: string,
    resetAt: number,
    keyOf?: (account: ActiveAccount) => number,
  ): ActiveAccount | null;
  /** Resolve an account-affinity pin without silently substituting another account. */
  select?(accountId: string): ActiveAccount | null;
  /** Clear a transport/rate pause when a health probe proves the account usable again. */
  readmit?(accountId: string): void;
  /** Atomically replace live entries without changing the pool object held by the gateway. */
  reload?(next: readonly ActiveAccount[]): void;
  /** Accounts currently in rotation, optionally filtered by an additional health predicate. */
  healthyCount?(extra?: (accountId: string) => boolean): number;
  /** Total entries, including temporarily exhausted or paused accounts. */
  size?(): number;
  /** Non-advancing current-best account for read-only callers. */
  peek?(): ActiveAccount;
  /** Non-advancing snapshot used by health probes and registry diagnostics. */
  entries?(): readonly ActiveAccount[];
  /** Milliseconds since an account last rejoined rotation, when known. */
  msSinceReadmit?(accountId: string, nowMs?: number): number | undefined;
}
