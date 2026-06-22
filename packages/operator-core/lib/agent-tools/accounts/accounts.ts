/**
 * accounts:* — manage the Queen's pool of provider accounts + inspect each account's
 * rate-limit headroom, and manually trigger a scale-out (`cloud-deployment-layer-2026-06-06`
 * Phase 7, P-019/P-020/P-021). Thin MCP surface over `lib/deployment/account-pool*`.
 *
 * A Claude account = one Claude subscription (its own rate limits). Deploy-time selection
 * (deploy:harness / deploy:hive) binds the most-available account per Swarm; sustained
 * limiting on a bound account auto-scales out onto a fresh one. These tools register
 * the pool, read its state, and give the owner a manual scale-out lever.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { COORD_ROLES } from '../coordination/roles';
import { activeWorkspaceId } from '../../workspace-registry';

const ok = (payload: Record<string, unknown>) => ({
  content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, ...payload }) }],
});
const fail = (payload: Record<string, unknown>) => ({
  content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, ...payload }) }],
});

const wsArg = z.string().min(1).optional().describe('Workspace id (defaults to the active workspace)');

export default defineTool({
  name: 'accounts:register',
  description:
    "Register (or update) a provider account in the pool. `provider:'claude'` (default) uses a Claude Max OAuth credential: `token:<path>` (`claude setup-token`) | `file:<path>` / absolute / `~` (`.credentials.json`). `provider:'codex'` uses a bearer credential for the Codex/OpenAI-compatible gateway: `token:<path>` or `env:NAME`. Credential refs are references, never the secret. Optional `egress` pins the account to its own outbound IP. Re-registering an existing id updates credentialRef/provider/label/egress, preserving bindings + rate state. Returns {ok, account}.",
  guidance: {
    when: 'Adding a Claude Max subscription the Queen can pool (each subscription has its own 5h/7d rolling budget — more accounts = more aggregate budget). Register ≥2 before flipping papercusp-inference-gateway-multi-account.',
    notWhen: 'Setting the operator API key (operator:credentials). A one-off local run (no deploy).',
    chaining: 'accounts:register (×N Max subs) → flip papercusp-inference-gateway-multi-account → bees route by cache-affinity + 5h-budget drain; deploy:hive binds an account per member.',
  },
  capability: 'harness:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    id: z.string().min(1).describe('Stable account id (A-Za-z0-9 . _ - only; becomes part of the rate-bucket key)'),
    provider: z.enum(['claude', 'codex']).optional().describe("Provider for this account. Defaults to 'claude'."),
    credentialRef: z.string().min(1).describe('Credential reference. Claude: token:<path> | file:<path> | absolute/~ .credentials.json. Codex: token:<path> or env:NAME bearer credential.'),
    label: z.string().min(1).optional().describe('Optional human label'),
    egress: z
      .object({
        proxyUrl: z.string().min(1).optional().describe('http(s)/socks proxy URL to route THIS account upstream through (its own IP)'),
        localAddress: z.string().min(1).optional().describe('local source IP to bind this account upstream socket to'),
      })
      .optional()
      .describe('Per-account egress for per-account IP routing (optional; default = shared egress). Owner-provisioned.'),
    workspace: wsArg,
  }),
  async handler(args) {
    const { loadAccountPool, saveAccountPool } = await import('../../deployment/account-pool-store');
    const { registerAccount, getAccount } = await import('../../deployment/account-pool');
    const ws = args.workspace ?? activeWorkspaceId();
    try {
      const pool = await loadAccountPool(ws);
      const next = registerAccount(pool, { id: args.id, provider: args.provider, credentialRef: args.credentialRef, label: args.label, egress: args.egress }, Date.now());
      await saveAccountPool(next, ws);
      return ok({ account: getAccount(next, args.id) });
    } catch (e) {
      return fail({ error: (e instanceof Error ? e.message : String(e)).slice(0, 400) });
    }
  },
});

export const accountsListTool = defineTool({
  name: 'accounts:list',
  description:
    "List the Queen's account pool: each account's id/label/credentialRef, the member harness slugs bound to it, and its rate-limit projection (pausedUntil / penaltyCount). Returns {ok, accounts}.",
  guidance: {
    when: 'Seeing which accounts the Queen can draw from and what each is bound to.',
    notWhen: 'Wanting live headroom + sustained-limit flags — accounts:status.',
  },
  capability: 'harness:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({ workspace: wsArg }),
  async handler(args) {
    const { loadAccountPool } = await import('../../deployment/account-pool-store');
    const ws = args.workspace ?? activeWorkspaceId();
    const pool = await loadAccountPool(ws);
    return ok({ accounts: pool.accounts });
  },
});

export const accountsRemoveTool = defineTool({
  name: 'accounts:remove',
  description: "Remove a Claude account from the pool. Does NOT tear down anything already deployed on it. Returns {ok, removed}.",
  guidance: {
    when: 'Retiring an account from the pool (e.g. a subscription you no longer use).',
    notWhen: 'Tearing down a deployed frame — deploy:teardown / deploy:teardown_hive.',
  },
  capability: 'harness:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({ id: z.string().min(1).describe('Account id to remove'), workspace: wsArg }),
  async handler(args) {
    const { loadAccountPool, saveAccountPool } = await import('../../deployment/account-pool-store');
    const { removeAccount, getAccount } = await import('../../deployment/account-pool');
    const ws = args.workspace ?? activeWorkspaceId();
    const pool = await loadAccountPool(ws);
    const existed = !!getAccount(pool, args.id);
    await saveAccountPool(removeAccount(pool, args.id), ws);
    return ok({ removed: existed, id: args.id });
  },
});

export const accountsStatusTool = defineTool({
  name: 'accounts:status',
  description:
    "Per-account rate-limit status: availability (not currently paused), the sustained-limit flag (the scale-out trigger), the rate projection, and any LIVE local governor buckets keyed to the account. Returns {ok, accounts}.",
  guidance: {
    when: 'Checking which accounts have headroom before a deploy, or why an account auto-scaled out.',
  },
  capability: 'harness:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({ workspace: wsArg }),
  async handler(args) {
    const { accountStatus } = await import('../../deployment/account-pool-store');
    const ws = args.workspace ?? activeWorkspaceId();
    const accounts = await accountStatus(ws);
    return ok({ accounts });
  },
});

export const accountsResetRateTool = defineTool({
  name: 'accounts:reset-rate',
  description:
    "Clear an account's rate-limit penalty state — its pause (pausedUntil), penalty count, and the rolling penalty window — back to fresh (accounts-pool-tab P-004; wraps the recordAccountReset projection reset). The owner's manual override for when an account's PROJECTED pause is stale (e.g. the 5h window actually reset, or a false-exhaustion). Does NOT touch live governor buckets (those self-expire) or the credential. Returns {ok, account}.",
  guidance: {
    when: "Clearing a pool account's projected pause/penalty after a confirmed reset — the Accounts tab's per-account Reset button, or unsticking an account the drain selector is avoiding on a stale projection.",
    notWhen: 'Moving work off an exhausted account NOW — accounts:scale_out. Inspecting state — accounts:status.',
  },
  capability: 'harness:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({ id: z.string().min(1).describe('Account id to reset'), workspace: wsArg }),
  async handler(args) {
    const { loadAccountPool, saveAccountPool } = await import('../../deployment/account-pool-store');
    const { recordAccountReset, getAccount } = await import('../../deployment/account-pool');
    const ws = args.workspace ?? activeWorkspaceId();
    const pool = await loadAccountPool(ws);
    if (!getAccount(pool, args.id)) return fail({ error: 'unknown_account', id: args.id });
    const next = recordAccountReset(pool, args.id);
    await saveAccountPool(next, ws);
    // Live UI reflection — the Accounts tab reads accounts.pool.
    void import('../../sync-sse')
      .then(({ notifySyncInvalidate }) => notifySyncInvalidate('accounts.pool', {}))
      .catch(() => {});
    return ok({ account: getAccount(next, args.id) });
  },
});

export const accountsScaleOutTool = defineTool({
  name: 'accounts:scale_out',
  description:
    "Manually scale out off an exhausted account (P-021): provision a FRESH cloud Swarm on the most-available account for the exhausted account's bound members, instead of waiting on the pause. ⚠ Provisions real machines (costs money) — owner-gated. `force` skips the sustained-limit check. Returns {ok, result}.",
  guidance: {
    when: "An account is rate-limited and you want to move its work onto a fresh account NOW (the same action the auto-scale-out takes; this is the manual lever).",
    notWhen: 'Just inspecting state — accounts:status. No fresh account is available (it will report no-fresh-account).',
  },
  capability: 'harness:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    id: z.string().min(1).describe('The exhausted account id to scale out from'),
    force: z.boolean().optional().describe('Skip the sustained-limit check (default false)'),
    workspace: wsArg,
  }),
  async handler(args) {
    const { handleAccountExhausted, defaultScaleOutDeps } = await import('../../deployment/account-pool-store');
    const ws = args.workspace ?? activeWorkspaceId();
    try {
      const result = await handleAccountExhausted(args.id, ws, defaultScaleOutDeps((lvl, m) => console.log(`[${lvl}] ${m}`)), {
        requireSustained: !args.force,
      });
      return ok({ result });
    } catch (e) {
      return fail({ error: (e instanceof Error ? e.message : String(e)).slice(0, 400) });
    }
  },
});
