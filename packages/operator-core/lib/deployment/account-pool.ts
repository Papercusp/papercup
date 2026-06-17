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

/**
 * Per-account upstream egress binding — per-account IP routing (D-003). Each registered Claude Max
 * subscription can be pinned to its own outbound IP so N consumer subscriptions don't all egress from
 * one shared address (consumer plans can correlate/flag a shared origin). Either an HTTP/SOCKS proxy
 * URL the gateway routes this account's upstream traffic through, or a local source IP to bind. A
 * REFERENCE/config, never a secret — safe to persist/federate. Absent ⇒ default (shared) egress; the
 * owner provisions the actual proxies (owner-gated infra, like the credentials themselves).
 */
export interface AccountEgress {
  /** `http(s)://` or `socks(5)://` proxy URL for this account's upstream requests. */
  proxyUrl?: string;
  /** Local source IP to bind the upstream socket to (when the host has multiple egress IPs). */
  localAddress?: string;
}

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
  /** Per-account upstream egress (per-account IP routing). Absent ⇒ default shared egress. */
  egress?: AccountEgress;
  /** When added (epoch ms). */
  addedAt: number;
  /** Swarm member harness slugs currently bound to this account (P-020). A MANUAL / deploy-time
   *  bind (owner intent) — never auto-cleared by the soft-pin lazy-repin (D-001). */
  boundTo: string[];
  /**
   * SOFT cache-affinity auto-pins (account-cache-affinity-auto-pin-2026-06-16): harness slugs the
   * SPAWN selector auto-pinned to this credential so a harness's consecutive bees co-locate on one
   * account and reuse its per-credential prompt-cache prefix. Distinct from `boundTo` (a manual
   * owner/deploy bind): a soft pin is system-set and LAZILY re-pinned — cleared the moment this
   * account fills (`drainUtil ≥ DRAIN_FULL_UTIL`) or goes unavailable, so the next spawn re-drains
   * to a fresh account and re-pins there (D-002). NEVER overwrites a manual `boundTo` bind (D-001).
   * Absent/empty ⇒ no auto-pin (today's behavior). Pure projection — the impure caller persists it.
   */
  softPin?: string[];
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
  /**
   * Unified-5h rolling utilization (a fraction: 1.0 = 100%, >1 = over budget), fed from the gateway
   * response headers — the only process that sees them — so the cross-process drain selector can
   * route by REAL remaining budget. The aggregate 5h budget across subscriptions is the capacity
   * lever for Claude Max (D-003). `undefined` until first observed.
   */
  utilization?: number;
  /** Epoch ms the unified-5h window resets (`anthropic-ratelimit-unified-5h-reset`). `undefined` until observed. */
  windowResetAt?: number;
  /** Epoch ms `utilization`/`windowResetAt` were last observed — lets the selector ignore stale budget. */
  utilizationAt?: number;
  /**
   * Unified-7d (weekly) rolling utilization (a fraction; 1.0 = 100%) from
   * `anthropic-ratelimit-unified-7d-utilization` — the LONGER Claude Max limit alongside the 5h.
   * A read-only surface signal for the Accounts tab (accounts-pool-tab P-006); NOT a routing input
   * (the 5h window remains the drain selector's signal). `undefined` until observed.
   */
  utilization7d?: number;
  /** Epoch ms the unified-7d window resets (`anthropic-ratelimit-unified-7d-reset`). `undefined` until observed. */
  windowResetAt7d?: number;
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
}

export const DEFAULT_SCALE_POLICY: ScalePolicy = {
  windowMs: 15 * 60_000, // 15 min
  sustainedPenaltyThreshold: 3, // 3 × 429 in 15 min = this account genuinely can't keep up
};

/**
 * Utilization at/above which an account's unified-5h window is genuinely exhausted (1.0 = 100%).
 * This is the SELF-HEALING exhaustion signal (D-003 false-exhaustion fix): a rolling-utilization
 * window decays continuously, so reading the freshest observed utilization (not a stale far-future
 * pause) means an account stops reading "exhausted" the moment its window recovers below the cap.
 */
export const EXHAUSTED_UTIL = 1.0;

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
  input: { id: string; credentialRef: string; label?: string; egress?: AccountEgress },
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
        a.id === id ? { ...a, credentialRef, label: input.label ?? a.label, egress: input.egress ?? a.egress } : a,
      ),
    };
  }
  const account: ClaudeAccount = {
    id,
    credentialRef,
    label: input.label,
    egress: input.egress,
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

/** The account a harness is MANUALLY bound to (`boundTo`), if any — the owner/deploy intent the
 *  soft auto-pin must never overwrite (D-001). Pure. */
export function manuallyBoundAccount(pool: AccountPool, slug: string): ClaudeAccount | undefined {
  return pool.accounts.find((a) => a.boundTo.includes(slug));
}

/** The account a harness is SOFT-pinned to (`softPin`), if any (cache-affinity auto-pin). Pure. */
export function softPinnedAccount(pool: AccountPool, slug: string): ClaudeAccount | undefined {
  return pool.accounts.find((a) => a.softPin?.includes(slug));
}

/**
 * Soft-pin a harness to one account (cache-affinity auto-pin): set the pin on `id`, removing any
 * prior soft pin for `slug` on a DIFFERENT account (a slug soft-pins ≤1 account, mirroring a bind).
 * A NO-OP when the harness is already manually bound (D-001 — never shadow an owner bind) or already
 * soft-pinned to `id`. Pure — the impure caller persists the returned pool.
 */
export function setSoftPin(pool: AccountPool, id: string, slug: string): AccountPool {
  if (manuallyBoundAccount(pool, slug)) return pool; // owner bind wins — don't auto-pin over it
  return {
    accounts: pool.accounts.map((a) => {
      const has = a.softPin?.includes(slug) ?? false;
      if (a.id === id) return has ? a : { ...a, softPin: [...(a.softPin ?? []), slug] };
      if (has) return { ...a, softPin: a.softPin!.filter((s) => s !== slug) }; // drop the stale pin
      return a;
    }),
  };
}

/** Clear a harness's soft pin from whatever account holds it (lazy re-pin / failover). Pure. */
export function clearSoftPin(pool: AccountPool, slug: string): AccountPool {
  return {
    accounts: pool.accounts.map((a) =>
      a.softPin?.includes(slug) ? { ...a, softPin: a.softPin.filter((s) => s !== slug) } : a,
    ),
  };
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
        // Preserve the last-known observed budget (utilization / windowResetAt / utilizationAt): a 429
        // penalty must NOT erase the usage reading, else the Accounts tab loses the "% used" the
        // instant an account gets rate-limited — the exact moment you want to SEE it. Only the
        // pause/penalty fields below are recomputed.
        ...a.rate,
        pausedUntil: Math.max(a.rate.pausedUntil, opts.pausedUntil ?? 0),
        lastPenaltyAt: now,
        penaltyCount: inWindow ? a.rate.penaltyCount + 1 : 1,
        windowStartedAt: inWindow ? a.rate.windowStartedAt : now,
      };
      return { ...a, rate };
    }),
  };
}

/**
 * Clear an account's pause + penalty window (e.g. on a confirmed reset). Pure.
 * Preserves the last-known observed budget (utilization / windowResetAt / utilizationAt) — the reset
 * clears the false-exhaustion pause/penalty, not the real usage reading, so the Accounts tab can
 * still show "~X% used · as of …". Staleness is carried by `utilizationAt`, and the drain selector
 * already discounts a stale reading, so keeping it is safe.
 */
export function recordAccountReset(pool: AccountPool, id: string): AccountPool {
  return {
    accounts: pool.accounts.map((a) =>
      a.id === id
        ? {
            ...a,
            rate: {
              ...freshRate(),
              utilization: a.rate.utilization,
              windowResetAt: a.rate.windowResetAt,
              utilization7d: a.rate.utilization7d,
              windowResetAt7d: a.rate.windowResetAt7d,
              utilizationAt: a.rate.utilizationAt,
            },
          }
        : a,
    ),
  };
}

/**
 * Record an account's observed unified-5h budget window (utilization + reset) into the projection —
 * the cross-process signal the drain selector routes by (the gateway sees the headers; the spawn
 * chokepoint reads this). Stamps `utilizationAt = now` for staleness. A field left undefined keeps
 * its prior value. Unknown id = no-op. Pure.
 */
export function recordAccountWindow(
  pool: AccountPool,
  id: string,
  w: { utilization?: number; windowResetAt?: number; utilization7d?: number; windowResetAt7d?: number },
  now: number,
): AccountPool {
  return {
    accounts: pool.accounts.map((a) => {
      if (a.id !== id) return a;
      const rate: AccountRateState = {
        ...a.rate,
        utilization: w.utilization ?? a.rate.utilization,
        windowResetAt: w.windowResetAt ?? a.rate.windowResetAt,
        utilization7d: w.utilization7d ?? a.rate.utilization7d,
        windowResetAt7d: w.windowResetAt7d ?? a.rate.windowResetAt7d,
        utilizationAt: now,
      };
      return { ...a, rate };
    }),
  };
}

/** Is the account usable right now (not currently paused)? */
export function isAvailable(account: ClaudeAccount, now: number): boolean {
  return account.rate.pausedUntil <= now;
}

/**
 * Is the account *sustainedly* rate-limited — the P-021 scale-out trigger (provisions PAID
 * machines, so a false positive costs money)? True when EITHER:
 *   (a) the freshest observed unified-5h utilization is at/over cap (`EXHAUSTED_UTIL`) — the
 *       genuine, SELF-HEALING budget signal (it decays back below cap as the rolling window
 *       recovers, so the account stops reading exhausted on its own); OR
 *   (b) the account accrued `sustainedPenaltyThreshold` real penalties inside the window (a
 *       repeated-429 burst, not a one-off).
 * A SINGLE far-future pause is deliberately NOT a trigger anymore (D-003 false-exhaustion fix): on
 * Claude Max a single 429 routinely carries a pause to the multi-hour 5h/7d reset even when the
 * account is not actually over budget, which used to flip it straight to "exhausted".
 */
export function isSustainedlyLimited(
  account: ClaudeAccount,
  now: number,
  policy: ScalePolicy = DEFAULT_SCALE_POLICY,
): boolean {
  const r = account.rate;
  const utilFresh = r.utilizationAt !== undefined && now - r.utilizationAt <= DRAIN_UTIL_STALE_MS;
  if (utilFresh && r.utilization !== undefined && r.utilization >= EXHAUSTED_UTIL) return true;
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

export interface SpawnSelectOpts {
  /** The bee's harness slug — pins to an account that has this harness bound (boundTo), so a
   *  harness's bees co-locate on one credential and share the system/tools prefix cache. */
  harness?: string;
  /** The account this (logical) bee last egressed through — kept sticky so its per-credential
   *  conversation cache survives across a re-spawn. */
  priorAccountId?: string;
}

/** Beyond this age the unified-budget projection is treated as unknown (the gateway hasn't egressed
 *  through that account recently), so the drain selector falls back to recency order. */
export const DRAIN_UTIL_STALE_MS = 10 * 60_000;
/** A window resetting within this horizon is "about to reset" — drain its remaining budget first
 *  (use-it-before-you-lose-it: that budget vanishes at the reset). */
export const DRAIN_URGENT_RESET_MS = 20 * 60_000;
/** At/above this unified utilization an account is effectively full — don't route fresh load to it. */
export const DRAIN_FULL_UTIL = 0.97;

/** The account's drain-relevant utilization: the observed unified-5h fraction, or 0 when never
 *  observed / stale (treat as most-available so a cold pool degrades gracefully). */
export function drainUtil(a: ClaudeAccount, now: number): number {
  const r = a.rate;
  if (r.utilization === undefined) return 0;
  if (r.utilizationAt !== undefined && now - r.utilizationAt > DRAIN_UTIL_STALE_MS) return 0;
  return r.utilization;
}

/**
 * The account's 7d-window (WEEKLY) utilization, or 0 when never observed / stale. On Claude Max the
 * 7d window is a HARDER constraint than the 5h: an account can read 5h-fresh yet sit near its weekly
 * cap, so routing fresh load by 5h-util alone hammers it into the 7d limit (the "aviynw2 trap":
 * 5h-util 0.09 but 7d-util 0.96 → a routed bee 429s on the weekly window). Shares `utilizationAt`
 * freshness with `drainUtil` (recordAccountWindow writes both together).
 */
export function drainUtil7d(a: ClaudeAccount, now: number): number {
  const r = a.rate;
  if (r.utilization7d === undefined) return 0;
  if (r.utilizationAt !== undefined && now - r.utilizationAt > DRAIN_UTIL_STALE_MS) return 0;
  return r.utilization7d;
}

/**
 * Effective fullness for routing/ranking: the TIGHTER of the 5h and 7d windows. Ranking + gating by
 * this prefers BOTH-window headroom, so a 5h-fresh-but-7d-near-cap account is correctly deprioritized
 * in favor of an account with real headroom in both windows (7d-aware-account-selection-2026-06-17).
 */
export function effectiveDrainUtil(a: ClaudeAccount, now: number): number {
  return Math.max(drainUtil(a, now), drainUtil7d(a, now));
}

/**
 * Is this account effectively FULL for fresh load — paused, or its (fresh) unified-5h utilization at/
 * above `DRAIN_FULL_UTIL`? Used to (a) LAZILY re-pin a soft cache-affinity pin off a near-cap account
 * (D-002) and (b) decide the account-aware class pause: the opus class only pauses globally when EVERY
 * account is full (mirrors the gateway failover — "only when ALL are exhausted does egress pause").
 */
export function accountFull(a: ClaudeAccount, now: number): boolean {
  // 7d-aware: full when EITHER window is at/over cap (effectiveDrainUtil = max(5h, 7d)), so a
  // 5h-fresh-but-weekly-capped account is not treated as fresh capacity.
  return !isAvailable(a, now) || effectiveDrainUtil(a, now) >= DRAIN_FULL_UTIL;
}

/**
 * Account-aware opus-pause decision (account-aware-rate-governor-routing-2026-06-16 Phase 1). A single
 * account's 429 must NOT pause the whole model class while other accounts have headroom — the class
 * "pauses" ONLY when EVERY account is full (paused or at/over its 5h cap). With ≥1 account having
 * headroom this is false, so the spawn-admission gate keeps admitting (routed to the fresh account by
 * `selectAccountForSpawn`). An EMPTY pool is NOT exhausted (single-credential fallback handles pacing).
 */
export function isClassExhausted(pool: AccountPool, now: number): boolean {
  if (pool.accounts.length === 0) return false;
  return pool.accounts.every((a) => accountFull(a, now));
}

/** Any account with headroom right now (the inverse — a spawn/in-process call can route somewhere
 *  without globally pausing the class). An empty pool reads "available" (frame-default fallback). */
export function anyAccountAvailable(pool: AccountPool, now: number): boolean {
  return pool.accounts.length === 0 || pool.accounts.some((a) => !accountFull(a, now));
}

/**
 * Choose the available account that best FILLS the aggregate Claude Max budget — the multi-account
 * capacity lever (more subscriptions = more aggregate 5h budget; D-003). Keeps every subscription's
 * 5h window productive instead of spreading thin or hammering one. Ranking (ascending = better),
 * among available (not paused) candidates:
 *   1. urgency — a window about to reset AND still under-full sorts first (use-it-before-you-lose-it);
 *   2. lowest current utilization (most remaining 5h budget) — balances load so no window sits idle;
 *   3. least-recently penalized; 4. oldest-added; 5. id (stable tie-break).
 * Utilization that is unknown or stale is treated as 0, so a cold pool degrades to recency order.
 * This is the consumer-Max budget-maximizing selector D-001 wrongly excluded as "unnecessary".
 */
export function selectAccountByDrain(pool: AccountPool, now: number, opts: SelectOpts = {}): ClaudeAccount | undefined {
  const { exclude = [], availableOnly = true } = opts;
  let candidates = pool.accounts.filter((a) => !exclude.includes(a.id));
  if (availableOnly) candidates = candidates.filter((a) => isAvailable(a, now));
  if (candidates.length === 0) return undefined;

  const urgent = (a: ClaudeAccount): boolean => {
    const reset = a.rate.windowResetAt;
    return reset !== undefined && reset - now > 0 && reset - now <= DRAIN_URGENT_RESET_MS && effectiveDrainUtil(a, now) < DRAIN_FULL_UTIL;
  };
  // 7d-aware rank: order by the TIGHTER window (max 5h/7d util) so selection prefers both-window
  // headroom (aviynw6) over a 5h-fresh-but-7d-near-cap account (aviynw2) — 7d-aware-account-selection.
  const rank = (a: ClaudeAccount): number[] => [urgent(a) ? 0 : 1, effectiveDrainUtil(a, now), a.rate.lastPenaltyAt, a.addedAt];
  return [...candidates].sort((x, y) => {
    const rx = rank(x);
    const ry = rank(y);
    for (let i = 0; i < rx.length; i++) if (rx[i] !== ry[i]) return rx[i] - ry[i];
    return x.id < y.id ? -1 : x.id > y.id ? 1 : 0;
  })[0];
}

/**
 * The result of `selectAccountForSpawn`. `accountId` is the chosen egress credential (undefined ⇒ no
 * available account → the caller sets no header, the gateway falls back to its active account).
 * `newlyPinned` is set ONLY when the DRAIN step assigned a fresh soft cache-affinity pin for `harness`
 * → `accountId` that the (impure) caller should PERSIST (account-cache-affinity-auto-pin Phase 1) so
 * the harness's next bees stick to the same credential. `pinSource` is observability: which rule chose.
 */
export interface SpawnSelection {
  accountId?: string;
  /** Set when DRAIN newly soft-pinned this harness to `accountId` — the caller persists the pin. */
  newlyPinned?: { harness: string; accountId: string };
  pinSource?: 'sticky' | 'manual-bind' | 'soft-pin' | 'drain';
}

/**
 * Pick the account a spawning bee should egress through (inference-gateway-multi-credential-routing
 * P-005, corrected to the Claude Max basis — D-003). Cache-affinity FIRST (the dominant cost lever —
 * the conversation/prompt cache is per-credential), then budget-draining among the rest:
 *   1. STICKY — the bee's prior account, if still available (preserves its per-credential cache).
 *   2. MANUAL-BIND — an available account with the harness in `boundTo` (owner/deploy pin); ties → drain.
 *   3. SOFT-PIN — an available, NOT-yet-full account the harness was auto-pinned to (`softPin`), so a
 *      harness's consecutive bees reuse one credential's prompt-cache prefix. A full/paused soft pin is
 *      SKIPPED (lazy re-pin, D-002) and the next step re-pins fresh.
 *   4. DRAIN — otherwise the account that best fills the aggregate Max 5h budget; when a `harness` is
 *      given this also NEWLY soft-pins it (surfaced via `newlyPinned` for the caller to persist), so
 *      the harness amortizes a warm-cache RUN on that account instead of cold-starting per bee.
 * Pure — the soft-pin WRITE-BACK is the caller's (keeps this exhaustively unit-testable).
 */
export function selectAccountForSpawn(pool: AccountPool, now: number, opts: SpawnSelectOpts = {}): SpawnSelection {
  // 1. Sticky to the prior account while it is still usable (cache affinity dominates cost).
  if (opts.priorAccountId) {
    const prior = getAccount(pool, opts.priorAccountId);
    if (prior && isAvailable(prior, now)) return { accountId: prior.id, pinSource: 'sticky' };
  }
  const harness = opts.harness;
  if (harness) {
    // 2. Manually-bound account (owner/deploy intent), best drain among the bound ties.
    const bound = pool.accounts.filter((a) => a.boundTo.includes(harness) && isAvailable(a, now));
    const boundBest = selectAccountByDrain({ accounts: bound }, now);
    if (boundBest) return { accountId: boundBest.id, pinSource: 'manual-bind' };
    // 3. Soft cache-affinity pin — only while it still has headroom (lazy re-pin past the cap, D-002).
    const softPinned = softPinnedAccount(pool, harness);
    if (softPinned && !accountFull(softPinned, now)) return { accountId: softPinned.id, pinSource: 'soft-pin' };
  }
  // 4. Budget-drain across the whole pool; auto-pin the chosen account for a fresh harness.
  const drained = selectAccountByDrain(pool, now);
  if (!drained) return {};
  return {
    accountId: drained.id,
    pinSource: 'drain',
    ...(harness ? { newlyPinned: { harness, accountId: drained.id } } : {}),
  };
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
