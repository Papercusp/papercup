/**
 * GET /api/marketplace/spawnable
 *
 * Returns the catalog filtered to entries with `spawnable: { kind, requires }`
 * declared in their manifest. Used by the executor's scaffold_harness verb
 * to validate templates and by prompt-build's "Available templates" section.
 */
import { NextResponse } from 'next/server';
import { getSpawnableTemplates } from '../../_hono/cross-harness';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET() {
  const result = await getSpawnableTemplates();
  return NextResponse.json(result);
}
