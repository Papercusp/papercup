/**
 * POST /api/operator/conversations/:id/silence-nudge
 *
 * Synthetic Ready card emitted by the conversation provider's 30 s
 * silence-after-question timer. Bypasses the LLM entirely — the
 * brain is unreliable at calling chat:ask_choice for this trigger,
 * and the silence nudge is deterministic UI for a deterministic
 * event. Plan: silence-nudge-reliability-2026-05-14.md.
 *
 * Auth: session cookie required (401 if missing).
 * Rate limit: shared with /card-response (30 RPS per session user.id).
 *
 * Body:
 *   { workspaceId: string;
 *     voiceActive: boolean;    // shapes fallbackText (announcer)
 *     wakeword?: string;       // shapes fallbackText when voice+wake-word
 *   }
 *
 * Returns:
 *   { correlationId: string; runId: string }
 *
 * The card is registered on the state channel under a synthetic
 * runId so the chat surface's existing subscribeWorkspace flow
 * picks it up automatically. The card stays open until:
 *   - /card-response submit/decline/cancel resolves it
 *   - 120 s spec.timeoutMs fires (server-side abandon)
 *   - workspace switch
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { openRun, registerCard } from '@papercusp/agent-mcp';

import { getSessionUser } from '@/lib/auth';
import { cardResponseRateAllow } from '@/lib/card-response-rate-limit';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface Body {
  workspaceId: string;
  voiceActive: boolean;
  wakeword?: string;
}

const READY_OPTION = { id: 'ready', label: 'Ready' } as const;

function buildFallbackText(voiceActive: boolean, wakeword: string | undefined): string {
  if (!voiceActive) {
    return 'Click Ready when you want to continue.';
  }
  const phrase = (wakeword ?? '').trim() || 'ready';
  return `When you're ready, click Ready or say ${phrase}.`;
}

export async function POST(
  _req: NextRequest,
  _ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  // 1. Session-cookie auth.
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  // 2. Parse + validate body.
  const body = (await _req.json().catch(() => null)) as Body | null;
  if (
    !body ||
    typeof body.workspaceId !== 'string' ||
    body.workspaceId.length === 0 ||
    typeof body.voiceActive !== 'boolean' ||
    (body.wakeword !== undefined && typeof body.wakeword !== 'string')
  ) {
    return NextResponse.json(
      { error: 'workspaceId (string), voiceActive (bool) required; wakeword optional string' },
      { status: 400 },
    );
  }

  // 3. Rate limit — shared with /card-response since both routes
  //    spend the same card-correlator budget. Keyed on user.id.
  if (!cardResponseRateAllow(user.id)) {
    return NextResponse.json(
      { error: 'rate limit: 30 RPS per user' },
      { status: 429 },
    );
  }

  // 4. Open a synthetic run + register the card.
  //
  // The runId is synthetic — there's no actual tool invocation. Format:
  // 'silence-nudge-<random>'. The chat-surface state-snapshot stream
  // subscribes by workspace, not by runId, so the card surfaces just
  // like any other ctx.askUser card.
  const runId = `silence-nudge-${crypto.randomUUID()}`;
  openRun({ workspaceId: body.workspaceId, runId });

  // Server-side timeout: 120 s. If the user never interacts, the
  // card auto-cancels and the chat surface drops it. Same behavior
  // as bespoke chat:ask_choice cards today.
  const timeoutMs = 120_000;

  const fallbackText = buildFallbackText(body.voiceActive, body.wakeword);

  const { correlationId } = registerCard({
    workspaceId: body.workspaceId,
    runId,
    spec: {
      prompt: 'Ready when you are.',
      dataSchema: z.object({
        picks: z.tuple([z.enum([READY_OPTION.id])]),
      }),
      presentation: {
        kind: 'radio',
        options: [READY_OPTION],
        voiceAnswerable: true,
      },
      fallbackText,
      allowDecline: false,
      timeoutMs,
    },
  });

  // The deferred from registerCard is not awaited here — the route
  // returns immediately so the client can render. The deferred
  // resolves when the user POSTs /card-response (or the 120 s
  // timeout fires); either way the chat-surface SSE notices via
  // the state-channel update.

  return NextResponse.json({ correlationId, runId });
}
