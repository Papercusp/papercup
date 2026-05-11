/**
 * GET  /api/backups/snapshots?limit=100  — recent snapshots from PG.
 * POST /api/backups/snapshots            — manually create one. Body:
 *                                          { reason?, context? } (defaults to 'manual').
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { workspaceBackupFor } from '@/lib/backup';
import { activeWorkspaceId } from '@/lib/workspace-registry';

export const dynamic = 'force-dynamic';

const PostSchema = z.object({
  reason: z.enum([
    'manual', 'interval', 'pre_destructive', 'post_run',
    'plugin_install', 'secret_change', 'startup',
  ]).default('manual'),
  context: z.record(z.unknown()).optional(),
});

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit') ?? 100)));
    const wb = workspaceBackupFor(activeWorkspaceId());
    const snapshots = await wb.list(limit);
    return NextResponse.json({ snapshots });
  } catch (err) {
    return NextResponse.json({ error: String(err instanceof Error ? err.message : err) }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const { reason, context } = PostSchema.parse(body);
    const wb = workspaceBackupFor(activeWorkspaceId());
    const result = await wb.snapshot(reason, context);
    return NextResponse.json({ result });
  } catch (err) {
    return NextResponse.json({ error: String(err instanceof Error ? err.message : err) }, { status: 500 });
  }
}
