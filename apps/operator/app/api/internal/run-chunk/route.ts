/**
 * POST /api/internal/run-chunk
 *
 * The orchestrator's invoke.ts posts each subprocess stdout chunk here.
 * Auth: Authorization: Bearer <harness_token> (validated against
 * harness_shared.token_index — same scheme as /api/admin/execute-action).
 *
 * Body: { runId: string, seq: number, chunk: string, done?: boolean }
 *   - runId: orchestrator-assigned per-invocation id
 *   - seq: monotonic per-runId chunk sequence
 *   - chunk: raw text payload (typically one JSONL line of agent stream output)
 *   - done: when true, marks the run channel closed after publishing
 *
 * Returns: { ok: true } or { error: ... } 4xx/5xx
 *
 * The handler delegates to the in-process run-chunk-bus, which fans out
 * to subscribers (the operator's agent SSE handler) with sub-ms latency.
 * No DB, no filesystem.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getOrgPg, generated } from '@restart/db-org';
import { eq } from 'drizzle-orm';
import { publish, closeChannel } from '@/lib/run-chunk-bus';

const ti = generated.tokenIndexInHarnessShared;

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const RUN_ID_RE = /^[A-Za-z0-9_.-]{1,128}$/;
const MAX_CHUNK_BYTES = 256 * 1024; // 256 KB; one stdout chunk shouldn't exceed this

const BodySchema = z.object({
  runId: z.string().regex(RUN_ID_RE),
  seq: z.number().int().nonnegative(),
  chunk: z.string(),
  done: z.boolean().optional().default(false),
});

export async function POST(req: Request): Promise<Response> {
  // 1. Auth.
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
  const harnessSlug = rows[0].harness_slug;

  // 2. Body.
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
  const { runId, seq, chunk, done } = parsed.data;

  if (Buffer.byteLength(chunk) > MAX_CHUNK_BYTES) {
    return NextResponse.json({ error: 'chunk too large' }, { status: 413 });
  }

  // 3. Namespace runId by harness_slug to prevent cross-harness collision
  //    and ensure subscribers only see chunks from their own runs.
  const channelKey = `${harnessSlug}:${runId}`;

  // 4. Publish + optionally close.
  publish(channelKey, seq, chunk);
  if (done) closeChannel(channelKey);

  return NextResponse.json({ ok: true });
}
