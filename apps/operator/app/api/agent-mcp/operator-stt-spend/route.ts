/**
 * STT spend tracker — GET state, POST minutes used.
 *
 * Browser capture loops (Deepgram WebSocket) post their session
 * duration on stop or on a heartbeat tick. Server records and returns
 * cap-trip signals so the chrome can mirror the TTS soft-cap toast +
 * hard-cap engine cut-off.
 */

import { NextRequest } from 'next/server';
import {
  loadSttSpend,
  recordSttSpend,
  saveSttSpend,
  DEFAULT_STT_SPEND_STATE,
  type SttSpendState,
} from '@/lib/stt-spend';

export const dynamic = 'force-dynamic';

export async function GET() {
  return Response.json(await loadSttSpend());
}

export async function POST(req: NextRequest) {
  let body: { minutes?: unknown } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return new Response('bad-json', { status: 400 });
  }
  const m = Number(body.minutes);
  if (!Number.isFinite(m) || m < 0 || m > 60) {
    return new Response('bad-minutes', { status: 400 });
  }
  const update = await recordSttSpend(m);
  return Response.json({
    todayUsd: update.todayUsd,
    fireSoftCap: update.fireSoftCap,
    hardCapTripped: update.hardCapTripped,
  });
}

export async function PUT(req: NextRequest) {
  let body: Partial<SttSpendState> = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return new Response('bad-json', { status: 400 });
  }
  const cur = await loadSttSpend();
  const next: SttSpendState = {
    ...DEFAULT_STT_SPEND_STATE,
    ...cur,
    ...body,
    spend: cur.spend,
  };
  await saveSttSpend(next);
  return Response.json(next);
}
