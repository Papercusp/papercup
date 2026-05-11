/**
 * GET /api/backups/events?since=<iso>&limit=N — recent backup_events rows.
 * Used by the /dev BackupsTab to render live snapshot progress (the
 * "what happened during this snapshot" view) without hammering kopia.
 */
import { NextResponse } from 'next/server';
import { getOrgPg } from '@restart/db-org';
import { activeWorkspaceId } from '@/lib/workspace-registry';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const since = url.searchParams.get('since');
    const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit') ?? 100)));
    const { sql } = getOrgPg();
    const workspaceId = activeWorkspaceId();
    const rows = since
      ? await sql<{
          id: number; snapshot_id: number | null; kind: string; payload_json: unknown; at: Date;
        }[]>`
          SELECT id, snapshot_id, kind, payload_json, at
          FROM harness_shared.backup_events
          WHERE workspace_id = ${workspaceId} AND at > ${since}::timestamptz
          ORDER BY at DESC
          LIMIT ${limit}
        `
      : await sql<{
          id: number; snapshot_id: number | null; kind: string; payload_json: unknown; at: Date;
        }[]>`
          SELECT id, snapshot_id, kind, payload_json, at
          FROM harness_shared.backup_events
          WHERE workspace_id = ${workspaceId}
          ORDER BY at DESC
          LIMIT ${limit}
        `;
    return NextResponse.json({
      events: rows.map((r) => ({
        id: r.id,
        snapshotId: r.snapshot_id,
        kind: r.kind,
        payload: r.payload_json,
        at: r.at.toISOString(),
      })),
    });
  } catch (err) {
    return NextResponse.json({ error: String(err instanceof Error ? err.message : err) }, { status: 500 });
  }
}
