/**
 * POST /api/internal/log-event
 *
 * bash run.sh's log() function posts each log line here so subscribers
 * to /:slug/log/stream and /:slug/stream see live updates without
 * fs.watch + JSONL polling.
 *
 * Auth: Authorization: Bearer <harness_token> (validated against
 * harness_shared.token_index). Same scheme as /api/internal/run-chunk.
 *
 * Body: { kind: 'log' | 'raw', line: string }
 *   - kind 'log': structured JSONL line — published to "<slug>:log"
 *   - kind 'raw': plain human-readable line — published to "<slug>:raw"
 *
 * Both can be sent for the same source line (run.sh's log() emits each
 * line in both forms; one POST per kind, or a single POST with both).
 *
 * Returns: { ok: true } or { error: ... }
 */
import { NextResponse } from 'next/server';
import { getOrgPg } from '@restart/db-org';
import { publish } from '@/lib/harness-log-bus';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const KIND_RE = /^(log|raw)$/;
const MAX_LINE_BYTES = 64 * 1024; // 64 KB; one log line shouldn't exceed this

interface RequestBody {
  kind?: string;
  line?: string;
  raw?: string;
  log?: string;
}

export async function POST(req: Request): Promise<Response> {
  // 1. Auth.
  const authHeader = req.headers.get('authorization') ?? '';
  const m = authHeader.match(/^Bearer\s+(\S+)$/i);
  if (!m) return NextResponse.json({ error: 'missing bearer' }, { status: 401 });
  const token = m[1];

  const { sql } = getOrgPg();
  const rows = await sql<{ harness_slug: string }[]>`
    SELECT harness_slug FROM harness_shared.token_index WHERE token = ${token} LIMIT 1
  `;
  if (rows.length === 0) {
    return NextResponse.json({ error: 'invalid bearer' }, { status: 401 });
  }
  const slug = rows[0].harness_slug;

  // 2. Body.
  let body: RequestBody;
  try {
    body = (await req.json()) as RequestBody;
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }

  // Two modes:
  //   { kind: 'log', line: '...' }            — single channel
  //   { log: '...json...', raw: '[ts] ...' }  — both channels in one POST
  let logLine: string | null = null;
  let rawLine: string | null = null;

  if (typeof body.kind === 'string' && KIND_RE.test(body.kind)) {
    if (typeof body.line !== 'string') {
      return NextResponse.json({ error: 'invalid line' }, { status: 400 });
    }
    if (body.kind === 'log') logLine = body.line;
    else rawLine = body.line;
  } else {
    if (typeof body.log === 'string') logLine = body.log;
    if (typeof body.raw === 'string') rawLine = body.raw;
  }
  if (logLine === null && rawLine === null) {
    return NextResponse.json({ error: 'no line payload' }, { status: 400 });
  }
  for (const v of [logLine, rawLine]) {
    if (v !== null && Buffer.byteLength(v) > MAX_LINE_BYTES) {
      return NextResponse.json({ error: 'line too large' }, { status: 413 });
    }
  }

  if (logLine !== null) publish(`${slug}:log`, logLine);
  if (rawLine !== null) publish(`${slug}:raw`, rawLine);

  return NextResponse.json({ ok: true });
}
