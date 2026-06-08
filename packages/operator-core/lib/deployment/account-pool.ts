/**
 * Account pool — the Queen's model of the N Claude accounts it can draw from, with
 * a per-account rate-limit projection (`cloud-deployment-layer-2026-06-06` Phase 7).
 *
 * An **account** = one Claude subscription credential, with its OWN rate limits
 * (the P-011 "one Claude sub per frame, separated rate limits" unit). The Queen:
 *   - **P-019** registers N of them (id + credentialRef) and tracks each account's
 *     rate-limit state, reusing the existing rate governor's pause signals.
 *   - **P-020** binds one account per Swarm at deploy time, choosing by rate-limit
 *     headroom (the most-available account).
 *   - **P-021** when an account is *sustainedly* limited, scales out onto a fresh
 *     account (a new cloud Swarm) instead of only pausing.
 *
 * This file is PURE — types + decisions over a plain `AccountPool` value, no PG /
 * governor / deploy IO. The IO wiring (persistence, the governor-pause bridge, the
 * scale-out reaction) lives in `account-pool-store.ts`, so this core stays
 * exhaustively unit-testable with no fixtures.
 */

/** One Claude subscription the Queen can draw from. */
export interface ClaudeAccount {
  /**
   * Stable id within the pool. Validated to `[A-Za-z0-9._-]+` — it becomes part of
   * the governor bucket key (`<provider>:<modelClass>@<id>`), so it must not contain
   * the `:` / `@` delimiters. This is the credential's logical identity.
   */
  id: string;
  /**
   * Opaque reference to the credential bundle mounted on a frame
   * (`DeploymentConfig.credentialRef`): `token:<path>` (a `claude setup-token` OAuth
   * token) | `file:<path>` / absolute / `~` (a `.credentials.json` bundle). A
   * REFERENCE the host resolves, never the secret — safe to persist/federate.
   */
  credentialRef: string;
  /** Optional human label. */
  label?: string;
  /** When added (epoch ms). */
  addedAt: number;
  /** Swarm member harness slugs currently bound to this account (P-020). */
  boundTo: string[];
  /**
   * Per-account rate-limit projection the Queen tracks (P-019). Updated from the
   * account's governor pause signals (local process) + federated frame signals.
   */
  rate: AccountRateState;
}

/** The rolled-up rate-limit state for one account (the Queen's projection). */
export interface AccountRateState {
  /** Epoch ms the account is paused until; `0` = not paused. Mirrors the governor pause. */
  pausedUntil: number;
  /** Epoch ms of the most recent 429 / usage-limit penalty observed. `0` = none. */
  lastPenaltyAt: number;
  /** Penalties counted in the current rolling window — the sustained-limit signal. */
  penaltyCount: number;
  /** Epoch ms the current penalty window started. `0` = no window open. */
  windowStartedAt: number;
}

export interface AccountPool {
  accounts: ClaudeAccount[];
}

/** The policy knobs that turn raw penalties into a "sustainedly limited" verdict. */
export interface ScalePolicy {
  /** Penalties within this window (ms) accumulate toward the sustained threshold. */
  windowMs: number;
  /** ≥ this many penalties within the window ⇒ the account is sustainedly limited. */
  sustainedPenaltyThreshold: number;
  /**
   * OR a single pause reaching at least this far ahead (ms) ⇒ sustainedly limited.
   * A usage-cap reset hours out means "park and scale", not "sit and wait".
   */
  longPauseMs: number;
}

export const DEFAULT_SCALE_POLICY: ScalePolicy = {
  windowMs: 15 * 60_000, // 15 min
  sustainedPenaltyThreshold: 3, // 3 × 429 in 15 min = this account can't keep up
  longPauseMs: 30 * 60_000, // a ≥30-min pause (a usage cap) ⇒ exhausted, scale out
};

export class AccountPoolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AccountPoolError';
  }
}

const ID_RE = /^[A-Za-z0-9._-]+$/;

export function emptyPool(): AccountPool {
  return { accounts: [] };
}

function freshRate(): AccountRateState {
  return { pausedUntil: 0, lastPenaltyAt: 0, penaltyCount: 0, windowStartedAt: 0 };
}

export function getAccount(pool: AccountPool, id: string): ClaudeAccount | undefined {
  return pool.accounts.find((a) => a.id === id);
}

/** Find the account a given credentialRef belongs to (reverse lookup). */
export function accountByCredentialRef(pool: AccountPool, credentialRef: string): ClaudeAccount | undefined {
  return pool.accounts.find((a) => a.credentialRef === credentialRef);
}

/**
 * Register (or idempotently update) an account. A new id is appended fresh; an
 * existing id has its `credentialRef`/`label` updated in place (rate + bindings
 * preserved). Pure — returns a new pool.
 */
export function registerAccount(
  pool: AccountPool,
  input: { id: string; credentialRef: string; label?: string },
  now: number,
): AccountPool {
  const id = input.id.trim();
  if (!ID_RE.test(id)) {
    throw new AccountPoolError(`invalid account id '${input.id}' — allowed: A-Za-z0-9 . _ - (no ':' or '@')`);
  }
  const credentialRef = input.credentialRef.trim();
  if (!credentialRef) throw new AccountPoolError('credentialRef is required');

  if (getAccount(pool, id)) {
    return {
      accounts: pool.accounts.map((a) =>
        a.id === id ? { ...a, credentialRef, label: input.label ?? a.label } : a,
      ),
    };
  }
  const account: ClaudeAccount = {
    id,
    credentialRef,
    label: input.label,
    addedAt: now,
    boundTo: [],
    rate: freshRate(),
  };
  return { accounts: [...pool.accounts, account] };
}

/** Remove an account from the pool. Pure. */
export function removeAccount(pool: AccountPool, id: string): AccountPool {
  return { accounts: pool.accounts.filter((a) => a.id !== id) };
}

/** Bind a member harness slug to an account (idempotent). Pure. */
export function bindAccount(pool: AccountPool, id: string, slug: string): AccountPool {
  return {
    accounts: pool.accounts.map((a) =>
      a.id === id ? { ...a, boundTo: a.boundTo.includes(slug) ? a.boundTo : [...a.boundTo, slug] } : a,
    ),
  };
}

/** Remove a slug from whatever account currently holds it (a slug binds ≤1 account). Pure. */
export function unbindAccount(pool: AccountPool, slug: string): AccountPool {
  return { accounts: pool.accounts.map((a) => ({ ...a, boundTo: a.boundTo.filter((s) => s !== slug) })) };
}

/**
 * Record a rate-limit penalty against an account (pure). Rolls the penalty window:
 * a penalty outside the current window opens a fresh count of 1; inside it
 * increments. `pausedUntil` advances monotonically — a penalty never shortens an
 * existing pause. A penalty for an unknown id is a no-op.
 */
export function recordAccountPenalty(
  pool: AccountPool,
  id: string,
  now: number,
  opts: { pausedUntil?: number } = {},
  policy: ScalePolicy = DEFAULT_SCALE_POLICY,
): AccountPool {
  return {
    accounts: pool.accounts.map((a) => {
      if (a.id !== id) return a;
      const inWindow = a.rate.windowStartedAt > 0 && now - a.rate.windowStartedAt < policy.windowMs;
      const rate: AccountRateState = {
        pausedUntil: Math.max(a.rate.pausedUntil, opts.pausedUntil ?? 0),
        lastPenaltyAt: now,
        penaltyCount: inWindow ? a.rate.penaltyCount + 1 : 1,
        windowStartedAt: inWindow ? a.rate.windowStartedAt : now,
      };
      return { ...a, rate };
    }),
  };
}

/** Clear an account's pause + penalty window (e.g. on a confirmed reset). Pure. */
export function recordAccountReset(pool: AccountPool, id: string): AccountPool {
  return {
    accounts: pool.accounts.map((a) => (a.id === id ? { ...a, rate: freshRate() } : a)),
  };
}

/** Is the account usable right now (not currently paused)? */
export function isAvailable(account: ClaudeAccount, now: number): boolean {
  return account.rate.pausedUntil <= now;
}

/**
 * Is the account *sustainedly* rate-limited — the P-021 scale-out trigger? True when
 * either a single pause reaches `longPauseMs` ahead (a usage cap), or the account
 * accrued `sustainedPenaltyThreshold` penalties inside the current window.
 */
export function isSustainedlyLimited(
  account: ClaudeAccount,
  now: number,
  policy: ScalePolicy = DEFAULT_SCALE_POLICY,
): boolean {
  const r = account.rate;
  if (r.pausedUntil - now >= policy.longPauseMs) return true;
  const inWindow = r.windowStartedAt > 0 && now - r.windowStartedAt < policy.windowMs;
  return inWindow && r.penaltyCount >= policy.sustainedPenaltyThreshold;
}

export interface SelectOpts {
  /** Exclude these ids (e.g. the exhausted account we're scaling away from). */
  exclude?: string[];
  /** Only consider accounts available right now (not paused). Default true. */
  availableOnly?: boolean;
  /** Prefer accounts with no bindings yet (spread Swarms across distinct accounts). */
  preferUnbound?: boolean;
}

/**
 * Choose the account with the most rate-limit headroom (P-020), deterministically.
 * Ranking (ascending = better): when `preferUnbound`, unbound accounts first; then
 * fewest bindings (spread load); then least-recently penalized (a clean account
 * beats a recently-limited one); then oldest-added; then id (stable tie-break).
 * Returns undefined when nothing qualifies.
 */
export function selectAccountByHeadroom(pool: AccountPool, now: number, opts: SelectOpts = {}): ClaudeAccount | undefined {
  const { exclude = [], availableOnly = true, preferUnbound = false } = opts;
  let candidates = pool.accounts.filter((a) => !exclude.includes(a.id));
  if (availableOnly) candidates = candidates.filter((a) => isAvailable(a, now));
  if (candidates.length === 0) return undefined;

  const rank = (a: ClaudeAccount): number[] => [
    preferUnbound ? (a.boundTo.length === 0 ? 0 : 1) : 0,
    a.boundTo.length,
    a.rate.lastPenaltyAt, // 0 (never penalized) sorts first
    a.addedAt,
  ];
  return [...candidates].sort((x, y) => {
    const rx = rank(x);
    const ry = rank(y);
    for (let i = 0; i < rx.length; i++) if (rx[i] !== ry[i]) return rx[i] - ry[i];
    return x.id < y.id ? -1 : x.id > y.id ? 1 : 0;
  })[0];
}

export type ScaleOutDecision =
  | { provision: true; account: ClaudeAccount }
  | { provision: false; reason: 'no-fresh-account' | 'not-sustained' };

/**
 * Decide whether to scale out off an exhausted account (P-021): when the account is
 * sustainedly limited (gate optional via `requireSustained`) AND a fresh available
 * account exists, return it to provision a new Swarm onto; otherwise don't (the
 * caller falls back to the existing pause). Pure.
 */
export function decideScaleOut(
  pool: AccountPool,
  exhaustedId: string,
  now: number,
  opts: { policy?: ScalePolicy; requireSustained?: boolean } = {},
): ScaleOutDecision {
  const policy = opts.policy ?? DEFAULT_SCALE_POLICY;
  const requireSustained = opts.requireSustained ?? true;
  const exhausted = getAccount(pool, exhaustedId);
  if (requireSustained && exhausted && !isSustainedlyLimited(exhausted, now, policy)) {
    return { provision: false, reason: 'not-sustained' };
  }
  const fresh = selectAccountByHeadroom(pool, now, {
    exclude: [exhaustedId],
    availableOnly: true,
    preferUnbound: true,
  });
  if (!fresh) return { provision: false, reason: 'no-fresh-account' };
  return { provision: true, account: fresh };
}
