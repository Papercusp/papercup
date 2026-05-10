/**
 * GET /api/user-actions/[slug]/[id]/log
 *
 * Returns the run-log body for one user-action row (identified by row
 * id). Backs the ExpertsPanel autonomous-dispatch list, where clicking
 * a `ua-<id>` entry opens the corresponding log file inline.
 *
 * Authorization: the row's `detail_url` must point inside the harness's
 * own project directory. We refuse to serve any path outside that root,
 * so a poisoned detail_url can't leak arbitrary files.
 */
import { NextRequest, NextResponse } from 'next/server';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { getOrgPg } from '@restart/db-org';
import { ensureUserActionsTable } from '../../../../../../lib/ensure-schema';
import { loadHarnessRegistry } from '../../../../../../lib/harness-registry';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_BYTES = 2 * 1024 * 1024; // 2 MiB cap per response

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ slug: string; id: string }> },
): Promise<NextResponse> {
  const { slug, id } = await params;
  const numericId = Number(id);
  if (!Number.isFinite(numericId) || numericId <= 0) {
    return NextResponse.json({ error: 'invalid id' }, { status: 400 });
  }

  const reg = await loadHarnessRegistry();
  const project = reg.projects.find((p) => p.slug === slug);
  if (!project) return NextResponse.json({ error: 'unknown harness' }, { status: 404 });

  await ensureUserActionsTable();
  const { sql } = getOrgPg();
  const rows = (await sql`
    SELECT detail_url, kind, status
      FROM harness_shared.user_actions
     WHERE harness_slug = ${slug} AND id = ${numericId}
     LIMIT 1
  `) as Array<{ detail_url: string | null; kind: string; status: string }>;
  if (rows.length === 0) return NextResponse.json({ error: 'not found' }, { status: 404 });
  const detailUrl = rows[0].detail_url;
  if (!detailUrl) {
    return NextResponse.json({ error: 'no detail url for this user_action' }, { status: 404 });
  }

  // Path-traversal guard: only serve files rooted in the harness's project dir.
  const projectRoot = resolve(project.path);
  const target = resolve(detailUrl);
  if (!target.startsWith(projectRoot + '/') && target !== projectRoot) {
    return NextResponse.json({ error: 'detail url outside harness root' }, { status: 403 });
  }
  if (!existsSync(target)) {
    return NextResponse.json({ error: 'log file missing on disk', path: target }, { status: 404 });
  }
  let content = '';
  try {
    const st = statSync(target);
    if (st.size > MAX_BYTES) {
      // Return tail of the file when oversized.
      const fd = readFileSync(target);
      content = `… (truncated ${st.size - MAX_BYTES} earlier bytes)\n` +
        fd.subarray(fd.length - MAX_BYTES).toString('utf8');
    } else {
      content = readFileSync(target, 'utf8');
    }
  } catch (e) {
    return NextResponse.json({ error: 'read failed', detail: String((e as Error)?.message ?? e) }, { status: 500 });
  }

  return new NextResponse(content, {
    status: 200,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
      'x-user-action-id': String(numericId),
      'x-user-action-status': rows[0].status,
      'x-user-action-kind': rows[0].kind,
    },
  });
}
