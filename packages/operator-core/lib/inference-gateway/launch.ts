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
import { resolveBoundAccount, type ResolvedAccount } from './account-resolver';
import { makeCredentialResolver, type CredentialResolver } from './credential-store';
import { createInferenceGateway, type InferenceGateway } from './gateway';

/** Default localhost port for the gateway (not one of the dev stack's ports). */
export const DEFAULT_GATEWAY_PORT = 8788;

export interface GatewayServiceOptions {
  port?: number;
  workspace?: string;
  concurrency?: number;
  upstreamBase?: string;
  /** Proactively refresh the bound token on this interval (ms). 0 = on-demand only. Default 45 min. */
  refreshIntervalMs?: number;
  log?: (level: 'info' | 'warn' | 'error', msg: string) => void;
  // ── injectable for tests ──
  resolveAccount?: (ws?: string) => Promise<ResolvedAccount>;
  makeResolver?: (credentialRef: string, accountId: string) => CredentialResolver;
  /** Subscribe the account-pool projection feed; returns an unsubscribe. Default: initAccountScaleObserver (record-only). */
  observePool?: (accountId: string, ws: string | undefined, log: GatewayServiceOptions['log']) => () => void;
  fetchImpl?: typeof fetch;
}

export interface RunningGatewayService {
  gateway: InferenceGateway;
  port: number;
  account: ResolvedAccount;
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

export async function startGatewayService(opts: GatewayServiceOptions = {}): Promise<RunningGatewayService> {
  const log = opts.log ?? ((lvl, m) => console.log(`[inference-gateway:${lvl}] ${m}`));
  const resolveAccount = opts.resolveAccount ?? resolveBoundAccount;
  const makeResolver = opts.makeResolver ?? makeCredentialResolver;
  const observePool = opts.observePool ?? defaultObservePool;

  const account = await resolveAccount(opts.workspace);
  log('info', `bound account '${account.accountId}' via ${account.source} (channel ${account.credentialRef.split(':')[0]})`);
  const resolver = makeResolver(account.credentialRef, account.accountId);
  const unobserve = observePool(account.accountId, opts.workspace, log);

  const gateway = createInferenceGateway({
    accountId: account.accountId,
    token: () => resolver.current(),
    invalidateToken: () => resolver.invalidate(),
    upstreamBase: opts.upstreamBase,
    concurrency: opts.concurrency,
    fetchImpl: opts.fetchImpl,
    log,
  });

  const port = await gateway.listen(opts.port ?? DEFAULT_GATEWAY_PORT);

  // Own token refresh: warm it now (fail fast on a bad credential) + a proactive timer so an idle
  // gateway never serves the first post-idle request with an expired token.
  await resolver.current().catch((e) => log('warn', `initial token resolve failed: ${(e as Error).message}`));
  const refreshMs = opts.refreshIntervalMs ?? 45 * 60 * 1000;
  let timer: ReturnType<typeof setInterval> | undefined;
  if (refreshMs > 0 && resolver.kind === 'file') {
    timer = setInterval(() => {
      resolver.invalidate();
      void resolver.current().catch((e) => log('warn', `proactive refresh failed: ${(e as Error).message}`));
    }, refreshMs);
    timer.unref?.();
  }

  return {
    gateway,
    port,
    account,
    async stop() {
      if (timer) clearInterval(timer);
      unobserve();
      await gateway.close();
    },
  };
}
