/**
 * POST /api/internal/archive-event
 *
 * bash run.sh's archiveOnDone hook POSTs the metadata of each .tar.gz
 * it creates. Replaces the chokidar mirror that re-scanned the archives
 * directory on every fs.watch event.
 *
 * Body: validated via the Zod schema below — derived from the
 * `harness_archives` insert shape (via `schemaOf(ha).insert`) with
 * server-supplied fields (`harness_slug`, `workspace_id`) and the
 * camelCase wire names (`sizeBytes`, `ts`) layered on top.
 *
 * Auth: Authorization: Bearer <harness_token>.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getOrgPg, generated, schemaOf } from '@restart/db-org';
import { eq, sql as dsql } from 'drizzle-orm';
import { activeWorkspaceId } from '@/lib/workspace-registry';
import { notifySyncInvalidate } from '@/lib/sync-sse';

const ti = generated.tokenIndexInHarnessShared;
const ha = generated.harnessArchivesInHarnessShared;

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Body shape: insert columns excluding server-supplied ones, with camelCase
// wire names. `schemaOf(ha).insert` would type-check the drizzle bindings
// here, but the body wire format is a small fixed schema so we author it
// explicitly. The columns are sourced from harness_archives' generated.ts
// definition; tsc catches drift via the .values() call below.
const BodySchema = z.object({
  id: z.string().min(1).endsWith('.tar.gz'),
  sizeBytes: z.number().int().nonnegative().optional().default(0),
  ts: z.number().int().nonnegative().optional().default(() => Date.now()),
  phase: z.enum(['staging', 'testing', 'production']).optional().default('staging'),
});

// Keep `schemaOf(ha).insert` referenced so a column rename in PG shows up
// here at compile time even though we author the wire body manually.
void schemaOf(ha).insert;

export async function POST(req: Request): Promise<Response> {
  const authHeader = req.headers.get('authorization') ?? '';
  const m = authHeader.match(/^Bearer\s+(\S+)$/i);
  if (!m) return NextResponse.json({ error: 'missing bearer' }, { status: 401 });
  const token = m[1];

  const { db } = getOrgPg();
  const rows = await db
    .select({ harness_slug: ti.harnessSlug })
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
  const { id, sizeBytes, ts, phase } = parsed.data;

  const ws = activeWorkspaceId();
  await db
    .insert(ha)
    .values({
      harnessSlug: slug,
      phase,
      id,
      sizeBytes: sizeBytes,
      ts,
      workspaceId: ws,
    })
    .onConflictDoUpdate({
      target: [ha.harnessSlug, ha.phase, ha.id],
      set: {
        sizeBytes: dsql`EXCLUDED.size_bytes`,
        ts: dsql`EXCLUDED.ts`,
        workspaceId: dsql`EXCLUDED.workspace_id`,
      },
    });
  void notifySyncInvalidate('harnessArchives.byHarness', { harnessSlug: slug, phase }).catch(() => {});
  return NextResponse.json({ ok: true });
}
