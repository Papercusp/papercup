/**
 * POST /api/elevenlabs/post-call
 *
 * ElevenLabs post-call webhook receiver.
 *
 * Two payload types we care about:
 *   - post_call_transcription: full conversation data (transcript, costs).
 *     We use it to mark the conversation 'done' and stamp ended_at.
 *   - post_call_audio: base64 MP3 of the call. We just flag has_audio=true
 *     and lazy-fetch via GET /v1/convai/conversations/{id}/audio when a UI
 *     surface needs the audio — base64-storing every call would balloon PG.
 *
 * Auth: HMAC-SHA256 on the raw body, ELEVENLABS_WEBHOOK_SECRET env var.
 * EL header format is "t=<unix_ts>,v0=<hex_sig>" (Stripe-style).
 *
 * Configure: ElevenLabs dashboard → Workspace settings → Webhooks. Point at
 * https://<your-host>/api/elevenlabs/post-call, copy the generated secret
 * into ELEVENLABS_WEBHOOK_SECRET. For local dev, expose via cloudflared or
 * ngrok — EL won't reach localhost.
 */

import { NextRequest, NextResponse } from 'next/server';
import crypto from 'node:crypto';
import { getOrgPg, generated } from '@restart/db-org';
import { eq } from 'drizzle-orm';
import { ensureOperatorConversationsTable } from '@/lib/ensure-schema';

const ot = generated.operator_turnsInHarness_shared;
const oc = generated.operator_conversationsInHarness_shared;

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const TIMESTAMP_TOLERANCE_MS = 5 * 60 * 1000; // 5 min

function verifySignature(rawBody: string, header: string | null, secret: string): boolean {
  if (!header) return false;
  const parts = Object.fromEntries(
    header.split(',').map((p) => {
      const [k, v] = p.split('=');
      return [k.trim(), v?.trim() ?? ''];
    }),
  );
  const tsStr = parts.t;
  const sig = parts.v0;
  if (!tsStr || !sig) return false;
  const tsMs = Number(tsStr) * 1000;
  if (!Number.isFinite(tsMs)) return false;
  if (Math.abs(Date.now() - tsMs) > TIMESTAMP_TOLERANCE_MS) return false;
  const signed = `${tsStr}.${rawBody}`;
  const expected = crypto.createHmac('sha256', secret).update(signed).digest('hex');
  // Constant-time compare
  if (sig.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(sig, 'utf8'), Buffer.from(expected, 'utf8'));
}

interface TranscriptionPayload {
  type: 'post_call_transcription';
  data: {
    conversation_id: string;
    status?: string;
    metadata?: { call_duration_secs?: number };
    has_audio?: boolean;
  };
}

interface AudioPayload {
  type: 'post_call_audio';
  data: { conversation_id: string };
}

interface FailurePayload {
  type: 'call_initiation_failure';
  data: { conversation_id: string; failure_reason: string };
}

type WebhookEvent = TranscriptionPayload | AudioPayload | FailurePayload | { type: string; data?: unknown };

export async function POST(req: NextRequest): Promise<Response> {
  const secret = process.env.ELEVENLABS_WEBHOOK_SECRET;
  const rawBody = await req.text();
  const sigHeader = req.headers.get('elevenlabs-signature');

  if (!secret) {
    console.error('[el-webhook] ELEVENLABS_WEBHOOK_SECRET not set — refusing to process');
    return NextResponse.json({ error: 'webhook secret not configured' }, { status: 503 });
  }
  if (!verifySignature(rawBody, sigHeader, secret)) {
    console.warn('[el-webhook] invalid signature');
    return NextResponse.json({ error: 'invalid signature' }, { status: 401 });
  }

  let event: WebhookEvent;
  try {
    event = JSON.parse(rawBody) as WebhookEvent;
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }

  await ensureOperatorConversationsTable();
  const { db, sql } = getOrgPg();

  // Locate our conversation row via any operator_turn carrying this el_conv_id.
  const elConvId =
    (event as TranscriptionPayload).data?.conversation_id ?? null;

  if (!elConvId) {
    return NextResponse.json({ received: true, note: 'no conversation_id' });
  }

  const found = await db
    .selectDistinct({ conversation_id: ot.conversation_id })
    .from(ot)
    .where(eq(ot.el_conv_id, elConvId))
    .limit(1);

  if (found.length === 0) {
    // Not ours, or no turns landed (call ended before any utterance).
    return NextResponse.json({ received: true, note: 'no matching conversation' });
  }
  const ourId = found[0].conversation_id;

  if (event.type === 'post_call_transcription') {
    const data = (event as TranscriptionPayload).data;
    // Array-append-if-missing + COALESCE merge — kept raw because drizzle's
    // .set() can't cleanly express array_append + ANY() + CASE in one go.
    await sql`
      UPDATE harness_shared.operator_conversations
         SET ended_at = COALESCE(ended_at, ${Date.now()}),
             el_conversation_ids =
               CASE WHEN ${elConvId} = ANY(el_conversation_ids)
                    THEN el_conversation_ids
                    ELSE array_append(el_conversation_ids, ${elConvId})
               END,
             has_audio = COALESCE(${data.has_audio ?? null}::boolean, has_audio)
       WHERE id = ${ourId}
    `;
  } else if (event.type === 'post_call_audio') {
    await db.update(oc).set({ has_audio: true }).where(eq(oc.id, ourId));
  }
  // call_initiation_failure: nothing to reconcile — the conversation
  // never produced turns. Just ack.

  return NextResponse.json({ received: true });
}
