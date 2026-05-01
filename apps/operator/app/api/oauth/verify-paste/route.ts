/**
 * POST /api/oauth/verify-paste
 *
 * Hybrid mode: user pastes a PAT instead of clicking Connect. The
 * substrate hits the provider's introspection endpoint to verify the
 * token's actual granted scopes match the plugin's required scopes.
 *
 * Body: { provider, plugin, harness, field, token, requiredScopes? }
 * Returns: { ok, outcome: 'exact'|'superset'|'subset', extra?, missing?, scopes }
 *
 * Behavior per scope-verification table:
 *   - exact   → accept silently, write to config
 *   - superset → accept with warning toast, write to config
 *   - subset   → REJECT, do NOT write
 *
 * Spec: /docs/snapshots/oauth-integration#paste-pat-scope-verification.
 */

import { NextResponse } from 'next/server';
import {
  compareScopes,
  getProvider,
  loadAndRegisterProvidersFromDisk,
} from '@/lib/oauth/providers';
import { fsTokenStorage } from '@/lib/oauth/storage-fs';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

let providersLoaded = false;
async function ensureProvidersLoaded() {
  if (providersLoaded) return;
  await loadAndRegisterProvidersFromDisk();
  providersLoaded = true;
}

interface Body {
  provider?: string;
  plugin?: string;
  harness?: string;
  field?: string;
  token?: string;
  requiredScopes?: string[];
}

export async function POST(req: Request) {
  await ensureProvidersLoaded();
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid json' }, { status: 400 });
  }
  const { provider: providerId, plugin, harness, field, token } = body;
  if (!providerId || !plugin || !harness || !field || !token) {
    return NextResponse.json(
      { ok: false, error: 'provider, plugin, harness, field, token all required' },
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
  if (!provider.introspect) {
    // Provider can't introspect — accept the token without scope check.
    await fsTokenStorage.update(plugin, harness, { [field]: token });
    return NextResponse.json({ ok: true, outcome: 'no-introspection', scopes: [] });
  }

  let granted: string[];
  try {
    const result = await provider.introspect(token);
    granted = result.scopes;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: `introspect failed: ${msg}` }, { status: 400 });
  }

  const required = body.requiredScopes ?? [];
  const outcome = compareScopes(granted, required);

  if (outcome.kind === 'subset') {
    return NextResponse.json(
      {
        ok: false,
        outcome: 'subset',
        missing: outcome.missing,
        scopes: granted,
        error: `token missing required scopes: ${outcome.missing.join(', ')}`,
      },
      { status: 400 },
    );
  }

  await fsTokenStorage.update(plugin, harness, { [field]: token });

  if (outcome.kind === 'superset') {
    return NextResponse.json({ ok: true, outcome: 'superset', extra: outcome.extra, scopes: granted });
  }
  return NextResponse.json({ ok: true, outcome: 'exact', scopes: granted });
}
