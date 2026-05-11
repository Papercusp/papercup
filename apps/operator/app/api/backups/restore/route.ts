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
  /** "clone" (default, safe) writes to .restored/<id>/. "in_place" overwrites */
  /** target after taking a safety snapshot. */
  mode: z.enum(['clone', 'in_place']).default('clone'),
});

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const args = Schema.parse(body);
    const wb = workspaceBackupFor(activeWorkspaceId());
    if (args.mode === 'in_place') {
      const result = await wb.restoreInPlace({
        kopiaSnapshotId: args.kopiaSnapshotId,
        target: args.target,
      });
      return NextResponse.json({ result });
    }
    const result = await wb.restoreToClone(args);
    return NextResponse.json({ result });
  } catch (err) {
    return NextResponse.json({ error: String(err instanceof Error ? err.message : err) }, { status: 500 });
  }
}
