/**
 * GET  /api/credentials/search-providers — masked view of configured search-provider keys.
 * POST /api/credentials/search-providers — write one or more env-var values.
 *
 * Body shape (POST): { values: { ENV_VAR_NAME: 'value' | null, ... } }
 * Empty string or null clears a field.
 *
 * Responses:
 *   GET  → { providers: [{ id, label, fields: [{ envVar, masked, isPrimary }] }], updatedAt }
 *   POST → same shape as GET (post-write masked view)
 *
 * Backed by harness_shared.operator_search_provider_credentials (Migration
 * 047), encrypted at rest. Values are passed to the orchestrator's
 * spawn-env injection so OMP discovers them as env vars at spawn time.
 *
 * Spec: apps/operator/docs/plugin-mcp-host-design.md.
 */
import { NextResponse } from 'next/server';
import {
  readMaskedView,
  writeSearchProviderCredentials,
} from '@/lib/search-provider-credentials';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET() {
  const view = await readMaskedView();
  return NextResponse.json(view);
}

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }
  const values = (body as { values?: Record<string, string | null> } | null)?.values;
  if (!values || typeof values !== 'object') {
    return NextResponse.json(
      { error: 'expected { values: { ENV_VAR_NAME: string | null, ... } }' },
      { status: 400 },
    );
  }
  // Coerce + validate: all entries must be string|null and the env-var
  // name must look reasonable. Keep validation light — the lib also
  // validates and the masking layer prevents accidental leaks.
  const cleaned: Record<string, string | null> = {};
  for (const [k, v] of Object.entries(values)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(k)) continue;
    if (v === null) cleaned[k] = null;
    else if (typeof v === 'string') cleaned[k] = v;
  }
  await writeSearchProviderCredentials(cleaned);
  const view = await readMaskedView();
  return NextResponse.json(view);
}
