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
    const start = Date.now();
    try {
      const result = await wb.snapshot(reason, context);
      // Synthesize a trace so the /dev terminal can show what happened
      // even though the lifecycle is multi-step (hook + kopia + sync).
      const trace = {
        command: `WorkspaceBackup.snapshot(${reason})`,
        exitCode: 0,
        stdout: [
          `pre-snapshot hook: pg_dumpall :16534 → db-dumps/pg-embedded.sql.gz`,
          `kopia snapshot create ${result.kopiaSnapshotId.slice(0, 12)}…`,
          `bytes_added=${result.bytesAdded} duration=${result.durationMs}ms`,
          `→ backup_snapshots row id=${result.snapshotId}`,
        ].join('\n'),
        stderr: '',
        durationMs: Date.now() - start,
      };
      return NextResponse.json({ result, trace });
    } catch (err) {
      const trace = {
        command: `WorkspaceBackup.snapshot(${reason})`,
        exitCode: 1,
        stdout: '',
        stderr: String(err instanceof Error ? err.message : err),
        durationMs: Date.now() - start,
      };
      return NextResponse.json({ trace, error: trace.stderr }, { status: 500 });
    }
  } catch (err) {
    return NextResponse.json({ error: String(err instanceof Error ? err.message : err) }, { status: 500 });
  }
}
