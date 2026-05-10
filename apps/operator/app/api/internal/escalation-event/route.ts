/**
 * POST /api/internal/escalation-event
 *
 * bash run.sh's plan-reviewer rejection path AND bin/supervisor.sh
 * POST escalation/supervisor-notes content here. Replaces the
 * chokidar mirror that re-read both sibling files on every fs event.
 *
 * Body: { escalation?: string|null, supervisorNotes?: string|null,
 *         phase?: 'staging'|'testing'|'production' }
 *   - phase defaults to 'staging' (matches today's bash producers)
 *   - null values mean "this side not changed"; the row UPDATE skips
 *     them via COALESCE so partial POSTs don't clobber the other side
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
  escalation?: string | null;
  supervisorNotes?: string | null;
  phase?: string;
}

const VALID_PHASES = new Set(['staging', 'testing', 'production']);
const MAX_BODY = 256 * 1024;

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

  const phase = typeof body.phase === 'string' && VALID_PHASES.has(body.phase) ? body.phase : 'staging';
  let escalation: string | null = body.escalation === null ? null
    : (typeof body.escalation === 'string' ? body.escalation : null);
  let supervisorNotes: string | null = body.supervisorNotes === null ? null
    : (typeof body.supervisorNotes === 'string' ? body.supervisorNotes : null);
  if (escalation === null && supervisorNotes === null) {
    return NextResponse.json({ error: 'escalation or supervisorNotes required' }, { status: 400 });
  }
  if (escalation && Buffer.byteLength(escalation) > MAX_BODY) {
    escalation = escalation.slice(0, MAX_BODY) + '\n...[truncated]\n';
  }
  if (supervisorNotes && Buffer.byteLength(supervisorNotes) > MAX_BODY) {
    supervisorNotes = supervisorNotes.slice(0, MAX_BODY) + '\n...[truncated]\n';
  }
  const mtimeMs = Date.now();
  const ws = activeWorkspaceId();

  // INSERT or partial UPDATE — null values keep the existing column.
  await sql`
    INSERT INTO harness_shared.harness_escalations
      (harness_slug, phase, escalation, supervisor_notes, mtime_ms, workspace_id)
    VALUES (${slug}, ${phase}, ${escalation}, ${supervisorNotes}, ${mtimeMs}, ${ws})
    ON CONFLICT (harness_slug, phase) DO UPDATE
      SET escalation       = COALESCE(${escalation}, harness_escalations.escalation),
          supervisor_notes = COALESCE(${supervisorNotes}, harness_escalations.supervisor_notes),
          mtime_ms         = EXCLUDED.mtime_ms,
          workspace_id     = EXCLUDED.workspace_id
  `;
  void notifySyncInvalidate('harnessEscalations.byHarness', { harnessSlug: slug, phase }).catch(() => {});
  return NextResponse.json({ ok: true });
}
