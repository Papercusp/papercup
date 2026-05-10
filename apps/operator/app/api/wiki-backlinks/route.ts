/**
 * GET /api/wiki-backlinks?target=<filename>[&harness=<slug>]
 *
 * Returns markdown files in the workspace that reference [[target]].
 * Backed by `apps/operator/lib/wiki-backlinks.ts` so the legacy route +
 * MCP tool share one scanner.
 */

import { NextResponse } from 'next/server';
import { findWikiBacklinks } from '@/lib/wiki-backlinks';

export async function GET(req: Request) {
  const url = new URL(req.url);
  const target = (url.searchParams.get('target') ?? '').trim();
  const harness = url.searchParams.get('harness')?.trim() ?? null;

  if (!target) {
    return NextResponse.json({ error: 'missing target' }, { status: 400 });
  }
  const result = await findWikiBacklinks(target, harness);
  return NextResponse.json(result);
}
