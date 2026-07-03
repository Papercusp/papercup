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
import { ACCOUNT_HEADER, ACCOUNT_PIN_HEADER, OWNER_HEADER, PRIORITY_HEADER } from './gateway';
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
export function gatewaySpawnEnv(
  enabled: boolean,
  opts: { accountId?: string; ownerId?: string; priority?: string; hardPin?: boolean } = {},
): Record<string, string> {
  if (!enabled) return {};
  const env: Record<string, string> = { [GATEWAY_BASE_URL_ENV]: `http://127.0.0.1:${gatewayPort()}` };
  // Custom request headers the claude CLI forwards on every call — ANTHROPIC_CUSTOM_HEADERS is parsed as
  // newline-separated `Name: Value` pairs (honored by claude-code 2.x):
  //  • the ACCOUNT pin (multi-credential cache-affinity routing P-004): pin this bee to its assigned pool
  //    account. Set only when the caller resolved an account (multi-account flag on + ≥2 accounts);
  //    otherwise the gateway routes the bee to its active() account — today's behavior.
  //  • the OWNER id (== spawnId, gateway-rate-limit-stall-autowake P-001): so the gateway can attribute a
  //    rate-limit shed back to THIS bee, and the stall-waker can wake it once the account recovers.
  //  • the PRIORITY label (gateway-priority-tiers-2026-06-22): the spawn role (queen/scout/su/bee/…) the
  //    gateway maps → an admission TIER. Set only when the caller resolved one (the tier flag is ON);
  //    absent under flag-OFF, so the bee's request stream is byte-identical to today.
  //  • the HARD-PIN marker (account-hard-pin-2026-06-29): only set by the operator/PSU pin path
  //    (resolveAccountPin), NEVER by bee spawns — it tells the gateway to route to `accountId` with NO
  //    failover (the operator explicitly chose this credential). Meaningful only alongside an accountId.
  const customHeaders: string[] = [];
  if (opts.accountId) customHeaders.push(`${ACCOUNT_HEADER}: ${opts.accountId}`);
  if (opts.accountId && opts.hardPin) customHeaders.push(`${ACCOUNT_PIN_HEADER}: hard`);
  if (opts.ownerId) customHeaders.push(`${OWNER_HEADER}: ${opts.ownerId}`);
  if (opts.priority) customHeaders.push(`${PRIORITY_HEADER}: ${opts.priority}`);
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
  /** The spawn ROLE (queen/scout/overwatch/su/bee/worker/…) → mapped to an admission TIER by the gateway
   *  when `GATEWAY_PRIORITY_TIERS` is ON. Omit for an untiered caller. */
  role?: string;
  /** The role's resolved model SPEC (e.g. `anthropic/claude-opus-4-8:high`). For an omp spawn that
   *  gateway-routes to a Claude account, the bare Claude id is exposed + selected via the per-session
   *  models.yml (P-005/WI-951 per-role fidelity); a non-claude/local spec falls back to the wire default. */
  model?: string;
  /** Explicit per-spawn account-routing override (account-routing-3-options, 2026-06-30) — the
   *  bee:spawn `account` arg. Mirrors the interactive psu path (resolveAccountPin):
   *   • 'default' | 'none' | 'system' → skip the gateway entirely (direct egress, system credential).
   *   • 'auto' | 'gateway'            → gateway auto-route (active()/drain-select + failover, NO pin).
   *   • '<pool-id>'                   → HARD pin to that account via the gateway (no failover) — trusts
   *                                      the id like the PAPERCUSP_SPAWN_ACCOUNT_PIN env path.
   *  Omitted/'' → today's behavior (env pin → multi-account select → gateway active()). */
  account?: string | null;
}): Promise<Record<string, string>> {
  const { getFlag } = await import('@papercusp/flags/server');
  const { FLAGS } = await import('@papercusp/flags');
  const gwOn = await getFlag(FLAGS.INFERENCE_GATEWAY, 'system');
  if (!gwOn) return {};
  // account-routing-3-options: an explicit `account` override picks the routing MODE up-front.
  // 'default'/'none'/'system' skips the gateway entirely (the operator's "use the system credential"
  // escape hatch) — return before any pool work.
  const acctOverride = (opts.account ?? '').trim();
  const acctMode = acctOverride.toLowerCase();
  if (acctMode === 'default' || acctMode === 'none' || acctMode === 'system') return {};
  const wantAuto = acctMode === 'auto' || acctMode === 'gateway';
  const explicitPin = acctOverride && !wantAuto ? acctOverride : undefined;
  const backend = interactiveBackendFromSpawnBackend(opts.backend ?? 'claude');
  const provider = accountProviderForInteractiveBackend(backend);
  if (!provider) return {};
  let accountId: string | undefined;
  let hardPin = false;
  if (explicitPin) {
    // Operator-chosen specific account → HARD pin via the gateway (no failover). Trusts the id, the
    // same as the PAPERCUSP_SPAWN_ACCOUNT_PIN env path below (no extra pool validation).
    accountId = explicitPin;
    hardPin = true;
  } else if (wantAuto) {
    // Explicit AUTO: leave accountId unset so the gateway active()/drain-selects + fails over (no pin
    // header) — the gateway "does the auto-routing" the owner asked for, independent of MULTI_ACCOUNT.
    accountId = undefined;
  } else {
    // Owner-directed dedicated-account pin (2026-06-23): when PAPERCUSP_SPAWN_ACCOUNT_PIN names a
    // pool account, force it for the matching hive's spawns — so the queen→bee→scout→overwatch
    // autonomous loop can be verified in a lane isolated from the shared-pool stall storm (the
    // pinned account then carries only that hive's light load, not the whole fleet's). Scope with
    // PAPERCUSP_SPAWN_ACCOUNT_PIN_SLUG (one install slug; pins ALL slugs when unset). This is
    // operational ROUTING config (peer of ANTHROPIC_BASE_URL / PAPERCUSP_GATEWAY_PORT), NOT a
    // feature toggle — reversible by unsetting the env, and a no-op everywhere the env is absent.
    // Tradeoff: a pinned spawn does NOT fail over (it can only use the pinned account), so pin only
    // a LIGHT, isolated workload — never the whole fleet.
    const pinAccount = process.env.PAPERCUSP_SPAWN_ACCOUNT_PIN?.trim();
    const pinSlug = process.env.PAPERCUSP_SPAWN_ACCOUNT_PIN_SLUG?.trim();
    if (pinAccount && (!pinSlug || pinSlug === opts.slug)) {
      accountId = pinAccount;
    } else if (await getFlag(FLAGS.INFERENCE_GATEWAY_MULTI_ACCOUNT, 'system')) {
      const { selectSpawnAccount } = await import('../deployment/account-pool-store');
      accountId = await selectSpawnAccount(opts.workspaceId, opts.slug, undefined, provider).catch(() => undefined);
    }
  }
  if (backend === 'omp') {
    // OMP routes via a per-session models.yml (P-005 connect / P-006 fleet): the gateway
    // provider override is delivered through the omp child's HOME, NOT via ANTHROPIC_BASE_URL/
    // ANTHROPIC_CUSTOM_HEADERS (claude-CLI-specific) nor a CODEX_HOME. Emit the account-pin
    // signal PLUS the models.yml bytes + the model selector the per-spawn agent-home seeder
    // (connect: profile-writer; fleet: orchestrator invoke.ts) writes into
    // <home>/.omp/agent/models.yml and force-selects via `--model`. A bare PAPERCUSP_ACCOUNT_ID
    // (no models.yml) keeps a pinned-but-unseeded session fail-soft on direct egress.
    // (omp-account-pinning-gateway-2026-06-29 D-001/D-003/D-006/D-008)
    if (!accountId) return {};
    const env: Record<string, string> = { PAPERCUSP_ACCOUNT_ID: accountId };
    // Same priority-TIER resolution as the claude path below (role → admission tier, flag-gated).
    const ompPriority =
      opts.role && (await getFlag(FLAGS.GATEWAY_PRIORITY_TIERS, 'system'))
        ? opts.role.trim() || undefined
        : undefined;
    // Lazy import: omp-models-config imports gatewayPort from THIS module, so a top-level import
    // would be a mutual cycle — defer it to the call site (the helpers above stay import-light).
    const { ompGatewayModelsConfig, ompProviderForAccountProvider, ompModelIdFromSpec } = await import('./omp-models-config');
    // P-005/WI-951 per-role fidelity: expose + select the ROLE's actual Claude model (from its
    // resolved spec) instead of the wire default, when the spawn gateway-routes to a Claude account.
    const roleModelId = ompModelIdFromSpec(opts.model);
    const cfg = ompGatewayModelsConfig({
      accountId,
      provider: ompProviderForAccountProvider(provider),
      ownerId: opts.ownerId,
      priority: ompPriority,
      models: roleModelId ? [roleModelId] : undefined,
    });
    if (cfg) {
      env.PAPERCUSP_OMP_MODELS_YML = cfg.content;
      env.PAPERCUSP_OMP_MODEL_SELECTOR = cfg.modelSelector;
    }
    return env;
  }
  if (provider === 'codex') {
    if (!accountId) return {};
    try {
      const [{ loadAccountPool }, { credentialRefSupportsOpenAiBearer }] = await Promise.all([
        import('../deployment/account-pool-store'),
        import('./credential-store'),
      ]);
      const { parseCodexCliRef } = await import('./codex-cli-bridge');
      const pool = await loadAccountPool(opts.workspaceId);
      const acct = pool.accounts.find((a) => a.id === accountId && a.provider === 'codex');
      if (!acct) return {};
      if (!parseCodexCliRef(acct.credentialRef) && !(await credentialRefSupportsOpenAiBearer(acct.credentialRef))) return {};
    } catch {
      return {};
    }
    return { PAPERCUSP_ACCOUNT_ID: accountId };
  }
  // Priority-TIER header (gateway-priority-tiers-2026-06-22): stamp the role only when the tier flag is ON,
  // so flag-OFF emits NO new header (the bee's request stream stays byte-identical to today). The gateway
  // maps role → tier via GATEWAY_PRIORITY_MAP; an unknown role falls back to the default band there.
  const priority = opts.role && (await getFlag(FLAGS.GATEWAY_PRIORITY_TIERS, 'system')) ? opts.role.trim() || undefined : undefined;
  // hardPin only when the operator named a specific account (explicitPin) — a HARD pin tells the
  // gateway to route to it with NO failover; auto/env-pin/multi-account selection stay soft (yield to
  // liveness/load), unchanged from before.
  const env = gatewaySpawnEnv(true, { accountId, ownerId: opts.ownerId, priority, hardPin });
  if (accountId) env.PAPERCUSP_ACCOUNT_ID = accountId;
  return env;
}
