/**
 * POST /api/agent-config/test — fire a one-shot prompt at the active
 * backend to verify the CLI works. Returns { ok, finalText, durationMs,
 * backend, costUsd, error? }.
 *
 * Used by the Agent backend settings page to give the user a green
 * checkmark before committing to the chosen backend.
 */
import { NextResponse } from 'next/server';
import { runClaudeChat } from '@/lib/claude-chat-stream';

export const dynamic = 'force-dynamic';

export async function POST() {
  const started = Date.now();
  let finalText = '';
  let costUsd = 0;
  let errorMsg: string | undefined;

  let timedOut = false;
  try {
    const ac = new AbortController();
    // Bound the test — this is just a liveness check, not a real chat.
    const killer = setTimeout(() => { timedOut = true; ac.abort(); }, 30_000);
    try {
      for await (const ev of runClaudeChat({
        promptText: 'Reply with exactly the four characters: PONG',
        signal: ac.signal,
      })) {
        if (ev.type === 'delta') finalText += ev.text;
        else if (ev.type === 'result') {
          if (ev.finalText) finalText = ev.finalText;
          costUsd = ev.costUsd;
        } else if (ev.type === 'error') {
          errorMsg = `${ev.message}${ev.stderr ? `: ${ev.stderr.slice(0, 400)}` : ''}`;
        }
      }
    } finally {
      clearTimeout(killer);
    }
  } catch (err) {
    errorMsg = (err as Error).message;
  }
  if (timedOut && !errorMsg) {
    errorMsg = 'timed out after 30s — backend likely waiting on auth (run `claude /login` or `omp /login`, or set ANTHROPIC_API_KEY)';
  }
  if (!errorMsg && finalText.trim().length === 0) {
    errorMsg = 'backend exited cleanly but produced no output — check that the prompt reached the model (and that it has API access)';
  }

  const trimmed = finalText.trim();
  const ok = !errorMsg && trimmed.length > 0;
  return NextResponse.json({
    ok,
    finalText: trimmed,
    durationMs: Date.now() - started,
    costUsd,
    error: errorMsg ?? null,
  });
}
