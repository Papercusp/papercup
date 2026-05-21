/**
 * POST /api/internal/escalation-event — escalation/supervisor-notes persist.
 *
 * Ported from app/api/internal/escalation-event/route.ts. `auth: 'public'`.
 */
import { z } from 'zod';
import { getOrgPg, generated } from '@restart/db-org';
import { eq, sql as dsql } from 'drizzle-orm';
import { activeWorkspaceId } from '@/lib/workspace-registry';
import { notifySyncInvalidate } from '@/lib/sync-sse';
import { defineTool } from '@papercusp/agent-mcp';

const ti = generated.tokenIndexInHarnessShared;
const he = generated.harnessEscalationsInHarnessShared;

const BodySchema = z
  .object({
    escalation: z.string().nullable().optional(),
    supervisorNotes: z.string().nullable().optional(),
    phase: z.enum(['staging', 'testing', 'production']).optional().default('staging'),
  })
  .refine((d) => d.escalation != null || d.supervisorNotes != null, {
    message: 'escalation or supervisorNotes required',
  });

const MAX_BODY = 256 * 1024;

export default defineTool({
  method: 'POST',
  path: '/internal/escalation-event',
  auth: {},
  async handler(req) {
    const authHeader = req.headers.get('authorization') ?? '';
    const m = authHeader.match(/^Bearer\s+(\S+)$/i);
    if (!m) return Response.json({ error: 'missing bearer' }, { status: 401 });
    const token = m[1];

    const { db } = getOrgPg();
    const rows = await db
      .select({ harness_slug: ti.harnessSlug })
      .from(ti)
      .where(eq(ti.token, token))
      .limit(1);
    if (rows.length === 0) {
      return Response.json({ error: 'invalid bearer' }, { status: 401 });
    }
    const slug = rows[0].harness_slug;

    let raw: unknown;
    try { raw = await req.json(); }
    catch { return Response.json({ error: 'invalid json' }, { status: 400 }); }
    const parsed = BodySchema.safeParse(raw);
    if (!parsed.success) {
      return Response.json(
        { error: 'validation failed', issues: parsed.error.issues },
        { status: 400 },
      );
    }
    const { phase } = parsed.data;
    let escalation: string | null = parsed.data.escalation ?? null;
    let supervisorNotes: string | null = parsed.data.supervisorNotes ?? null;
    if (escalation && Buffer.byteLength(escalation) > MAX_BODY) {
      escalation = escalation.slice(0, MAX_BODY) + '\n...[truncated]\n';
    }
    if (supervisorNotes && Buffer.byteLength(supervisorNotes) > MAX_BODY) {
      supervisorNotes = supervisorNotes.slice(0, MAX_BODY) + '\n...[truncated]\n';
    }
    const mtimeMs = Date.now();
    const ws = activeWorkspaceId();

    await db
      .insert(he)
      .values({
        harnessSlug: slug,
        phase,
        escalation,
        supervisorNotes: supervisorNotes,
        mtimeMs: mtimeMs,
        workspaceId: ws,
      })
      .onConflictDoUpdate({
        target: [he.harnessSlug, he.phase],
        set: {
          escalation: dsql`COALESCE(${escalation}, ${he.escalation})`,
          supervisorNotes: dsql`COALESCE(${supervisorNotes}, ${he.supervisorNotes})`,
          mtimeMs: dsql`EXCLUDED.mtime_ms`,
          workspaceId: dsql`EXCLUDED.workspace_id`,
        },
      });
    void notifySyncInvalidate('harnessEscalations.byHarness', { harnessSlug: slug, phase }).catch(() => {});
    return Response.json({ ok: true });
  },
});
