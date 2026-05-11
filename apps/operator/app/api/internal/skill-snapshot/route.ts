/**
 * POST /api/internal/skill-snapshot
 *
 * bash run.sh's curator block POSTs the full set of .harness/skills/*.md
 * files after `invoke curator` finishes. Replaces Mirror 7b9 in
 * harness-fs-watcher.ts.
 *
 * Body: { files: [{name: string, content: string}, ...] }
 *   - Empty `files` array → DELETE all skills for the harness.
 *   - Skill names NOT in the array are deleted (replace-all semantics
 *     match the legacy mirror, since curator rewrites the dir wholesale).
 *
 * Auth: Authorization: Bearer <harness_token>.
 */
import { NextResponse } from 'next/server';
import { getOrgPg, generated } from '@restart/db-org';
import { and, eq, notInArray, sql as dsql } from 'drizzle-orm';
import { activeWorkspaceId } from '@/lib/workspace-registry';
import { notifySyncInvalidate } from '@/lib/sync-sse';

const ti = generated.token_indexInHarness_shared;
const hsk = generated.harness_skillsInHarness_shared;

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const NAME_RE = /^[A-Za-z0-9_.-]+\.md$/;
const MAX_BODY = 256 * 1024;

interface FileEntry { name?: string; content?: string }
interface RequestBody { files?: FileEntry[] }

export async function POST(req: Request): Promise<Response> {
  const authHeader = req.headers.get('authorization') ?? '';
  const m = authHeader.match(/^Bearer\s+(\S+)$/i);
  if (!m) return NextResponse.json({ error: 'missing bearer' }, { status: 401 });
  const token = m[1];

  const { db } = getOrgPg();
  const tokenRows = await db
    .select({ harness_slug: ti.harness_slug })
    .from(ti)
    .where(eq(ti.token, token))
    .limit(1);
  if (tokenRows.length === 0) {
    return NextResponse.json({ error: 'invalid bearer' }, { status: 401 });
  }
  const slug = tokenRows[0].harness_slug;

  let body: RequestBody;
  try { body = (await req.json()) as RequestBody; }
  catch { return NextResponse.json({ error: 'invalid json' }, { status: 400 }); }

  const files = Array.isArray(body.files) ? body.files : [];
  const ws = activeWorkspaceId();
  const now = Date.now();

  // Validate + filter to keepable entries.
  const keep: { name: string; content: string }[] = [];
  for (const f of files) {
    if (!f || typeof f.name !== 'string' || !NAME_RE.test(f.name)) continue;
    let content = typeof f.content === 'string' ? f.content : '';
    if (Buffer.byteLength(content) > MAX_BODY) {
      content = content.slice(0, MAX_BODY) + '\n...[truncated]\n';
    }
    keep.push({ name: f.name, content });
  }

  // Replace-all semantics: orphan-delete any skill not in the snapshot,
  // then UPSERT the rest.
  if (keep.length === 0) {
    await db.delete(hsk).where(and(eq(hsk.workspace_id, ws), eq(hsk.harness_slug, slug)));
  } else {
    const names = keep.map((k) => k.name);
    await db
      .delete(hsk)
      .where(and(eq(hsk.workspace_id, ws), eq(hsk.harness_slug, slug), notInArray(hsk.name, names)));
    for (const k of keep) {
      await db
        .insert(hsk)
        .values({
          workspace_id: ws,
          harness_slug: slug,
          name: k.name,
          content: k.content,
          mtime_ms: now,
        })
        .onConflictDoUpdate({
          target: [hsk.workspace_id, hsk.harness_slug, hsk.name],
          set: { content: dsql`EXCLUDED.content`, mtime_ms: dsql`EXCLUDED.mtime_ms` },
        });
    }
  }
  void notifySyncInvalidate('harnessSkills.byHarness', { harnessSlug: slug }).catch(() => {});
  return NextResponse.json({ ok: true, count: keep.length });
}
