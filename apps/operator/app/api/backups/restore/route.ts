/**
 * POST /api/backups/restore — restore-to-clone only. Never overwrites.
 * Body: { kopiaSnapshotId, source?, target? }
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { workspaceBackupFor } from '@/lib/backup';
import { activeWorkspaceId } from '@/lib/workspace-registry';

export const dynamic = 'force-dynamic';

const Schema = z.object({
  kopiaSnapshotId: z.string().min(1),
  source: z.string().min(1).optional(),
  target: z.string().min(1).optional(),
});

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const args = Schema.parse(body);
    const wb = workspaceBackupFor(activeWorkspaceId());
    const result = await wb.restoreToClone(args);
    return NextResponse.json({ result });
  } catch (err) {
    return NextResponse.json({ error: String(err instanceof Error ? err.message : err) }, { status: 500 });
  }
}
