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
import { CODEX_CLI_REF_PREFIX, parseCodexCliRef, type CodexCliAccount } from './codex-cli-bridge';
import { makeBearerCredentialResolver, makeCredentialResolver, type CredentialResolver } from './credential-store';
import { createFailoverPool, type FailoverPoolOptions } from './account-failover';
import { createInferenceGateway, parseUnifiedWindow, parseUnified7dWindow, type AccountPool, type ActiveAccount, type InferenceGateway } from './gateway';
import { createLocalBackendPool, type LocalBackend, type LocalBackendPool } from './local-backend-pool';
import type { LocalBackendRecord } from './local-backend-store';
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
  /** Resolve the local inference-backend registry (llama-server/vllm/ollama pool,
   *  local-concurrent-inference-2026-07-02 P-004). Default: lazy-imports
   *  local-backend-store's listLocalBackends (kept lazy so a test that injects this option, or a
   *  deployment that never registers a local backend, never touches PG for it). */
  resolveLocalBackends?: (ws?: string) => Promise<LocalBackendRecord[]>;
  /** Poll interval (ms) to hot-reload the local-backend registry + run its health checks. 0 disables.
   *  Default 30s — independent of poolReloadIntervalMs (local backends are cheaper to re-check and a
   *  dead local process should drop out of rotation fast). */
  localBackendReloadIntervalMs?: number;
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

/**
 * Build the gateway `onCredentialDead` side-channel (#5 PART A). The gateway calls this FIRE-AND-FORGET the
 * first time an account's credential 401s past the dead threshold despite the drop+refresh — i.e. a genuinely
 * DEAD/expired credential silently breaking spawns/evals. We surface it LOUDLY: a durable human-facing
 * escalation (severity 'blocker', tagged `source: 'credential-health'` so the open is TRANSITION-ONLY —
 * idempotent across the whole dead episode, not re-opened every 401 request) + a fleet broadcast.
 *
 * The escalation is per-ACCOUNT-keyed (`meta.deadAccountId`) so two different dead credentials each get their
 * own alert, and a second dead credential isn't swallowed by the first account's still-open escalation. The
 * gateway clears the per-account streak on the next successful auth (a 2xx); a LATER episode on the same
 * account re-fires only after a fresh streak crosses the threshold again — but if the prior escalation is still
 * open (nobody resolved it) we don't pile a duplicate on top. Best-effort: every import/IO failure is swallowed
 * (it must never throw back into the gateway's fire-and-forget call).
 */
function makeCredentialHealthAlert(
  ws: string | undefined,
  log: (level: 'info' | 'warn' | 'error', msg: string) => void,
): (info: { accountId: string; consecutive401s: number }) => void {
  const identity = { ownerId: 'inference-gateway', ownerLabel: 'inference-gateway', source: 'static-client' as const, workspaceId: ws ?? null, userId: null };
  return ({ accountId, consecutive401s }) => {
    void (async () => {
      const summary = `Inference credential for account '${accountId}' is DEAD — ${consecutive401s} consecutive 401s despite token refresh; spawns/evals on it will fail "produced no turn"`;
      const body =
        `The inference gateway dropped + refreshed account '${accountId}'s OAuth token after each 401, but the refresh keeps yielding the same invalid credential — so it is genuinely dead/expired (revoked, or its refresh token is bad), not merely stale-cached. ` +
        `Re-authenticate or replace the credential (accounts:* / re-login) and the gateway's next successful 2xx for this account clears the alert state. Routing has already failed this account over to a healthy account where one exists.`;
      // Durable, transition-only escalation (idempotent per dead account).
      try {
        const { openEscalation, listEscalations } = await import('../agent-tools/coordination/escalations');
        const open = await listEscalations({ status: 'open' });
        const already = open.some(
          (e) =>
            (e as Record<string, unknown>).source === 'credential-health' &&
            (e as Record<string, unknown>).deadAccountId === accountId,
        );
        if (!already) {
          await openEscalation(identity, {
            severity: 'blocker',
            summary,
            body,
            meta: { source: 'credential-health', deadAccountId: accountId, consecutive401s },
          });
        }
      } catch (e) {
        log('warn', `credential-health escalation failed for '${accountId}': ${(e as Error).message}`);
      }
      // Loud fleet broadcast (best-effort, independent of the escalation).
      try {
        const { sendMessage } = await import('../agent-tools/coordination/messages');
        await sendMessage(identity, { to: ['*'], summary, body, category: 'service-health' });
      } catch (e) {
        log('warn', `credential-health broadcast failed for '${accountId}': ${(e as Error).message}`);
      }
    })();
  };
}

/**
 * Build the gateway `onOrgDisallowed` side-channel. The gateway calls this FIRE-AND-FORGET the first time an
 * account returns a short streak of org/subscription-disqualified 403s ("not allowed for this organization" /
 * "subscription disabled for claude code") — a PERMANENT Anthropic-side disable the 6h in-memory pause can't
 * cure (it resets on every gateway restart, re-exposing the dead account: aviynw, 2026-07-01). We PERSISTENTLY
 * remove the account from the pool (survives restarts, never re-selected) + surface a LOUD transition-only
 * escalation + fleet broadcast. Best-effort: every IO failure is swallowed (must never throw into the gateway).
 */
function makeOrgDisallowedDeactivator(
  ws: string | undefined,
  log: (level: 'info' | 'warn' | 'error', msg: string) => void,
): (info: { accountId: string; consecutive: number }) => void {
  const identity = { ownerId: 'inference-gateway', ownerLabel: 'inference-gateway', source: 'static-client' as const, workspaceId: ws ?? null, userId: null };
  return ({ accountId, consecutive }) => {
    void (async () => {
      const summary = `Inference account '${accountId}' is org/subscription-DISABLED for Claude Code — removed from the pool`;
      const body =
        `Account '${accountId}' returned ${consecutive} consecutive org/subscription-disqualified 403s ("not allowed for this organization" / "subscription disabled for claude code") — a PERMANENT Anthropic-side disable, NOT a throttle. The gateway's 6h pause only lived in memory + reset on every restart, so the dead account kept re-entering rotation and failing spawns. It has now been PERSISTENTLY removed from the pool. ` +
        `To restore it: re-enable OAuth API / Claude Code access in that account's Anthropic organization, then re-register it (accounts:register).`;
      // 1. PERSISTENTLY remove the dead account (survives gateway/bg-host restarts; the in-memory pause did not).
      try {
        const [{ loadAccountPool, saveAccountPool }, { removeAccount }] = await Promise.all([
          import('../deployment/account-pool-store'),
          import('../deployment/account-pool'),
        ]);
        const pool = await loadAccountPool(ws);
        if (pool.accounts.some((a) => a.id === accountId)) {
          await saveAccountPool(removeAccount(pool, accountId), ws);
          log('error', `inference-gateway: PERSISTENTLY removed org-disabled account '${accountId}' from the pool (${consecutive} consecutive org-disallowed 403s)`);
        }
      } catch (e) {
        log('warn', `org-disallowed persistent removal of '${accountId}' failed: ${(e as Error).message}`);
      }
      // 2. Durable, transition-only escalation (idempotent per dead account).
      try {
        const { openEscalation, listEscalations } = await import('../agent-tools/coordination/escalations');
        const open = await listEscalations({ status: 'open' });
        const already = open.some(
          (e) =>
            (e as Record<string, unknown>).source === 'account-org-disallowed' &&
            (e as Record<string, unknown>).deadAccountId === accountId,
        );
        if (!already) {
          await openEscalation(identity, {
            severity: 'blocker',
            summary,
            body,
            meta: { source: 'account-org-disallowed', deadAccountId: accountId, consecutive },
          });
        }
      } catch (e) {
        log('warn', `org-disallowed escalation failed for '${accountId}': ${(e as Error).message}`);
      }
      // 3. Loud fleet broadcast (best-effort, independent of the escalation).
      try {
        const { sendMessage } = await import('../agent-tools/coordination/messages');
        await sendMessage(identity, { to: ['*'], summary, body, category: 'service-health' });
      } catch (e) {
        log('warn', `org-disallowed broadcast failed for '${accountId}': ${(e as Error).message}`);
      }
    })();
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
  // Local inference-backend pool (D-002): OPT-IN — the default resolver returns empty (no PG touch),
  // so every existing caller (tests, and any deployment that doesn't pass resolveLocalBackends) is
  // byte-identical to before this landed: zero registered backends ⇒ the pool stays empty ⇒ the
  // gateway's local-backend routes just 404 like they did when the feature didn't exist. A deployment
  // that WANTS the local-backend pool passes `resolveLocalBackends` wired to local-backend-store's
  // listLocalBackends (see bin.ts) — mirrors defaultObservePool's lazy-import-only-when-used shape.
  const resolveLocalBackends = opts.resolveLocalBackends ?? (async () => []);
  const localBackendPool: LocalBackendPool = createLocalBackendPool();
  const localBackendSig = (bs: readonly LocalBackend[]) =>
    [...bs]
      .map((b) => `${b.id}|${b.kind}|${b.baseUrl}|${b.models.join(',')}|${b.maxConcurrent}|${b.enabled}`)
      .sort()
      .join(';');
  /** Hot-reload the local-backend registry from the DB into the live pool. Fail-soft: a load error
   *  (e.g. migration 445 not yet applied) logs + leaves the current live pool untouched rather than
   *  crashing gateway startup — local backends are additive, never load-bearing for the gateway itself. */
  async function refreshLocalBackends(): Promise<{ changed: boolean; count: number }> {
    let records: LocalBackendRecord[];
    try {
      records = await resolveLocalBackends(opts.workspace);
    } catch (e) {
      log('warn', `inference-gateway: local-backend registry load failed: ${(e as Error).message}`);
      return { changed: false, count: localBackendPool.size() };
    }
    const next: LocalBackend[] = records
      .filter((r) => r.enabled)
      .map((r) => ({ id: r.id, kind: r.kind, baseUrl: r.baseUrl, models: r.models, maxConcurrent: r.maxConcurrent, enabled: r.enabled }));
    const changed = localBackendSig(next) !== localBackendSig(localBackendPool.entries());
    if (changed) {
      localBackendPool.reload(next);
      log('info', `inference-gateway: local-backend pool HOT-RELOADED [${next.map((b) => b.id).join(', ') || '(empty)'}]`);
    }
    return { changed, count: next.length };
  }

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
      // Per-account egress IP POOL (gateway-per-account-egress-ip-pool-2026-06-30): the rotating list of
      // egress IPs; when set the gateway round-robins this account's upstream across them so a per-IP
      // Cloudflare throttle takes one IP out of rotation, not the whole account.
      egressPool: account.egressPool,
    }));
    return { resolvers: rs, entries };
  }
  /** Stable signature of a resolved pool — id + credentialRef + egress (singular + pool) — so a reload only
   *  swaps on a REAL change, not on every poll. */
  const egSig = (e?: { proxyUrl?: string; localAddress?: string }) => `${e?.proxyUrl ?? ''}~${e?.localAddress ?? ''}`;
  const sigOf = (a: ResolvedAccount[]) =>
    a
      .map(
        (x) =>
          `${x.accountId}|${x.credentialRef}|${egSig(x.egress)}|${(x.egressPool ?? []).map(egSig).join('+')}`,
      )
      .join(',');

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
  // ChatGPT-subscription bridge (codex-cli-bridge.ts): a codex account whose credentialRef is
  // `codex-cli:<CODEX_HOME>` has NO API bearer — it is served by driving the codex CLI. Keep such
  // accounts OUT of the bearer pool (makeBearerCredentialResolver would throw on the scheme) and
  // hand them to the gateway as the CLI list. `codexAccounts` is reassigned by reloadPool, so the
  // getter below stays hot-reload-fresh for free.
  const cliAccountsOf = (accts: ResolvedAccount[]): CodexCliAccount[] =>
    accts.flatMap((a) => {
      const home = parseCodexCliRef(a.credentialRef);
      return home ? [{ accountId: a.accountId, home }] : [];
    });
  const buildBearerEntries = (accts: ResolvedAccount[]) =>
    accts
      .filter((a) => !a.credentialRef.startsWith(CODEX_CLI_REF_PREFIX))
      .map((a) => {
        const resolver = makeBearerCredentialResolver(a.credentialRef);
        return { accountId: a.accountId, token: () => resolver.current(), invalidateToken: () => resolver.invalidate(), egress: a.egress, egressPool: a.egressPool };
      });
  const codexPool = createOptionalFailoverPool(buildBearerEntries(codexAccounts), { log });
  {
    const cli0 = cliAccountsOf(codexAccounts);
    if (cli0.length) {
      log('info', `inference-gateway: codex-cli (ChatGPT subscription) bridge accounts [${cli0.map((a) => a.accountId).join(', ')}]`);
    }
  }
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

  // codex-gateway-oauth-proxy-2026-07-04 (WI-2198): flag-gated. ON ⇒ a codex-cli
  // (ChatGPT-subscription) account serves a STREAMING /v1/responses via the OAuth
  // reverse-proxy (codex-oauth-proxy.ts) to chatgpt.com/backend-api/codex instead of
  // the one-shot exec bridge. Fail-safe: a flag read fault ⇒ OFF (exec bridge,
  // byte-identical to today). Resolved at the launch layer so unit tests default it off.
  const codexOAuthProxy = await (async () => {
    try {
      const { getFlag } = await import('@papercusp/flags/server');
      const { FLAGS } = await import('@papercusp/flags');
      return await getFlag(FLAGS.CODEX_GATEWAY_OAUTH_PROXY, 'system');
    } catch (e) {
      log('warn', `inference-gateway: codex-oauth-proxy flag read failed (${(e as Error).message}) — exec bridge`);
      return false;
    }
  })();
  if (codexOAuthProxy) {
    log('info', 'inference-gateway: codex OAuth streaming proxy ON — codex-cli accounts stream via the ChatGPT backend');
  }

  const gateway = createInferenceGateway({
    pool,
    codexPool,
    codexOAuthProxy,
    // Getter (not a snapshot) so a reloadPool() that adds/removes a codex-cli account
    // applies to the very next /v1/responses request without a gateway restart.
    codexCliAccounts: () => cliAccountsOf(codexAccounts),
    upstreamBase: opts.upstreamBase,
    openaiUpstreamBase: process.env.OPENAI_BASE_URL_UPSTREAM || undefined,
    concurrency: opts.concurrency,
    // Smooth each per-account RPM allowance into an even pace so the fleet can't fire a sub-minute BURST
    // that trips Anthropic's burst limit (the bare-burst 429 storm, 2026-06-23). Throughput-neutral (the
    // per-minute count gate still caps the rate). On by default in production; set PAPERCUSP_GATEWAY_RPM_SMOOTH=0
    // to disable (ops kill-switch). Resolved here at the launch layer so unit tests default it off.
    smoothRpm: process.env.PAPERCUSP_GATEWAY_RPM_SMOOTH !== '0',
    ...(priorityTiers ? { priorityTiers } : {}),
    fetchImpl: opts.fetchImpl,
    log,
    onResponse: makeWindowProjector(opts.workspace, log),
    // #5 PART A: a DEAD credential (consecutive 401s despite refresh) fires a loud escalation + broadcast.
    onCredentialDead: makeCredentialHealthAlert(opts.workspace, log),
    // org-disable is a PERMANENT Anthropic-side disqualification, not a throttle — the gateway's in-memory
    // pause resets on restart, so persistently REMOVE the dead account from the pool (+ loud escalation).
    onOrgDisallowed: makeOrgDisallowedDeactivator(opts.workspace, log),
    // B-HOT-2: expose the live config + on-demand hot-reload over /admin/config + /admin/reload.
    // `reloadPool` is a hoisted function declaration; `configVersion`/`accounts` are read lazily at
    // request time (after their initialisers run), so referencing them here is safe.
    onAdminReload: () => reloadPool(),
    adminConfig: () => ({ version: configVersion, accounts: accounts.map((a) => a.accountId), codexAccounts: codexAccounts.map((a) => a.accountId) }),
    // Local inference-backend pool (D-002): the pool object's identity is fixed for the gateway's life;
    // refreshLocalBackends() below mutates it in place via reload(), so this reference stays live.
    localBackends: localBackendPool,
    onAdminReloadLocalBackends: () => refreshLocalBackends(),
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

  // DYNAMIC OWNER PIN durability (account-dynamic-pin-2026-06-29): load the durable agent→account pins from
  // the DB store into the gateway at startup + on the poll, so they SURVIVE a gateway restart (in-memory
  // alone dropped them silently on the wedge-watchdog / deploy / crash restarts). The accounts:pin tool also
  // pushes each change to /admin/owner-pin for IMMEDIATE effect; this is the load + periodic-resync path.
  const refreshGatewayHints = async (): Promise<void> => {
    const { activeWorkspaceId } = await import('../workspace-registry');
    const ws = opts.workspace ?? activeWorkspaceId();
    // RATE HINTS (cold-start seed) — from operator_account_pool (migration 190, ALWAYS present): seed keyOf
    // so a known-dead account is disqualified immediately after a restart. Independent try so it works even
    // before the owner-pins table (migration 416) exists.
    try {
      const { loadAccountPool } = await import('../deployment/account-pool-store');
      const poolFull = await loadAccountPool(ws);
      gateway.setAccountRateHints(
        (poolFull.accounts ?? []).map((a) => ({
          accountId: a.id,
          pausedUntil: a.rate?.pausedUntil,
          utilization: a.rate?.utilization,
          utilization7d: a.rate?.utilization7d,
          windowResetAt: a.rate?.windowResetAt,
          windowResetAt7d: a.rate?.windowResetAt7d,
        })),
      );
    } catch (e) {
      log('warn', `inference-gateway: rate-hint refresh failed: ${(e as Error).message}`);
    }
    // OWNER PINS (durable dynamic pins) — from operator_owner_pins (migration 416). Fail-soft until that
    // migration boot-applies; the in-memory pins set via /admin/owner-pin still work in the interim.
    try {
      const { getOwnerPinsList } = await import('../deployment/account-owner-pins');
      gateway.setOwnerPins(await getOwnerPinsList(ws));
    } catch (e) {
      log('warn', `inference-gateway: owner-pin refresh failed (expected until migration 416 applies): ${(e as Error).message}`);
    }
  };
  await refreshGatewayHints();
  let hintTimer: ReturnType<typeof setInterval> | undefined;
  if (reloadMs > 0) {
    hintTimer = setInterval(() => void refreshGatewayHints(), reloadMs);
    hintTimer.unref?.();
  }

  // Local inference-backend pool (D-002): load the registry now (so the FIRST request after boot
  // already sees any registered backend, not just after the first poll tick) + a periodic
  // reload-from-DB + health-check tick. Fail-soft — see refreshLocalBackends' own try/catch.
  await refreshLocalBackends();
  const localBackendReloadMs = opts.localBackendReloadIntervalMs ?? 30_000;
  let localBackendTimer: ReturnType<typeof setInterval> | undefined;
  if (localBackendReloadMs > 0) {
    localBackendTimer = setInterval(() => {
      void refreshLocalBackends();
      void localBackendPool.runHealthChecks().catch((e) => log('warn', `inference-gateway: local-backend health check failed: ${(e as Error).message}`));
    }, localBackendReloadMs);
    localBackendTimer.unref?.();
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
      if (hintTimer) clearInterval(hintTimer);
      if (localBackendTimer) clearInterval(localBackendTimer);
      unobserve();
      await gateway.close();
    },
  };
}
