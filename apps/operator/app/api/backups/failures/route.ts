import { NextResponse } from 'next/server';
import { workspaceBackupFor } from '@/lib/backup';
import { activeWorkspaceId } from '@/lib/workspace-registry';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') ?? 50)));
    const wb = workspaceBackupFor(activeWorkspaceId());
    const failures = await wb.recentFailures(limit);
    return NextResponse.json({ failures });
  } catch (err) {
    return NextResponse.json({ error: String(err instanceof Error ? err.message : err) }, { status: 500 });
  }
}
