/**
 * Compose + run the hive inference gateway as a supervised service (hive-inference-gateway P-013).
 *
 * Wires the pieces: resolve the machine's bound account (account-pool) → a refresh-owning
 * credential resolver (P-003) → the pacing proxy (P-006/P-007/P-011) → the account-pool
 * projection feed on pause (P-009, record-only — the operator owns provisioning). The bees point
 * `ANTHROPIC_BASE_URL` at this localhost port, so if the service is DOWN their requests fail
 * (connection refused) rather than silently bursting direct to Anthropic — the fail-CLOSED
 * property (the systemd unit's `Restart=always` keeps it up).
 *
 * Deps are injectable so the composition is hermetically testable without PG / `~/.claude`.
 */
import { resolveAccountPool, type ResolvedAccount } from './account-resolver';
import { makeBearerCredentialResolver, makeCredentialResolver, type CredentialResolver } from './credential-store';
import { createFailoverPool, type FailoverPoolOptions } from './account-failover';
import { createInferenceGateway, parseUnifiedWindow, parseUnified7dWindow, type AccountPool, type ActiveAccount, type InferenceGateway } from './gateway';
import {
  parsePriorityTierMap,
  tiersOfMap,
  defaultTierCaps,
  DEFAULT_GATEWAY_PRIORITY_MAP,
  type PriorityTierMap,
  type TierAdmissionConfig,
} from '@papercusp/papercusp-shared/agent';

/** Default localhost port for the gateway (not one of the dev stack's ports). */
export const DEFAULT_GATEWAY_PORT = 8788;

/** Reserved-floor fraction of the admission pool held for tier 1 (gateway-priority-tiers-2026-06-22).
 *  `reserve = max(1, ceil(poolSlots * frac))`. Env-tunable via `GATEWAY_T1_RESERVE_FRAC`. */
export const DEFAULT_T1_RESERVE_FRAC = 0.15;

/**
 * Resolve the priority-TIER admission config (gateway-priority-tiers-2026-06-22), flag-gated by
 * `GATEWAY_PRIORITY_TIERS`. Returns `null` when the flag is OFF (the gateway then runs its flat
 * priority+aging queue, byte-identical to today). When ON, builds the role→tier map (defaults merged
 * with the `GATEWAY_PRIORITY_MAP` JSON env), the per-tier in-flight caps + the reserved tier-1 floor
 * (`max(1, ceil(poolSlots * GATEWAY_T1_RESERVE_FRAC))`) sized to `poolSlots` (the admission concurrency).
 * Pure-ish: the only side effect is the flag read; env parsing is the resilience lib's pure helpers.
 */
export async function resolvePriorityTiers(
  poolSlots: number,
  opts: { flagOverride?: boolean; env?: NodeJS.ProcessEnv } = {},
): Promise<{ map: PriorityTierMap; config: TierAdmissionConfig } | null> {
  let on = opts.flagOverride;
  if (on === undefined) {
    const { getFlag } = await import('@papercusp/flags/server');
    const { FLAGS } = await import('@papercusp/flags');
    on = await getFlag(FLAGS.GATEWAY_PRIORITY_TIERS, 'system');
  }
  if (!on) return null;
  const env = opts.env ?? process.env;
  const map = parsePriorityTierMap(env.GATEWAY_PRIORITY_MAP, DEFAULT_GATEWAY_PRIORITY_MAP);
  const fracRaw = Number(env.GATEWAY_T1_RESERVE_FRAC);
  const frac = Number.isFinite(fracRaw) && fracRaw >= 0 ? fracRaw : DEFAULT_T1_RESERVE_FRAC;
  const tiers = tiersOfMap(map);
  const { caps, reserve } = defaultTierCaps(poolSlots, tiers, frac);
  return { map, config: { caps, tier1Reserve: reserve } };
}

export interface GatewayServiceOptions {
  port?: number;
  workspace?: string;
  concurrency?: number;
  upstreamBase?: string;
  /** Proactively refresh the bound token on this interval (ms). 0 = on-demand only. Default 45 min. */
  refreshIntervalMs?: number;
  /** Poll interval (ms) to HOT-RELOAD the DB account pool into the live failover pool WITHOUT a restart
   *  (B-HOT-1). 0 = disabled. Default 60s. Tests inject a tiny value (or 0) to control it. */
  poolReloadIntervalMs?: number;
  log?: (level: 'info' | 'warn' | 'error', msg: string) => void;
  // ── injectable for tests ──
  /** Resolve a SINGLE bound account (back-compat). When set, takes precedence over resolveAccounts
   *  and yields a one-account, no-failover pool. */
  resolveAccount?: (ws?: string) => Promise<ResolvedAccount>;
  /** Resolve the full failover pool (EI-535). Default: resolveAccountPool. */
  resolveAccounts?: (ws?: string, provider?: 'claude' | 'codex') => Promise<ResolvedAccount[]>;
  makeResolver?: (credentialRef: string, accountId: string) => CredentialResolver;
  /** Subscribe the account-pool projection feed; returns an unsubscribe. Default: initAccountScaleObserver (record-only). */
  observePool?: (accountId: string, ws: string | undefined, log: GatewayServiceOptions['log']) => () => void;
  fetchImpl?: typeof fetch;
}

export interface RunningGatewayService {
  gateway: InferenceGateway;
  port: number;
  account: ResolvedAccount;
  /** Current account-pool config version — bumps on each successful hot-reload (B-HOT-1). */
  configVersion(): number;
  /** Hot-reload the account pool from the DB source-of-truth WITHOUT a restart. No-op if unchanged or
   *  not hot-reloadable. Returns whether it changed + the new version + the live account ids. */
  reloadPool(): Promise<{ changed: boolean; version: number; accounts: string[] }>;
  stop(): Promise<void>;
}

/** Default pool-feed: record each pause into the account-pool projection (PG) so the operator's
    scale-out + accounts:status see a gateway-paced account's exhaustion; provisioning stays the
    operator's job (record-only scaleOut). */
function defaultObservePool(_accountId: string, ws: string | undefined, log: GatewayServiceOptions['log']): () => void {
  // Lazy import to keep the gateway bin's cold-start light + avoid a PG import in tests that inject.
  let unsub = () => {};
  void import('../deployment/account-pool-store')
    .then(({ initAccountScaleObserver }) => {
      unsub = initAccountScaleObserver({
        workspaceId: ws ? () => ws : undefined,
        scaleOut: async () => ({ scaledOut: false as const, reason: 'no-fresh-account' as const }),
        log: log ? (lvl, m) => log(lvl, m) : undefined,
      });
    })
    .catch((e) => log?.('warn', `pool-feed observer not wired: ${(e as Error).message}`));
  return () => unsub();
}

/**
 * Build the gateway `onResponse` hook that feeds each upstream response's unified-5h budget window
 * (utilization + reset) into the account-pool projection (D-003). The gateway is the ONLY process
 * that sees these headers, so this is how the spawn-side drain selector (`selectAccountForSpawn`)
 * gets real cross-process budget. Throttled: ≤1 PG write / 30s / account, and only on a meaningful
 * utilization move (≥0.03) or a window-reset roll — the projection is low-churn, the gateway hot.
 */
function makeWindowProjector(
  ws: string | undefined,
  log: (level: 'info' | 'warn' | 'error', msg: string) => void,
): (headers: Record<string, string | undefined>, status: number, model: string, accountId: string) => void {
  const WRITE_MIN_MS = 30_000;
  const last = new Map<string, { util: number; resetAt: number; util7d: number; resetAt7d: number; at: number }>();
  return (headers, _status, _model, accountId) => {
    const w = parseUnifiedWindow(headers);
    const w7 = parseUnified7dWindow(headers);
    if (
      w.utilization === undefined &&
      w.windowResetAt === undefined &&
      w7.utilization7d === undefined &&
      w7.windowResetAt7d === undefined
    )
      return;
    const t = Date.now();
    const prev = last.get(accountId);
    const util = w.utilization ?? prev?.util ?? 0;
    const resetAt = w.windowResetAt ?? prev?.resetAt ?? 0;
    const util7d = w7.utilization7d ?? prev?.util7d ?? 0;
    const resetAt7d = w7.windowResetAt7d ?? prev?.resetAt7d ?? 0;
    if (prev && t - prev.at < WRITE_MIN_MS) return; // throttle
    // Write on a meaningful move in EITHER window (≥0.03 utilization) or a reset roll.
    const significant =
      !prev ||
      Math.abs(util - prev.util) >= 0.03 ||
      resetAt !== prev.resetAt ||
      Math.abs(util7d - prev.util7d) >= 0.03 ||
      resetAt7d !== prev.resetAt7d;
    if (!significant) return;
    last.set(accountId, { util, resetAt, util7d, resetAt7d, at: t });
    void import('../deployment/account-pool-store')
      .then(({ updateAccountPool }) =>
        import('../deployment/account-pool').then(({ recordAccountWindow }) =>
          updateAccountPool(
            (p) =>
              recordAccountWindow(
                p,
                accountId,
                {
                  utilization: util,
                  windowResetAt: resetAt || undefined,
                  utilization7d: util7d || undefined,
                  windowResetAt7d: resetAt7d || undefined,
                },
                t,
              ),
            ws,
          ),
        ),
      )
      .catch((e) => log('warn', `account window projection write failed for '${accountId}': ${(e as Error).message}`));
  };
}

function createOptionalFailoverPool(
  entries: readonly ActiveAccount[],
  opts: FailoverPoolOptions = {},
): AccountPool {
  let inner: AccountPool | null = entries.length ? createFailoverPool(entries, opts) : null;
  const unavailable = () => new Error('inference-gateway: no Codex account pool configured');
  return {
    active() {
      if (!inner) throw unavailable();
      return inner.active();
    },
    onExhausted(exhaustedId, resetAt) {
      return inner?.onExhausted(exhaustedId, resetAt) ?? null;
    },
    select(accountId) {
      return inner?.select?.(accountId) ?? null;
    },
    readmit(accountId) {
      inner?.readmit?.(accountId);
    },
    reload(next) {
      if (next.length === 0) {
        inner = null;
        opts.log?.('info', 'inference-gateway: Codex account pool hot-reloaded → []');
        return;
      }
      if (inner?.reload) inner.reload(next);
      else inner = createFailoverPool(next, opts);
    },
  };
}

export async function startGatewayService(opts: GatewayServiceOptions = {}): Promise<RunningGatewayService> {
  const log = opts.log ?? ((lvl, m) => console.log(`[inference-gateway:${lvl}] ${m}`));
  const makeResolver = opts.makeResolver ?? makeCredentialResolver;
  const observePool = opts.observePool ?? defaultObservePool;

  // Resolve the account pool. A legacy single `resolveAccount` injection → a one-account pool
  // (back-compat, no failover); otherwise the full pool (EI-535 failover across all accounts).
  // Resolve + build the live failover-pool entries (and their credential resolvers) for an account set.
  // Factored so a HOT-RELOAD (B-HOT-1) can re-resolve the DB pool + rebuild the entries from the same recipe.
  function buildResolved(accts: ResolvedAccount[]) {
    const rs = accts.map((a) => ({ account: a, resolver: makeResolver(a.credentialRef, a.accountId) }));
    const entries = rs.map(({ account, resolver }) => ({
      accountId: account.accountId,
      token: () => resolver.current(),
      invalidateToken: () => resolver.invalidate(),
      // Per-account IP routing (D-003): route this account's upstream through its own egress dispatcher
      // (proxy / bound source IP) when configured; absent ⇒ default shared egress.
      egress: account.egress,
    }));
    return { resolvers: rs, entries };
  }
  /** Stable signature of a resolved pool — id + credentialRef + egress — so a reload only swaps on a REAL
   *  change, not on every poll. */
  const sigOf = (a: ResolvedAccount[]) =>
    a.map((x) => `${x.accountId}|${x.credentialRef}|${x.egress?.proxyUrl ?? ''}|${x.egress?.localAddress ?? ''}`).join(',');

  let accounts: ResolvedAccount[] = opts.resolveAccount
    ? [await opts.resolveAccount(opts.workspace)]
    : await (opts.resolveAccounts ?? resolveAccountPool)(opts.workspace, 'claude');
  if (accounts.length === 0) throw new Error('inference-gateway: no account resolved');
  let codexAccounts: ResolvedAccount[] = opts.resolveAccount
    ? []
    : await (opts.resolveAccounts ?? resolveAccountPool)(opts.workspace, 'codex');

  const built0 = buildResolved(accounts);
  let resolvers = built0.resolvers;
  let primary = accounts[0];
  log(
    'info',
    `account pool [${accounts.map((a) => a.accountId).join(', ')}]; primary '${primary.accountId}' via ${primary.source} (channel ${primary.credentialRef.split(':')[0]})`,
  );

  const pool = createFailoverPool(built0.entries, { log });
  const buildBearerEntries = (accts: ResolvedAccount[]) =>
    accts.map((a) => {
      const resolver = makeBearerCredentialResolver(a.credentialRef);
      return { accountId: a.accountId, token: () => resolver.current(), invalidateToken: () => resolver.invalidate(), egress: a.egress };
    });
  const codexPool = createOptionalFailoverPool(buildBearerEntries(codexAccounts), { log });
  const unobserve = observePool(primary.accountId, opts.workspace, log);

  // Priority-TIER admission config (gateway-priority-tiers-2026-06-22) — flag-gated; null (omitted) under
  // flag-OFF so the gateway runs its flat priority+aging queue unchanged. Sized to the admission concurrency
  // (the slot pool the reserved tier-1 floor protects).
  const DEFAULT_CONCURRENCY = 24; // mirrors gateway.ts's default; the reserved floor is sized to this pool
  const priorityTiers = await resolvePriorityTiers(opts.concurrency ?? DEFAULT_CONCURRENCY).catch((e) => {
    // Fail-safe: a flag/env read fault must never block the gateway from starting → fall back to the flat
    // queue (flag-OFF behavior), loudly.
    log('warn', `inference-gateway: priority-tier config resolve failed (${(e as Error).message}) — running the flat admission queue`);
    return null;
  });
  if (priorityTiers) {
    log(
      'info',
      `inference-gateway: priority-tier admission ON — reserve=${priorityTiers.config.tier1Reserve} caps=${JSON.stringify(priorityTiers.config.caps)}`,
    );
  }

  const gateway = createInferenceGateway({
    pool,
    codexPool,
    upstreamBase: opts.upstreamBase,
    openaiUpstreamBase: process.env.OPENAI_BASE_URL_UPSTREAM || undefined,
    concurrency: opts.concurrency,
    ...(priorityTiers ? { priorityTiers } : {}),
    fetchImpl: opts.fetchImpl,
    log,
    onResponse: makeWindowProjector(opts.workspace, log),
    // B-HOT-2: expose the live config + on-demand hot-reload over /admin/config + /admin/reload.
    // `reloadPool` is a hoisted function declaration; `configVersion`/`accounts` are read lazily at
    // request time (after their initialisers run), so referencing them here is safe.
    onAdminReload: () => reloadPool(),
    adminConfig: () => ({ version: configVersion, accounts: accounts.map((a) => a.accountId), codexAccounts: codexAccounts.map((a) => a.accountId) }),
  });

  const port = await gateway.listen(opts.port ?? DEFAULT_GATEWAY_PORT);

  // HOT-RELOAD (B-HOT-1): re-resolve the DB account pool (the source of truth) + atomically swap it into
  // the LIVE failover pool WITHOUT a gateway restart. No-op when nothing changed (same signature) or the
  // pool can't hot-reload. Returns the new config version + live account ids; called by the poll below +
  // the /admin/reload endpoint (B-HOT-2).
  let configVersion = 1;
  async function reloadPool(): Promise<{ changed: boolean; version: number; accounts: string[] }> {
    const ids = (a: ResolvedAccount[]) => a.map((x) => x.accountId);
    const next = opts.resolveAccount
      ? [await opts.resolveAccount(opts.workspace)]
      : await (opts.resolveAccounts ?? resolveAccountPool)(opts.workspace, 'claude');
    const nextCodex = opts.resolveAccount ? [] : await (opts.resolveAccounts ?? resolveAccountPool)(opts.workspace, 'codex');
    if (next.length === 0) {
      log('warn', 'inference-gateway: pool reload resolved an EMPTY pool — keeping the current pool (fail-safe)');
      return { changed: false, version: configVersion, accounts: ids(accounts) };
    }
    const unchanged = sigOf(next) === sigOf(accounts) && sigOf(nextCodex) === sigOf(codexAccounts);
    if (!pool.reload || unchanged) {
      return { changed: false, version: configVersion, accounts: ids(accounts) };
    }
    const built = buildResolved(next);
    pool.reload(built.entries);
    if (codexPool.reload) {
      codexPool.reload(buildBearerEntries(nextCodex));
    }
    accounts = next;
    codexAccounts = nextCodex;
    resolvers = built.resolvers;
    primary = next[0];
    configVersion++;
    log('info', `inference-gateway: account pool HOT-RELOADED to v${configVersion} [${ids(next).join(', ')}] — no restart`);
    return { changed: true, version: configVersion, accounts: ids(next) };
  }

  // Warm the primary's token now (fail fast on a bad primary credential) + a proactive refresh timer for
  // every file-kind resolver, so an idle gateway never serves the first post-idle request — on ANY pool
  // account — with an expired token. The timer reads the CURRENT resolvers each tick, so a hot-reloaded
  // account's token is proactively refreshed too.
  await resolvers[0].resolver.current().catch((e) => log('warn', `initial token resolve failed: ${(e as Error).message}`));
  const refreshMs = opts.refreshIntervalMs ?? 45 * 60 * 1000;
  let timer: ReturnType<typeof setInterval> | undefined;
  if (refreshMs > 0) {
    timer = setInterval(() => {
      for (const { resolver } of resolvers) {
        if (resolver.kind !== 'file') continue;
        resolver.invalidate();
        void resolver.current().catch((e) => log('warn', `proactive refresh failed: ${(e as Error).message}`));
      }
    }, refreshMs);
    timer.unref?.();
  }

  // POLL the DB pool (B-HOT-1): periodically hot-reload so an account registered / removed / egress-changed
  // via accounts:* applies LIVE (no restart — the friction that needed two restarts to swap one account).
  // Default 60s; 0 disables. Skipped when the pool can't hot-reload (a single-account back-compat pool).
  const reloadMs = opts.poolReloadIntervalMs ?? 60_000;
  let reloadTimer: ReturnType<typeof setInterval> | undefined;
  if (reloadMs > 0 && pool.reload) {
    reloadTimer = setInterval(() => {
      void reloadPool().catch((e) => log('warn', `pool reload poll failed: ${(e as Error).message}`));
    }, reloadMs);
    reloadTimer.unref?.();
  }

  return {
    gateway,
    port,
    get account() {
      return primary; // the primary can change across a hot-reload
    },
    configVersion: () => configVersion,
    reloadPool,
    async stop() {
      if (timer) clearInterval(timer);
      if (reloadTimer) clearInterval(reloadTimer);
      unobserve();
      await gateway.close();
    },
  };
}
