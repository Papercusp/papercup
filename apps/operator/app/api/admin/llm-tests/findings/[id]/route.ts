/**
 * PATCH /api/admin/llm-tests/findings/[id]  — toggle acknowledged.
 *
 * Body: { acknowledged: true | false, acknowledgedBy?: string }
 *
 * "Acknowledged" means an admin has triaged the finding (either fixed
 * the underlying issue, deemed it noise, or filed a separate ticket).
 * Once acknowledged, it drops out of the default findings view but
 * stays in the database for audit + promotion-loop counts.
 */

import { NextRequest, NextResponse } from 'next/server';
import postgres from 'postgres';

import { getHarnessAdminUrl } from '@/lib/embedded-pg-discovery';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

let pool: ReturnType<typeof postgres> | null = null;
function db() {
  if (!pool) pool = postgres(getHarnessAdminUrl(), { max: 4, prepare: false });
  return pool;
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let body: { acknowledged?: boolean; acknowledgedBy?: string } = {};
  try {
    body = (await req.json()) ?? {};
  } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 });
  }
  if (typeof body.acknowledged !== 'boolean') {
    return NextResponse.json({ error: 'acknowledged: boolean required' }, { status: 400 });
  }

  const sql = db();
  const rows = await sql<Array<{ id: string }>>`
    UPDATE harness_shared.llm_test_findings
    SET acknowledged = ${body.acknowledged},
        acknowledged_by = ${body.acknowledged ? (body.acknowledgedBy ?? null) : null},
        acknowledged_at = ${body.acknowledged ? sql`now()` : null}
    WHERE id = ${id}
    RETURNING id
  `;
  if (rows.length === 0) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
