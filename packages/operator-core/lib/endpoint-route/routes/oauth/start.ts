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
      return Response.json(
        { ok: false, error: 'provider, plugin, harness, field all required' },
        { status: 400 },
      );
    }
    const provider = getProvider(providerId);
    if (!provider) {
      return Response.json({ ok: false, error: `unknown provider "${providerId}"` }, { status: 404 });
    }

    const scopes = scopesRaw
      ? scopesRaw.split(',').map((s) => s.trim()).filter(Boolean)
      : [];
    const providerHost = new URL(provider.config.authorizeUrl).host;
    const state = await signState({
      plugin,
      harness,
      field,
      provider: providerId,
      providerHost,
    });
    return Response.redirect(provider.buildAuthorizeUrl(scopes, state), 302);
  },
});
