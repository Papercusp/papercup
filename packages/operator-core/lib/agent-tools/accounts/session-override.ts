/**
 * accounts:set-session-override / accounts:get-session-override — the owner's session-now
 * steer over WHICH pool accounts the fleet may spawn/deploy on (accounts-pool-tab-2026-06-15
 * P-004; owner greenlit "allow-list + exclude"). The agent-surface twin of the
 * /api/admin/deploy-accounts/session-override route. Thin wrappers over
 * deployment/account-session-override; hive_settings-backed (no migration), fail-soft,
 * applied BEFORE the headroom/drain selectors.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { COORD_ROLES } from '../coordination/roles';
import { activeWorkspaceId } from '../../workspace-registry';
import { resolveHiveHomeSlug } from '../../hive/wake';
import {
  getAccountSessionOverride,
  setAccountSessionOverride,
  type AccountSessionOverridePatch,
} from '../../deployment/account-session-override';

const json = (o: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(o) }] });

const noHive = () =>
  json({ ok: false, error: 'no_home_harness', message: 'Pass `hive` (or set PAPERCUSP_HIVE_HOME_SLUG) — the override is hive-scoped (whole-fleet).' });

export const accountsSetSessionOverrideTool = defineTool({
  name: 'accounts:set-session-override',
  profile: 'engineer',
  description:
    "Set the owner's session-now account override the fleet honours when picking a pool account to spawn/deploy on (accounts-pool-tab P-004): `forcedAccounts` (allow-list — use ONLY these), `excludeAccounts` (skip these, e.g. a flaky/rate-limited account). Both empty ⇒ no restriction (today's behaviour). Applied as a fail-soft precedence layer BEFORE the headroom/drain selectors; an over-restrictive set falls back to the frame-default credential. `clear:true` wipes both. Returns {ok, override}.",
  guidance: {
    when: 'Steering account selection for the current session — focus the fleet on one account, or route around a flaky/limited one — without removing it from the pool.',
    notWhen: "Permanently removing an account — accounts:remove. Clearing a rate-limit penalty — accounts:reset-rate. Pausing the hive — hive:pause.",
    chaining: 'accounts:set-session-override { excludeAccounts:["acct-b"] } → bees stop spawning on acct-b this session. clear:true resets.',
  },
  capability: 'harness:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    hive: z.string().max(120).optional().describe('Hive home-harness slug (default: ctx harness / PAPERCUSP_HIVE_HOME_SLUG).'),
    workspace: z.string().max(120).optional().describe('Workspace id (default: ctx / active workspace).'),
    forcedAccounts: z.array(z.string().min(1).max(200)).max(200).optional().describe('Allow-list — the fleet may use ONLY these account ids. [] = no restriction.'),
    excludeAccounts: z.array(z.string().min(1).max(200)).max(200).optional().describe('Account ids to skip this session (e.g. a flaky/limited account). [] = skip none.'),
    clear: z.boolean().optional().describe('Wipe both axes back to no-restriction.'),
  }),
  async handler(args, ctx) {
    const ws = args.workspace ?? ctx.workspaceId ?? ctx.principal?.workspaceId ?? activeWorkspaceId();
    const hive = resolveHiveHomeSlug(args.hive, ctx.harnessSlug ?? undefined);
    if (!hive) return noHive();
    const patch: AccountSessionOverridePatch = {};
    if (args.forcedAccounts !== undefined) patch.forcedAccounts = args.forcedAccounts;
    if (args.excludeAccounts !== undefined) patch.excludeAccounts = args.excludeAccounts;
    if (args.clear !== undefined) patch.clear = args.clear;
    try {
      const override = await setAccountSessionOverride(ws, hive, patch);
      // Live UI reflection — the Accounts tab re-reads on a steer.
      void import('../../sync-sse').then(({ notifySyncInvalidate }) => notifySyncInvalidate('accounts.pool', {})).catch(() => {});
      return json({ ok: true, hive, override });
    } catch (e) {
      return json({ ok: false, error: e instanceof Error ? e.message : String(e), hive });
    }
  },
});

export const accountsGetSessionOverrideTool = defineTool({
  name: 'accounts:get-session-override',
  profile: 'engineer',
  description:
    'Read the current owner session-now account override (forcedAccounts allow-list + excludeAccounts) the fleet honours when picking a pool account. An un-steered hive returns both empty (no restriction). The READ twin of accounts:set-session-override. Returns {ok, override}.',
  guidance: {
    when: 'Checking how account selection is currently steered, before changing it.',
    notWhen: 'Per-account rate/status — accounts:status. The whole pool — accounts:list.',
  },
  capability: 'harness:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    hive: z.string().max(120).optional().describe('Hive home-harness slug (default: ctx harness / PAPERCUSP_HIVE_HOME_SLUG).'),
    workspace: z.string().max(120).optional().describe('Workspace id (default: ctx / active workspace).'),
  }),
  async handler(args, ctx) {
    const ws = args.workspace ?? ctx.workspaceId ?? ctx.principal?.workspaceId ?? activeWorkspaceId();
    const hive = resolveHiveHomeSlug(args.hive, ctx.harnessSlug ?? undefined);
    if (!hive) return noHive();
    return json({ ok: true, hive, override: await getAccountSessionOverride(ws, hive) });
  },
});
