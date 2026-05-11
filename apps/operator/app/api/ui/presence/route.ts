/**
 * POST /api/ui/presence
 *
 * Each open browser tab calls this on mount, on every URL change, and
 * every 15s as a heartbeat. Upserts into harness_shared.ui_clients so
 * agents can ask "what is the user looking at right now?".
 *
 * Loopback-only — same trust boundary as the rest of the operator.
 * No bearer required: the URL/title in the body is the browser's own
 * state, and we're not trusting it as authority for anything except
 * "this tab is alive."
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getOrgPg, generated } from '@restart/db-org';
import { sql as dsql } from 'drizzle-orm';
import { isLoopbackRequest } from '@/lib/superuser-token';
import { ensureUiClientsTable } from '@/lib/ensure-schema';

const uc = generated.ui_clientsInHarness_shared;

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const BodySchema = z.object({
  client_id: z.string().min(8).max(128),
  url: z.string().min(1).max(4096),
  title: z.string().max(512).nullable().optional(),
  workspace_id: z.string().max(128).nullable().optional(),
  viewport: z.record(z.string(), z.unknown()).nullable().optional(),
});

export async function POST(req: Request) {
  if (!isLoopbackRequest(req.headers)) {
    return NextResponse.json({ error: 'loopback_required' }, { status: 403 });
  }
  let body: unknown;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'invalid_json' }, { status: 400 }); }
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid_body', issues: parsed.error.issues }, { status: 400 });
  }
  const { client_id, url, title, workspace_id, viewport } = parsed.data;

  await ensureUiClientsTable();
  const { db } = getOrgPg();
  await db
    .insert(uc)
    .values({
      client_id,
      workspace_id: workspace_id ?? null,
      url,
      title: title ?? null,
      viewport: (viewport ?? null) as any,
      last_seen_at: dsql`now()` as any,
    })
    .onConflictDoUpdate({
      target: uc.client_id,
      set: {
        workspace_id: dsql`EXCLUDED.workspace_id`,
        url: dsql`EXCLUDED.url`,
        title: dsql`EXCLUDED.title`,
        viewport: dsql`EXCLUDED.viewport`,
        last_seen_at: dsql`now()`,
      },
    });
  return NextResponse.json({ ok: true });
}
