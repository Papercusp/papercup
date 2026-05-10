/**
 * POST /api/internal/checkpoint-event
 *
 * bash run.sh's checkpoint emitter (auto-fired post-planner OR
 * CHECKPOINT decision from the orchestrator) POSTs a structured event
 * after writing checkpoint-<name>.md. Replaces the chokidar mirror
 * that re-scanned .harness/ for checkpoint-*.md files.
 *
 * Body: { name: string, content: string }
 *   - name: stable id, e.g. "post-planner" or "unnamed"
 *   - content: full markdown body of the checkpoint file
 *
 * The grant path (`.granted` sibling file → granted=true) is already
 * operator-side in app/api/_hono/harness.ts; this endpoint only
 * handles the CREATE side that bash owns.
 *
 * Auth: Authorization: Bearer <harness_token>.
 */
import { NextResponse } from 'next/server';
import { getOrgPg } from '@restart/db-org';
import { activeWorkspaceId } from '@/lib/workspace-registry';
import { notifySyncInvalidate } from '@/lib/sync-sse';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface RequestBody {
  name?: string;
  content?: string;
}

const NAME_RE = /^[A-Za-z0-9_.-]{1,128}$/;
const MAX_CONTENT = 64 * 1024;

export async function POST(req: Request): Promise<Response> {
  const authHeader = req.headers.get('authorization') ?? '';
  const m = authHeader.match(/^Bearer\s+(\S+)$/i);
  if (!m) return NextResponse.json({ error: 'missing bearer' }, { status: 401 });
  const token = m[1];

  const { sql } = getOrgPg();
  const rows = await sql<{ harness_slug: string }[]>`
    SELECT harness_slug FROM harness_shared.token_index WHERE token = ${token} LIMIT 1
  `;
  if (rows.length === 0) {
    return NextResponse.json({ error: 'invalid bearer' }, { status: 401 });
  }
  const slug = rows[0].harness_slug;

  let body: RequestBody;
  try { body = (await req.json()) as RequestBody; }
  catch { return NextResponse.json({ error: 'invalid json' }, { status: 400 }); }

  const name = typeof body.name === 'string' ? body.name : '';
  if (!NAME_RE.test(name)) {
    return NextResponse.json({ error: 'invalid name' }, { status: 400 });
  }
  let content = typeof body.content === 'string' ? body.content : '';
  if (Buffer.byteLength(content) > MAX_CONTENT) {
    content = content.slice(0, MAX_CONTENT) + '\n...[truncated]\n';
  }
  const waitingSinceMs = Date.now();

  const ws = activeWorkspaceId();
  await sql`
    INSERT INTO harness_shared.harness_checkpoints
      (harness_slug, name, content, waiting_since_ms, granted, workspace_id)
    VALUES (${slug}, ${name}, ${content}, ${waitingSinceMs}, ${false}, ${ws})
    ON CONFLICT (harness_slug, name) DO UPDATE
      SET content = EXCLUDED.content,
          waiting_since_ms = EXCLUDED.waiting_since_ms,
          granted = EXCLUDED.granted,
          workspace_id = EXCLUDED.workspace_id
  `;
  void notifySyncInvalidate('harnessCheckpoints.byHarness', { harnessSlug: slug }).catch(() => {});
  return NextResponse.json({ ok: true });
}
