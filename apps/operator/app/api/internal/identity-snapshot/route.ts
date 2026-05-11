/**
 * POST /api/internal/identity-snapshot
 *
 * bash run.sh's curator block POSTs the full set of identity/<role>.md
 * files after `invoke curator` finishes. Replaces the chokidar
 * identity-files-watcher (lib/identity-files-watcher.ts).
 *
 * Body: { files: [{role: string, content: string}, ...] }
 *   - Empty `content` for a role removes its row.
 *   - Any role NOT in the array is left alone (safer than a global
 *     replace-all — preserves rows curators in other workspaces wrote).
 *
 * Auth: Authorization: Bearer <harness_token>.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getOrgPg, generated } from '@restart/db-org';
import { eq, sql as dsql } from 'drizzle-orm';
import { activeWorkspaceId } from '@/lib/workspace-registry';
import { notifySyncInvalidate } from '@/lib/sync-sse';

const ti = generated.tokenIndexInHarnessShared;
const idf = generated.identityFilesInHarnessShared;

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const ROLE_RE = /^[a-z][a-z0-9_-]{0,63}$/i;
const MAX_BODY = 256 * 1024;

const FileEntrySchema = z.object({
  role: z.string().regex(ROLE_RE),
  content: z.string().optional().default(''),
});
const BodySchema = z.object({
  files: z.array(FileEntrySchema).optional().default([]),
});

export async function POST(req: Request): Promise<Response> {
  const authHeader = req.headers.get('authorization') ?? '';
  const m = authHeader.match(/^Bearer\s+(\S+)$/i);
  if (!m) return NextResponse.json({ error: 'missing bearer' }, { status: 401 });
  const token = m[1];

  const { db } = getOrgPg();
  const tokenRows = await db
    .select({ harness_slug: ti.harnessSlug })
    .from(ti)
    .where(eq(ti.token, token))
    .limit(1);
  if (tokenRows.length === 0) {
    return NextResponse.json({ error: 'invalid bearer' }, { status: 401 });
  }

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
  const { files } = parsed.data;
  const ws = activeWorkspaceId();
  const now = Date.now();
  let upserts = 0;
  let deletes = 0;

  for (const f of files) {
    let content = f.content;
    if (Buffer.byteLength(content) > MAX_BODY) {
      content = content.slice(0, MAX_BODY) + '\n...[truncated]\n';
    }
    if (content === '') {
      await db.delete(idf).where(eq(idf.role, f.role));
      deletes++;
    } else {
      const bytes = Buffer.byteLength(content);
      await db
        .insert(idf)
        .values({
          role: f.role,
          content,
          bytes,
          mtimeMs: now,
          updatedAt: now,
          workspaceId: ws,
        })
        .onConflictDoUpdate({
          target: idf.role,
          set: {
            content: dsql`EXCLUDED.content`,
            bytes: dsql`EXCLUDED.bytes`,
            mtimeMs: dsql`EXCLUDED.mtime_ms`,
            updatedAt: dsql`EXCLUDED.updated_at`,
            workspaceId: dsql`EXCLUDED.workspace_id`,
          },
        });
      upserts++;
    }
  }
  void notifySyncInvalidate('harnessIdentity').catch(() => {});
  return NextResponse.json({ ok: true, upserts, deletes });
}
