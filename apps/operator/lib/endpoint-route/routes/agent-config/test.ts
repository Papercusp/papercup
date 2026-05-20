/**
 * POST /api/agent-config/test
 *
 * Fires a one-shot prompt at the active backend to verify the CLI works.
 * Returns { ok, finalText, durationMs, costUsd, error? }.
 *
 * Ported from app/api/agent-config/test/route.ts. `auth: 'public'` —
 * preserves the original behavior. The 30s in-handler kill timer is kept
 * as-is (the route-stack's own timeout would also catch it, but the
 * handler wants its own clean "timed out — likely waiting on auth" msg).
 */
import { runAgentChat } from '@/lib/agent-chat-stream';
import { defineRoute } from '../../define-route';

export default defineRoute({
  method: 'POST',
  path: '/agent-config/test',
  auth: 'public',
  timeoutSec: 45, // handler self-bounds at 30s; give the route-stack headroom
  async handler() {
    const started = Date.now();
    let finalText = '';
    let costUsd = 0;
    let errorMsg: string | undefined;
    let timedOut = false;

    try {
      const ac = new AbortController();
      const killer = setTimeout(() => {
        timedOut = true;
        ac.abort();
      }, 30_000);
      try {
        for await (const ev of runAgentChat({
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
      errorMsg =
        'timed out after 30s — backend likely waiting on auth (run `claude /login` or `omp /login`, or set ANTHROPIC_API_KEY)';
    }
    if (!errorMsg && finalText.trim().length === 0) {
      errorMsg =
        'backend exited cleanly but produced no output — check that the prompt reached the model (and that it has API access)';
    }

    const trimmed = finalText.trim();
    return Response.json({
      ok: !errorMsg && trimmed.length > 0,
      finalText: trimmed,
      durationMs: Date.now() - started,
      costUsd,
      error: errorMsg ?? null,
    });
  },
});
