/**
 * GET /api/oauth/start
 *
 * Redirects the browser to the provider's authorize URL with an
 * HMAC-signed state token (plugin/harness/field/provider — read by the
 * callback from the verified state, never from URL params).
 *
 * Ported from app/api/oauth/start/route.ts. `auth: 'public'` — the
 * caller is an un-authed browser starting an OAuth flow.
 */
import { getProvider, loadAndRegisterProvidersFromDisk } from '../../../oauth/providers';
import { signState } from '../../../oauth/state';
import { getSessionUserOrDefault } from '../../../auth';
import { activeWorkspaceId } from '../../../workspace-registry';
import { GOOGLE_WORKSPACE_OAUTH_PLUGIN } from '../../../external-triggers/google-workspace';
import { defineTool } from '@papercusp/agent-mcp';

let providersLoaded = false;
async function ensureProvidersLoaded(): Promise<void> {
  if (providersLoaded) return;
  await loadAndRegisterProvidersFromDisk();
  providersLoaded = true;
}

export default defineTool({
  method: 'GET',
  path: '/oauth/start',
  auth: 'public',
  async handler(req) {
    await ensureProvidersLoaded();
    const url = new URL(req.url);
    const providerId = url.searchParams.get('provider') ?? '';
    const plugin = url.searchParams.get('plugin') ?? '';
    const harness = url.searchParams.get('harness') ?? '';
    const field = url.searchParams.get('field') ?? '';
    const scopesRaw = url.searchParams.get('scopes') ?? '';

    if (!providerId || !plugin || !harness || !field) {
      return Response.json({ ok: false, error: 'provider, plugin, harness, field all required' }, { status: 400 });
    }
    const connectsGoogleWorkspace =
      providerId === 'google' && plugin === GOOGLE_WORKSPACE_OAUTH_PLUGIN;
    if (plugin === GOOGLE_WORKSPACE_OAUTH_PLUGIN && !connectsGoogleWorkspace) {
      return Response.json(
        { ok: false, error: 'google-workspace plugin requires provider google' },
        { status: 400 },
      );
    }
    const provider = getProvider(providerId);
    if (!provider) {
      return Response.json({ ok: false, error: `unknown provider "${providerId}"` }, { status: 404 });
    }

    const requestedScopes = scopesRaw
      ? scopesRaw
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : [];
    const allowedScopes = provider.allowedScopes ? new Set(provider.allowedScopes) : null;
    const forbiddenScopes = allowedScopes ? requestedScopes.filter((scope) => !allowedScopes.has(scope)) : [];
    if (forbiddenScopes.length > 0) {
      return Response.json(
        { ok: false, error: `provider ${providerId} does not allow scope(s): ${forbiddenScopes.join(', ')}` },
        { status: 400 },
      );
    }
    // The reserved Workspace connection backs Gmail, Calendar, and Contacts as
    // one consent. A caller-supplied subset must not create source rows that look
    // connected but cannot actually read one of those provider surfaces.
    const scopes = connectsGoogleWorkspace
      ? [...(provider.defaultScopes ?? [])]
      : requestedScopes.length > 0
        ? requestedScopes
        : [...(provider.defaultScopes ?? [])];
    if (connectsGoogleWorkspace && scopes.length === 0) {
      return Response.json(
        { ok: false, error: 'google-workspace provider has no default scopes' },
        { status: 500 },
      );
    }
    const providerHost = new URL(provider.config.authorizeUrl).host;
    let privateContext = { ...((await provider.createFlowContext?.()) ?? {}) };
    if (connectsGoogleWorkspace) {
      const owner = await getSessionUserOrDefault(req.headers);
      privateContext = {
        ...privateContext,
        ownerUserId: owner.id,
        workspaceId: activeWorkspaceId(),
      };
    }
    const state = await signState(
      {
        plugin,
        harness,
        field,
        provider: providerId,
        providerHost,
      },
      { privateContext },
    );
    return Response.redirect(provider.buildAuthorizeUrl(scopes, state, privateContext), 302);
  },
});
