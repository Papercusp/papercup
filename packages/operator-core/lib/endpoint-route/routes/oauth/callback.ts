/**
 * GET /api/oauth/callback
 *
 * Provider redirects here with code + state. State is HMAC-verified +
 * nonce-consumed; on success the code is exchanged and the token
 * persisted to the plugin's per-harness config. plugin/harness/field
 * come from the verified state, never the URL.
 *
 * Ported from app/api/oauth/callback/route.ts. `auth: 'public'` — the
 * caller is the OAuth provider's redirect.
 */
import { getProvider, loadAndRegisterProvidersFromDisk } from '../../../oauth/providers';
import { verifyAndConsumeState } from '../../../oauth/state';
import { fsTokenStorage } from '../../../oauth/storage-fs';
import { getOrgPg } from '@papercusp/db-org';
import {
  GOOGLE_WORKSPACE_OAUTH_PLUGIN,
  assertGoogleWorkspaceOwnerUserId,
  provisionOwnedGoogleWorkspaceSources,
} from '../../../external-triggers/google-workspace';
import { defineTool } from '@papercusp/agent-mcp';

let providersLoaded = false;
async function ensureProvidersLoaded(): Promise<void> {
  if (providersLoaded) return;
  await loadAndRegisterProvidersFromDisk();
  providersLoaded = true;
}

export default defineTool({
  method: 'GET',
  path: '/oauth/callback',
  auth: 'public',
  async handler(req) {
    await ensureProvidersLoaded();
    const url = new URL(req.url);
    const code = url.searchParams.get('code') ?? '';
    const state = url.searchParams.get('state') ?? '';
    const errorParam = url.searchParams.get('error');

    if (errorParam) {
      return Response.redirect(
        new URL(`/harness?oauth_error=${encodeURIComponent(errorParam)}`, req.url).toString(),
        307,
      );
    }
    if (!code || !state) {
      return Response.json({ ok: false, error: 'code + state required' }, { status: 400 });
    }

    const verified = await verifyAndConsumeState(state);
    if (!verified.ok || !verified.claims) {
      return Response.json({ ok: false, error: `oauth state ${verified.error}` }, { status: 400 });
    }

    const { plugin, harness, field, provider: providerId } = verified.claims;
    const provider = getProvider(providerId);
    if (!provider) {
      return Response.json({ ok: false, error: `provider ${providerId} not registered` }, { status: 500 });
    }

    const connectsGoogleWorkspace =
      providerId === 'google' && plugin === GOOGLE_WORKSPACE_OAUTH_PLUGIN;
    let googleOwner: { ownerUserId: string; workspaceId: string } | null = null;
    if (connectsGoogleWorkspace) {
      try {
        const ownerUserId = assertGoogleWorkspaceOwnerUserId(
          verified.privateContext?.ownerUserId,
        );
        const workspaceId = verified.privateContext?.workspaceId?.trim() ?? '';
        if (!workspaceId) throw new Error('google_workspace_workspace_id_required');
        googleOwner = { ownerUserId, workspaceId };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return Response.json({ ok: false, error: message }, { status: 400 });
      }
    }

    let tokens;
    try {
      tokens = await provider.exchangeCode(code, verified.privateContext);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return Response.redirect(
        new URL(
          `/harness/${encodeURIComponent(harness)}?panel=config&oauth_error=${encodeURIComponent(msg)}`,
          req.url,
        ).toString(),
        307,
      );
    }

    const patch: Record<string, unknown> = { [field]: tokens.accessToken };
    if (tokens.refreshToken) patch[`${field}_refresh`] = tokens.refreshToken;
    if (tokens.expiresAt !== undefined) patch[`${field}_expires_at`] = tokens.expiresAt;
    patch[`${field}_expired`] = false;
    await fsTokenStorage.update(plugin, harness, patch);
    if (googleOwner) {
      try {
        await provisionOwnedGoogleWorkspaceSources(getOrgPg().sql, {
          workspaceId: googleOwner.workspaceId,
          ownerUserId: googleOwner.ownerUserId,
          field,
          createdBy: `owner:${googleOwner.ownerUserId}`,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return Response.redirect(
          new URL(
            `/harness/${encodeURIComponent(harness)}?panel=config&oauth_error=${encodeURIComponent(message)}`,
            req.url,
          ).toString(),
          307,
        );
      }
    }

    return Response.redirect(
      new URL(
        `/harness/${encodeURIComponent(harness)}?panel=config&oauth_connected=${encodeURIComponent(plugin)}`,
        req.url,
      ).toString(),
      307,
    );
  },
});
