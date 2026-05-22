/**
 * POST /api/agent-config/test
 *
 * Fires a one-shot PONG prompt at the Meridian router to verify the
 * stateless LLM path works (auth token + reachability). Returns
 * { ok, finalText, durationMs, costUsd, error? }.
 *
 * NOTE: this probes the **meridian** backend specifically, not the
 * user-configured omp/claude-code CLI subprocess. Meridian is what
 * llm-testing + haiku + most non-MCP-bearing callers go through; the
 * subprocess CLIs are still used for agent-loop turns (operator brain,
 * oracle, delegate, scan, plans), and those validate themselves the
 * first time they run. A "Meridian unreachable" failure here means the
 * background summary path is broken; the brain may still work.
 */
import { runAgentChat } from '@/lib/agent-chat-stream';
import { defineTool } from '@papercusp/agent-mcp';

const TEST_MODEL = process.env.PAPERCUSP_AGENT_TEST_MODEL ?? 'claude-haiku-4-5';

export default defineTool({
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
          backend: 'meridian',
          model: TEST_MODEL,
          promptText: 'Reply with exactly the four characters: PONG',
          maxTokens: 16,
          signal: ac.signal,
        })) {
          if (ev.type === 'delta') finalText = ev.text;
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
        'timed out after 30s — Meridian likely unreachable or unauthenticated (run `omp` once, or check ~/.omp/agent/auth.json)';
    }
    if (!errorMsg && finalText.trim().length === 0) {
      errorMsg =
        'meridian returned cleanly but produced no output — check that the model is available in Meridian routing';
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
