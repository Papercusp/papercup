/**
 * POST /api/user/memory/reembed
 *
 * Triggers a one-shot re-embed of every memory in the source mode's
 * collection into the target mode's collection. Called from the
 * /settings/user/memory page when the user switches
 * `memoryEmbedderMode` and wants to bring old memories forward.
 *
 * Body: { from: 'openai'|'local', to: 'openai'|'local' }
 *
 * Returns a single JSON result (not streamed). For 500-memory
 * collections this takes ~30-60s for OpenAI, ~2-5min for local.
 */

import { NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth';
import { reembedMemories } from '@/lib/memory/reembed';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 600;

const VALID_MODES = ['openai', 'local'] as const;
type Mode = (typeof VALID_MODES)[number];

function isMode(v: unknown): v is Mode {
  return typeof v === 'string' && (VALID_MODES as readonly string[]).includes(v);
}

export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  let body: { from?: unknown; to?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }
  if (!isMode(body.from) || !isMode(body.to)) {
    return NextResponse.json({ error: 'invalid_mode' }, { status: 400 });
  }
  if (body.from === body.to) {
    return NextResponse.json({ error: 'same_mode_noop' }, { status: 400 });
  }

  try {
    const result = await reembedMemories(body.from, body.to);
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    return NextResponse.json(
      { error: 'reembed_failed', message: (err as Error).message },
      { status: 500 },
    );
  }
}
