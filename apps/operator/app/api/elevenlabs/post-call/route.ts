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
import { activeWorkspaceId } from '@/lib/workspace-registry';

const ot = generated.operatorTurnsInHarnessShared;
const oc = generated.operatorConversationsInHarnessShared;

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
    agent_id?: string;
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
    .selectDistinct({ conversation_id: ot.conversationId })
    .from(ot)
    .where(eq(ot.elConvId, elConvId))
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

    // Record EL Conv-AI call duration into harness_shared.el_conv_calls
    // — the spend-cap table that `/api/agent-mcp/operator-el-spend` reads
    // for the monthly minute cap check at session-start. Without this
    // insert, the cap is decorative (every call reads as 0 minutes used
    // and the over_cap branch never fires).
    //
    // ON CONFLICT (conversation_id) DO NOTHING handles webhook retries
    // gracefully — EL may deliver the post_call_transcription event
    // more than once for the same call.
    //
    // Duration resolution (defensive — EL's call_duration_secs has
    // historically been reliable but we shouldn't silently lose
    // metering if the field ever disappears or arrives malformed):
    //   1. metadata.call_duration_secs (primary)
    //   2. Estimate from our own operator_turns timestamps for this
    //      conversation (oldest user turn → ended_at). Less precise
    //      but bounds the lower edge so the cap still partially fires.
    //   3. Log + insert a 0-row marker so a manual audit can see the
    //      call happened but we couldn't measure it.
    let durationSecs = Number(data.metadata?.call_duration_secs ?? 0);
    let durationSource: 'webhook' | 'estimated' | 'unknown' = 'webhook';
    if (!Number.isFinite(durationSecs) || durationSecs <= 0) {
      // Fallback: estimate from PG. minutes_used returned by
      // /operator-el-spend will be a floor of actual usage, but better
      // than zero.
      try {
        const rows = await sql`
          SELECT
            EXTRACT(EPOCH FROM (
              COALESCE(MAX(created_at), now()) - COALESCE(MIN(created_at), now())
            ))::int AS span_secs
          FROM harness_shared.operator_turns
          WHERE conversation_id = ${ourId}
            AND el_conv_id = ${elConvId}
        `;
        const span = Number(rows?.[0]?.span_secs ?? 0);
        if (Number.isFinite(span) && span > 0) {
          durationSecs = span;
          durationSource = 'estimated';
        }
      } catch { /* keep durationSecs = 0 */ }
    }
    const workspaceId = activeWorkspaceId();
    try {
      await sql`
        INSERT INTO harness_shared.el_conv_calls
          (conversation_id, agent_id, workspace, duration_secs)
        VALUES (${elConvId}, ${data.agent_id ?? null}, ${workspaceId}, ${Math.max(0, durationSecs)})
        ON CONFLICT (conversation_id) DO NOTHING
      `;
      if (durationSource !== 'webhook') {
        console.warn(
          `[el-post-call] call_duration_secs missing/zero for ${elConvId}; ` +
          `wrote duration=${durationSecs}s from ${durationSource} source. ` +
          `Cap accounting may be inexact for this call — monitor if this becomes frequent.`,
        );
      }
    } catch (err) {
      // Don't fail the webhook on metering insert errors — the
      // conversation-write above already succeeded. Log + move on.
      console.warn('[el-post-call] el_conv_calls insert failed', err);
    }
  } else if (event.type === 'post_call_audio') {
    await db.update(oc).set({ hasAudio: true }).where(eq(oc.id, ourId));
  }
  // call_initiation_failure: nothing to reconcile — the conversation
  // never produced turns. Just ack.

  return NextResponse.json({ received: true });
}
