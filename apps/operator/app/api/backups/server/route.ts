/**
 * GET    /api/backups/server  — start (idempotent) + return iframe URL.
 * DELETE /api/backups/server  — stop the kopia server for this workspace.
 */
import { NextResponse } from 'next/server';
import { startKopiaServer, stopKopiaServer, kopiaServerStatus } from '@/lib/backup';
import { activeWorkspaceId } from '@/lib/workspace-registry';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const ws = activeWorkspaceId();
    const existing = kopiaServerStatus(ws);
    const info = existing ?? (await startKopiaServer(ws));
    return NextResponse.json({ server: info });
  } catch (err) {
    return NextResponse.json({ error: String(err instanceof Error ? err.message : err) }, { status: 500 });
  }
}

export async function DELETE() {
  const ws = activeWorkspaceId();
  const stopped = stopKopiaServer(ws);
  return NextResponse.json({ stopped });
}
