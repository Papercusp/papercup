/**
 * POST /api/ui/intents/:id/result
 *
 * Browser-side dispatcher posts back after running an intent handler.
 * Sets status=done (with result) or status=error (with error_message).
 * The MCP `ui:dispatch` tool's long-poll wakes up on the next read.
 *
 * Loopback-only.
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getOrgPg, generated } from '@restart/db-org';
import { and, eq, sql as dsql } from 'drizzle-orm';
import { isLoopbackRequest } from '@/lib/superuser-token';
import { ensureUiIntentsTable } from '@/lib/ensure-schema';

const ui = generated.ui_intentsInHarness_shared;

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const BodySchema = z.object({
  result: z.unknown().optional(),
  error: z.string().nullable().optional(),
});

export async function POST(
  req: Request,
  context: { params: Promise<{ id: string }> },
) {
  if (!isLoopbackRequest(req.headers)) {
    return NextResponse.json({ error: 'loopback_required' }, { status: 403 });
  }
  const { id: idRaw } = await context.params;
  const id = Number(idRaw);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: 'invalid_id' }, { status: 400 });
  }
  let body: unknown;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'invalid_json' }, { status: 400 }); }
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 });
  }
  const { result, error } = parsed.data;

  await ensureUiIntentsTable();
  const { db } = getOrgPg();

  const status = error ? 'error' : 'done';
  const rows = await db
    .update(ui)
    .set({
      status,
      result: (result === undefined ? null : result) as any,
      error_message: error ?? null,
      completed_at: dsql`now()` as any,
    })
    .where(and(eq(ui.id, BigInt(id)), eq(ui.status, 'pending')))
    .returning({ id: ui.id });
  if (rows.length === 0) {
    return NextResponse.json({ error: 'not_pending_or_missing' }, { status: 404 });
  }
  return NextResponse.json({ ok: true, status });
}
