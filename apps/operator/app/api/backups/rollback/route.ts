/**
 * POST /api/backups/rollback — undo a previous promote.
 * Body: { brokenPath }
 * Brings the .broken-<ts>-<name>/ dir back to live, stashing the
 * current live under .rolled-back-<ts>-<name>/ for further inspection.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { workspaceBackupFor } from '@/lib/backup';
import { activeWorkspaceId } from '@/lib/workspace-registry';

export const dynamic = 'force-dynamic';

const Schema = z.object({ brokenPath: z.string().min(1) });

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const args = Schema.parse(body);
    const wb = workspaceBackupFor(activeWorkspaceId());
    const result = await wb.rollbackPromote(args);
    return NextResponse.json({ result });
  } catch (err) {
    return NextResponse.json({ error: String(err instanceof Error ? err.message : err) }, { status: 500 });
  }
}
