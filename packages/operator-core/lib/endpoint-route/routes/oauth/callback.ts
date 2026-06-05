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
      return Response.json(
        { ok: false, error: `provider ${providerId} not registered` },
        { status: 500 },
      );
    }

    let tokens;
    try {
      tokens = await provider.exchangeCode(code);
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

    return Response.redirect(
      new URL(
        `/harness/${encodeURIComponent(harness)}?panel=config&oauth_connected=${encodeURIComponent(plugin)}`,
        req.url,
      ).toString(),
      307,
    );
  },
});
