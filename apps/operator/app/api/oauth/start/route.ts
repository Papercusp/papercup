/**
 * GET /api/oauth/start
 *
 * Redirects the browser to the provider's authorize URL with an
 * HMAC-signed state token. State carries (plugin, harness, field,
 * provider) — the callback endpoint reads these from the verified
 * state, NOT from URL params, so a malicious caller can't smuggle a
 * different plugin/harness through.
 *
 * Query: provider, plugin, harness, field
 *   provider: registered OAuth provider id (e.g. 'github')
 *   plugin:   plugin slug whose config receives the token
 *   harness:  harness slug
 *   field:    configSchema field name to populate
 *
 * Spec: /docs/snapshots/oauth-integration#endpoints.
 */

import { NextResponse } from 'next/server';
import { getProvider, loadAndRegisterProvidersFromDisk } from '@/lib/oauth/providers';
import { signState } from '@/lib/oauth/state';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

let providersLoaded = false;
async function ensureProvidersLoaded() {
  if (providersLoaded) return;
  await loadAndRegisterProvidersFromDisk();
  providersLoaded = true;
}

export async function GET(req: Request) {
  await ensureProvidersLoaded();
  const url = new URL(req.url);
  const providerId = url.searchParams.get('provider') ?? '';
  const plugin = url.searchParams.get('plugin') ?? '';
  const harness = url.searchParams.get('harness') ?? '';
  const field = url.searchParams.get('field') ?? '';
  const scopesRaw = url.searchParams.get('scopes') ?? '';

  if (!providerId || !plugin || !harness || !field) {
    return NextResponse.json(
      { ok: false, error: 'provider, plugin, harness, field all required' },
      { status: 400 },
    );
  }

  const provider = getProvider(providerId);
  if (!provider) {
    return NextResponse.json(
      { ok: false, error: `unknown provider "${providerId}"` },
      { status: 404 },
    );
  }

  const scopes = scopesRaw ? scopesRaw.split(',').map((s) => s.trim()).filter(Boolean) : [];
  const providerHost = new URL(provider.config.authorizeUrl).host;

  const state = await signState({
    plugin,
    harness,
    field,
    provider: providerId,
    providerHost,
  });

  const authorizeUrl = provider.buildAuthorizeUrl(scopes, state);
  return NextResponse.redirect(authorizeUrl, { status: 302 });
}
