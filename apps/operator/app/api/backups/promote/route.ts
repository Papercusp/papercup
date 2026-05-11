/**
 * POST /api/backups/promote — promote a restored clone to live.
 * Body: { restoredPath, liveTarget? }
 * Atomic rename: live → .broken-<ts>-<name>/, clone → live.
 * Writes .promotion-meta-<ts>.json marker for rollback discovery.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { workspaceBackupFor, triggerSnapshotEvent } from '@/lib/backup';
import { activeWorkspaceId } from '@/lib/workspace-registry';

export const dynamic = 'force-dynamic';

const Schema = z.object({
  restoredPath: z.string().min(1),
  liveTarget: z.string().min(1).optional(),
});

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const args = Schema.parse(body);
    const ws = activeWorkspaceId();
    // Belt-and-suspenders: snapshot the live state before we rename it
    // to .broken-*. If the promotion ends up being wrong AND the user
    // also deletes the .broken-* dir, there's still a snapshot to come
    // back from. Errors here are non-fatal — proceed with the promote
    // either way; the rename itself is already reversible.
    await triggerSnapshotEvent(ws, 'pre_destructive', { op: 'promote_restore', restoredPath: args.restoredPath })
      .catch(() => { /* ignore */ });
    const wb = workspaceBackupFor(ws);
    const result = await wb.promoteRestore(args);
    return NextResponse.json({ result });
  } catch (err) {
    return NextResponse.json({ error: String(err instanceof Error ? err.message : err) }, { status: 500 });
  }
}
