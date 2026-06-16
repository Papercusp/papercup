/**
 * GET/POST /api/admin/deploy-accounts/session-override — the owner's session-now account
 * override (accounts-pool-tab-2026-06-15 P-004): which pool accounts the fleet may
 * spawn/deploy on. GET reads { forcedAccounts, excludeAccounts }; POST writes
 * { forcedAccounts?, excludeAccounts?, clear? }. hive_settings-backed (no migration),
 * fail-soft, applied BEFORE the headroom/drain selectors. The Accounts tab's override UI.
 */
import {
  getAccountSessionOverride,
  setAccountSessionOverride,
  type AccountSessionOverridePatch,
} from '../../../deployment/account-session-override';
import { resolveHiveHomeSlug } from '../../../hive/wake';
import { activeWorkspaceId } from '../../../workspace-registry';
import { notifySyncInvalidate } from '../../../sync-sse';
import { requireAllowedOriginOr403 } from '../../cors';
import { defineTool } from '@papercusp/agent-mcp';

const VTL = { trust: ['verified', 'trusted', 'unverified-loopback'] } as const;
const noHive = () => Response.json({ ok: false, error: 'no_home_harness' }, { status: 400 });

const getRoute = defineTool({
  method: 'GET',
  path: '/admin/deploy-accounts/session-override',
  // unverified-loopback: cookie-less desktop webview (EI-338) — mirrors /register, /reset-rate.
  auth: VTL,
  async handler() {
    const hive = resolveHiveHomeSlug(undefined);
    if (!hive) return noHive();
    return Response.json({ ok: true, override: await getAccountSessionOverride(activeWorkspaceId(), hive) });
  },
});

const postRoute = defineTool({
  method: 'POST',
  path: '/admin/deploy-accounts/session-override',
  auth: VTL,
  async handler(req) {
    const csrf = requireAllowedOriginOr403(req);
    if (csrf) return csrf;
    let body: { forcedAccounts?: unknown; excludeAccounts?: unknown; clear?: unknown };
    try {
      body = await req.json();
    } catch {
      return Response.json({ ok: false, error: 'invalid JSON body' }, { status: 400 });
    }
    const hive = resolveHiveHomeSlug(undefined);
    if (!hive) return noHive();
    const patch: AccountSessionOverridePatch = {};
    if (Array.isArray(body?.forcedAccounts)) patch.forcedAccounts = body.forcedAccounts.filter((x): x is string => typeof x === 'string');
    if (Array.isArray(body?.excludeAccounts)) patch.excludeAccounts = body.excludeAccounts.filter((x): x is string => typeof x === 'string');
    if (typeof body?.clear === 'boolean') patch.clear = body.clear;
    try {
      const override = await setAccountSessionOverride(activeWorkspaceId(), hive, patch);
      void notifySyncInvalidate('accounts.pool', {}).catch(() => {});
      return Response.json({ ok: true, override });
    } catch (e) {
      return Response.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
    }
  },
});

export default [getRoute, postRoute];
