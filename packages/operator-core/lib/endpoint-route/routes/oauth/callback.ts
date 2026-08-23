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
import { ensureGmailRespondDraftBinding } from '../../../external-triggers/gmail-flagship';
import {
  FACEBOOK_PERSONAL_VAULT_OAUTH_PLUGIN,
  assertFacebookPersonalVaultOwnerUserId,
  provisionOwnedFacebookPersonalVaultSource,
} from '../../../external-triggers/facebook';
import { defineTool } from '@papercusp/agent-mcp';

let providersLoaded = false;
async function ensureProvidersLoaded(): Promise<void> {
  if (providersLoaded) return;
  await loadAndRegisterProvidersFromDisk();
  providersLoaded = true;
}

function redirectWith(reqUrl: string, path: string, key: string, value: string): Response {
  const destination = new URL(path, reqUrl);
  destination.searchParams.set(key, value);
  return Response.redirect(destination.toString(), 307);
}

function callbackReturnPath(plugin: string, providerId: string, harness: string): string {
  if (
    (providerId === 'google' && plugin === GOOGLE_WORKSPACE_OAUTH_PLUGIN) ||
    (providerId === 'facebook' && plugin === FACEBOOK_PERSONAL_VAULT_OAUTH_PLUGIN)
  ) {
    return '/settings/personal-vault';
  }
  return '/harness/' + encodeURIComponent(harness) + '?panel=config';
}

function requestedScopes(privateContext: Readonly<Record<string, string>> | undefined): string[] {
  const raw = privateContext?.requestedScopes;
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? [
          ...new Set(
            parsed
              .filter((scope): scope is string => typeof scope === 'string' && Boolean(scope.trim()))
              .map((scope) => scope.trim()),
          ),
        ]
      : [];
  } catch {
    return [];
  }
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
      if (state) {
        const verified = await verifyAndConsumeState(state);
        if (verified.ok && verified.claims) {
          const path = callbackReturnPath(verified.claims.plugin, verified.claims.provider, verified.claims.harness);
          return redirectWith(req.url, path, 'oauth_error', errorParam);
        }
      }
      return redirectWith(req.url, '/harness', 'oauth_error', errorParam);
    }
    if (!code || !state) {
      return Response.json({ ok: false, error: 'code + state required' }, { status: 400 });
    }

    const verified = await verifyAndConsumeState(state);
    if (!verified.ok || !verified.claims) {
      return Response.json({ ok: false, error: `oauth state ${verified.error}` }, { status: 400 });
    }

    const { plugin, harness, field, provider: providerId } = verified.claims;
    const returnPath = callbackReturnPath(plugin, providerId, harness);
    const provider = getProvider(providerId);
    if (!provider) {
      return Response.json({ ok: false, error: `provider ${providerId} not registered` }, { status: 500 });
    }

    const connectsGoogleWorkspace = providerId === 'google' && plugin === GOOGLE_WORKSPACE_OAUTH_PLUGIN;
    const connectsFacebookPersonalVault = providerId === 'facebook' && plugin === FACEBOOK_PERSONAL_VAULT_OAUTH_PLUGIN;
    let googleOwner: { ownerUserId: string; workspaceId: string } | null = null;
    let facebookOwner: { ownerUserId: string; workspaceId: string } | null = null;
    if (connectsGoogleWorkspace) {
      try {
        const ownerUserId = assertGoogleWorkspaceOwnerUserId(verified.privateContext?.ownerUserId);
        const workspaceId = verified.privateContext?.workspaceId?.trim() ?? '';
        if (!workspaceId) throw new Error('google_workspace_workspace_id_required');
        googleOwner = { ownerUserId, workspaceId };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return Response.json({ ok: false, error: message }, { status: 400 });
      }
    }
    if (connectsFacebookPersonalVault) {
      try {
        const ownerUserId = assertFacebookPersonalVaultOwnerUserId(verified.privateContext?.ownerUserId);
        const workspaceId = verified.privateContext?.workspaceId?.trim() ?? '';
        if (!workspaceId) throw new Error('facebook_personal_vault_workspace_id_required');
        facebookOwner = { ownerUserId, workspaceId };
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
      return redirectWith(req.url, returnPath, 'oauth_error', msg);
    }

    const patch: Record<string, unknown> = { [field]: tokens.accessToken };
    if (tokens.refreshToken) patch[`${field}_refresh`] = tokens.refreshToken;
    if (tokens.expiresAt !== undefined) patch[`${field}_expires_at`] = tokens.expiresAt;
    const grantedScopes = tokens.scopes?.length
      ? [...new Set(tokens.scopes.map((scope) => scope.trim()).filter(Boolean))]
      : requestedScopes(verified.privateContext);
    if (grantedScopes.length) patch[`${field}_scopes`] = grantedScopes;
    patch[`${field}_expired`] = false;
    await fsTokenStorage.update(plugin, harness, patch);
    if (googleOwner) {
      try {
        const sources = await provisionOwnedGoogleWorkspaceSources(getOrgPg().sql, {
          workspaceId: googleOwner.workspaceId,
          ownerUserId: googleOwner.ownerUserId,
          field,
          createdBy: `owner:${googleOwner.ownerUserId}`,
        });
        const gmail = sources.find((source) => source.kind === 'gmail');
        if (!gmail) throw new Error('google_workspace_gmail_source_missing');
        await ensureGmailRespondDraftBinding(
          getOrgPg().sql,
          googleOwner.workspaceId,
          gmail,
          `owner:${googleOwner.ownerUserId}`,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return redirectWith(req.url, returnPath, 'oauth_error', message);
      }
    }
    if (facebookOwner) {
      try {
        await provisionOwnedFacebookPersonalVaultSource(getOrgPg().sql, {
          workspaceId: facebookOwner.workspaceId,
          ownerUserId: facebookOwner.ownerUserId,
          field,
          createdBy: `owner:${facebookOwner.ownerUserId}`,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return redirectWith(req.url, returnPath, 'oauth_error', message);
      }
    }

    return redirectWith(req.url, returnPath, 'oauth_connected', plugin);
  },
});
