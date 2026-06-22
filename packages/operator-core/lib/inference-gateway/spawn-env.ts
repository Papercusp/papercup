/**
 * The spawn-env patch that points a bee at the pacing gateway (hive-inference-gateway P-012).
 *
 * Pure + flag-evaluated by the caller (the spawn chokepoint), so the hot spawn path stays sync and
 * this stays trivially testable. When the `INFERENCE_GATEWAY` flag is ON, every bee spawn gets
 * `ANTHROPIC_BASE_URL=http://127.0.0.1:<port>` → the `claude -p` subprocess sends UNAUTHENTICATED
 * to the localhost gateway, which paces + injects the bound account's OAuth. The bee keeps its
 * symlinked `~/.claude` credential (harmlessly ignored — the gateway strips + reinjects auth), so
 * flipping the flag OFF instantly reverts to direct egress with no other change.
 */
import { DEFAULT_GATEWAY_PORT } from './launch';
import { ACCOUNT_HEADER, OWNER_HEADER } from './gateway';
import {
  accountProviderForInteractiveBackend,
  interactiveBackendFromSpawnBackend,
  type SpawnBackendLike,
} from '../backend-feature-capabilities';

export const GATEWAY_BASE_URL_ENV = 'ANTHROPIC_BASE_URL';
/** The papercusp-specific override the in-process anthropic-direct SDK transport reads
 *  (chat-stream.ts `anthropicDirectTransport`), distinct from the standard `ANTHROPIC_BASE_URL`
 *  the `claude` CLI honors. */
export const GATEWAY_SDK_URL_ENV = 'PAPERCUSP_ANTHROPIC_URL';

/** The localhost gateway port (env override → default 8788). */
export function gatewayPort(): number {
  const p = Number(process.env.PAPERCUSP_GATEWAY_PORT);
  return Number.isFinite(p) && p > 0 ? p : DEFAULT_GATEWAY_PORT;
}

/**
 * The env patch to merge into a bee spawn's environment. `{}` when the gateway is disabled
 * (unchanged direct egress); `{ ANTHROPIC_BASE_URL }` when enabled. The caller passes the
 * resolved flag value so flag evaluation (PostHog / FLAG_DEFAULTS) stays at the chokepoint.
 */
export function gatewaySpawnEnv(enabled: boolean, opts: { accountId?: string; ownerId?: string } = {}): Record<string, string> {
  if (!enabled) return {};
  const env: Record<string, string> = { [GATEWAY_BASE_URL_ENV]: `http://127.0.0.1:${gatewayPort()}` };
  // Custom request headers the claude CLI forwards on every call — ANTHROPIC_CUSTOM_HEADERS is parsed as
  // newline-separated `Name: Value` pairs (honored by claude-code 2.x):
  //  • the ACCOUNT pin (multi-credential cache-affinity routing P-004): pin this bee to its assigned pool
  //    account. Set only when the caller resolved an account (multi-account flag on + ≥2 accounts);
  //    otherwise the gateway routes the bee to its active() account — today's behavior.
  //  • the OWNER id (== spawnId, gateway-rate-limit-stall-autowake P-001): so the gateway can attribute a
  //    rate-limit shed back to THIS bee, and the stall-waker can wake it once the account recovers.
  const customHeaders: string[] = [];
  if (opts.accountId) customHeaders.push(`${ACCOUNT_HEADER}: ${opts.accountId}`);
  if (opts.ownerId) customHeaders.push(`${OWNER_HEADER}: ${opts.ownerId}`);
  if (customHeaders.length) env.ANTHROPIC_CUSTOM_HEADERS = customHeaders.join('\n');
  return env;
}

/**
 * The env patch for an IN-PROCESS caller that makes anthropic-direct SDK calls (the gym's
 * judge/proposer `llmCall`, FB-16). The spawn chokepoint only patches SPAWNED subprocesses, so an
 * in-process LLM call never receives `gatewaySpawnEnv`. This returns BOTH the standard
 * `ANTHROPIC_BASE_URL` (for any `claude` CLI subprocess the caller in turn spawns) and the
 * papercusp `PAPERCUSP_ANTHROPIC_URL` (read by `anthropicDirectTransport`) so every egress —
 * subprocess or in-process SDK — routes through the localhost pacing gateway. `{}` when disabled.
 */
export function gatewayLlmEnv(enabled: boolean): Record<string, string> {
  if (!enabled) return {};
  const url = `http://127.0.0.1:${gatewayPort()}`;
  return { [GATEWAY_BASE_URL_ENV]: url, [GATEWAY_SDK_URL_ENV]: url };
}

/**
 * Resolve the COMPLETE gateway+account spawn-env for a spawned agent — the ONE routing decision
 * BOTH spawn chokepoints must apply (the bee path `fleet/operator-spawn.ts` AND the `/invoke`
 * route `endpoint-route/routes/harness/spawn.ts`), so a routing change can't be added to one path
 * only. D-011: the `/invoke` path had DRIFTED and never routed Queen/overwatch/blueprint-run agents
 * through the pool → they egressed on the single shared `~/.claude` OAuth credential and 429'd on
 * its WEEKLY cap (silent 0-token wakes, the Queen placing nothing) while the 8-account pool sat idle.
 *
 * Evaluates the gateway flags (INFERENCE_GATEWAY, +_MULTI_ACCOUNT) and, when multi-account is on,
 * selects an AVAILABLE pool account for the resolved backend provider. Claude composes
 * `gatewaySpawnEnv` (ANTHROPIC_BASE_URL + account/owner routing headers) plus
 * `PAPERCUSP_ACCOUNT_ID` (the per-account governor key). Codex emits only `PAPERCUSP_ACCOUNT_ID`;
 * the per-spawn CODEX_HOME writer consumes it to add a model_provider gateway config. Unsupported
 * backends (currently OMP) get `{}`. Fail-soft: a selection miss → no pin (the gateway routes
 * Claude to its `active()` account); flag OFF → `{}` (unchanged direct egress).
 * Lazy-imports the flag + account-pool deps so this module stays import-light for the pure helpers
 * above (and so a route module importing it picks up no extra registration side-effects).
 */
export async function resolveSpawnGatewayEnv(opts: {
  workspaceId: string | undefined;
  slug: string | undefined;
  ownerId?: string;
  backend?: SpawnBackendLike;
}): Promise<Record<string, string>> {
  const { getFlag } = await import('@papercusp/flags/server');
  const { FLAGS } = await import('@papercusp/flags');
  const gwOn = await getFlag(FLAGS.INFERENCE_GATEWAY, 'system');
  if (!gwOn) return {};
  const backend = interactiveBackendFromSpawnBackend(opts.backend ?? 'claude');
  const provider = accountProviderForInteractiveBackend(backend);
  if (!provider) return {};
  let accountId: string | undefined;
  if (await getFlag(FLAGS.INFERENCE_GATEWAY_MULTI_ACCOUNT, 'system')) {
    const { selectSpawnAccount } = await import('../deployment/account-pool-store');
    accountId = await selectSpawnAccount(opts.workspaceId, opts.slug, undefined, provider).catch(() => undefined);
  }
  if (provider === 'codex') {
    return accountId ? { PAPERCUSP_ACCOUNT_ID: accountId } : {};
  }
  const env = gatewaySpawnEnv(true, { accountId, ownerId: opts.ownerId });
  if (accountId) env.PAPERCUSP_ACCOUNT_ID = accountId;
  return env;
}
