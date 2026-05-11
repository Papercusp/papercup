/**
 * POST /api/internal/decision-event
 *
 * bash run.sh's log() POSTs each parsed `ORCH decision: <VERB> <args>`
 * line directly here. The endpoint INSERTs a single
 * harness_decisions row keyed by (harness_slug, line_hash) — same PK
 * the legacy run.log parser used, so existing UI subscribers keep
 * working unchanged.
 *
 * Replaces the chokidar mirror that re-parsed the tail of run.log on
 * every fs.watch event. Producer (bash) now classifies at log time;
 * operator just persists the row.
 *
 * Auth: Authorization: Bearer <harness_token>.
 *
 * Body: { iso: string, verb: string, args?: string, iteration?: number|null, isGhost?: boolean }
 */
import { NextResponse } from 'next/server';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { getOrgPg, generated } from '@restart/db-org';
import { eq, sql as dsql } from 'drizzle-orm';
import { activeWorkspaceId } from '@/lib/workspace-registry';
import { notifySyncInvalidate } from '@/lib/sync-sse';

const ti = generated.token_indexInHarness_shared;
const hd = generated.harness_decisionsInHarness_shared;

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const BodySchema = z.object({
  iso: z.string().min(1),
  verb: z.string().min(1),
  args: z.string().optional().default(''),
  iteration: z.number().int().nullable().optional().default(null),
  isGhost: z.boolean().optional().default(false),
});

export async function POST(req: Request): Promise<Response> {
  const authHeader = req.headers.get('authorization') ?? '';
  const m = authHeader.match(/^Bearer\s+(\S+)$/i);
  if (!m) return NextResponse.json({ error: 'missing bearer' }, { status: 401 });
  const token = m[1];

  const { db } = getOrgPg();
  const rows = await db
    .select({ harness_slug: ti.harness_slug })
    .from(ti)
    .where(eq(ti.token, token))
    .limit(1);
  if (rows.length === 0) {
    return NextResponse.json({ error: 'invalid bearer' }, { status: 401 });
  }
  const slug = rows[0].harness_slug;

  let raw: unknown;
  try { raw = await req.json(); }
  catch { return NextResponse.json({ error: 'invalid json' }, { status: 400 }); }
  const parsed = BodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'validation failed', issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const { iso, verb, args, iteration, isGhost } = parsed.data;
  const ts = Date.parse(iso);
  const lineHash = createHash('sha1').update(`${iso}|${verb}|${args}`).digest('hex');

  const ws = activeWorkspaceId();
  await db
    .insert(hd)
    .values({
      harness_slug: slug,
      line_hash: lineHash,
      ts: Number.isNaN(ts) ? 0 : ts,
      iso,
      verb,
      args,
      iteration,
      is_ghost: isGhost,
      workspace_id: ws,
    })
    .onConflictDoUpdate({
      target: [hd.harness_slug, hd.line_hash],
      set: {
        ts: dsql`EXCLUDED.ts`,
        iso: dsql`EXCLUDED.iso`,
        verb: dsql`EXCLUDED.verb`,
        args: dsql`EXCLUDED.args`,
        iteration: dsql`EXCLUDED.iteration`,
        is_ghost: dsql`EXCLUDED.is_ghost`,
        workspace_id: dsql`EXCLUDED.workspace_id`,
      },
    });
  void notifySyncInvalidate('harnessDecisions.byHarness', { harnessSlug: slug }).catch(() => {});

  return NextResponse.json({ ok: true });
}
