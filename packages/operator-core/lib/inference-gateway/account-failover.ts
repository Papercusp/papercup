/**
 * Account failover pool for the inference gateway (EI-535).
 *
 * The gateway egresses the whole fleet through ONE active account. A Max subscription has a 5h
 * unified budget; when it's exhausted the gateway would otherwise pause ALL egress until the 5h
 * reset — even while another registered account still has budget (the firefight on 2026-06-14:
 * `definitelyahuman` 100%-exhausted while `aviynw10` sat idle with budget). This pool makes the
 * gateway FAIL OVER: on a 5h exhaustion (`onExhausted`, fired from an upstream 429 with the unified
 * window rejected) it rotates to the next account that isn't itself exhausted; an exhausted account
 * rejoins the rotation once its reset time passes. With N accounts the fleet's effective budget is
 * ~N×; only when ALL are exhausted does egress pause (degrading to the pre-failover behavior).
 *
 * Pure + synchronous (a small Map + an index); the credential refresh + token getters live in the
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
  /** accountId → epoch ms its 5h budget resets; an entry with a still-future value is skipped. */
  const exhaustedUntil = new Map<string, number>();
  let activeIdx = 0;

  const available = (e: ActiveAccount): boolean => {
    const until = exhaustedUntil.get(e.accountId);
    return until === undefined || until <= now();
  };

  function active(): ActiveAccount {
    return entries[activeIdx];
  }

  function onExhausted(exhaustedId: string, resetAt: number): ActiveAccount | null {
    // Idempotent under concurrent 429s: only the request whose account is still active rotates;
    // a straggler 429 for an already-rotated-away account is a no-op.
    if (entries[activeIdx].accountId !== exhaustedId) return entries[activeIdx];
    exhaustedUntil.set(exhaustedId, resetAt > now() ? resetAt : now() + FIVE_HOURS_MS);
    // Round-robin from the next index to the first account that still has budget.
    for (let step = 1; step <= entries.length; step++) {
      const idx = (activeIdx + step) % entries.length;
      if (available(entries[idx])) {
        activeIdx = idx;
        log('warn', `inference-gateway: '${exhaustedId}' 5h-exhausted → failover to '${entries[idx].accountId}'`);
        return entries[idx];
      }
    }
    log('error', `inference-gateway: '${exhaustedId}' exhausted and no failover account has budget — egress pauses until reset`);
    return null;
  }

  /** Per-request cache-affinity routing (inference-gateway-multi-credential-routing P-002):
   *  the pool entry named by the `x-papercusp-account` header, or null when unknown (the gateway
   *  falls back to active()). Pins a bee to its account regardless of which one is `active` — a
   *  failover moves `active`, but a header-pinned request stays on its own credential's cache. */
  function select(accountId: string): ActiveAccount | null {
    return entries.find((e) => e.accountId === accountId) ?? null;
  }

  return { active, onExhausted, select };
}
