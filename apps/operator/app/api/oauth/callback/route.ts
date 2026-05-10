/**
 * GET /api/oauth/callback
 *
 * Provider redirects here with `code` + `state`. The state token is
 * HMAC-verified + nonce-consumed; if valid, we exchange the code for a
 * token and persist it to the plugin's per-harness config.
 *
 * Trust: this route never reads `plugin`/`harness`/`field` from URL —
 * those come from the verified state claims. A leaked code with a
 * tampered URL cannot route the token to a different plugin.
 *
 * Spec: /docs/snapshots/oauth-integration#endpoints.
 */

import { NextResponse } from 'next/server';
import { getProvider, loadAndRegisterProvidersFromDisk } from '@/lib/oauth/providers';
import { verifyAndConsumeState } from '@/lib/oauth/state';
import { fsTokenStorage } from '@/lib/oauth/storage-fs';

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
  const code = url.searchParams.get('code') ?? '';
  const state = url.searchParams.get('state') ?? '';
  const errorParam = url.searchParams.get('error');

  if (errorParam) {
    return NextResponse.redirect(
      new URL(`/harness?oauth_error=${encodeURIComponent(errorParam)}`, req.url),
    );
  }

  if (!code || !state) {
    return NextResponse.json({ ok: false, error: 'code + state required' }, { status: 400 });
  }

  const verified = await verifyAndConsumeState(state);
  if (!verified.ok || !verified.claims) {
    return NextResponse.json(
      { ok: false, error: `oauth state ${verified.error}` },
      { status: 400 },
    );
  }

  const { plugin, harness, field, provider: providerId } = verified.claims;
  const provider = getProvider(providerId);
  if (!provider) {
    return NextResponse.json(
      { ok: false, error: `provider ${providerId} not registered` },
      { status: 500 },
    );
  }

  let tokens;
  try {
    tokens = await provider.exchangeCode(code);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.redirect(
      new URL(`/harness/${encodeURIComponent(harness)}?panel=config&oauth_error=${encodeURIComponent(msg)}`, req.url),
    );
  }

  const patch: Record<string, unknown> = { [field]: tokens.accessToken };
  if (tokens.refreshToken) patch[`${field}_refresh`] = tokens.refreshToken;
  if (tokens.expiresAt !== undefined) patch[`${field}_expires_at`] = tokens.expiresAt;
  patch[`${field}_expired`] = false;

  await fsTokenStorage.update(plugin, harness, patch);

  return NextResponse.redirect(
    new URL(`/harness/${encodeURIComponent(harness)}?panel=config&oauth_connected=${encodeURIComponent(plugin)}`, req.url),
  );
}
