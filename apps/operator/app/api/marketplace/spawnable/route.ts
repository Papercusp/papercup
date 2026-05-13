/**
 * GET /api/marketplace/spawnable
 *
 * Returns the catalog filtered to entries with `spawnable: { kind, requires }`
 * declared in their manifest. Used by the executor's scaffold_harness verb
 * to validate templates and by prompt-build's "Available templates" section.
 */
import { NextResponse } from 'next/server';
import { FLAGS } from '@papercusp/flags';
import { gateApiRoute } from '@/lib/require-flag';
import { getSpawnableTemplates } from '../../_hono/cross-harness';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: Request) {
  const blocked = await gateApiRoute(req, FLAGS.MARKETPLACE);
  if (blocked) return blocked;
  const result = await getSpawnableTemplates();
  return NextResponse.json(result);
}
