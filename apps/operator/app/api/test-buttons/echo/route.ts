/**
 * Demo endpoint backing the @scope/test-buttons plugin's buttons.
 * The substrate POSTs `{ harness, branch, button, runId, env }` here.
 * We echo back lines so the user can see the round-trip in their xterm.
 *
 * Migrated 2026-05-12 to @restart/sse's sseResponse. Wire shape gains
 * an `event: line\n` line per frame (was a bare `data:` frame, which
 * EventSource parses as the implicit `message` event). The forwarder
 * in branch-actions.ts:528 ignores event names and just writes the
 * data, so the change is invisible to log consumers.
 */
import { sseResponse } from '@restart/sse';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: Request) {
  const url = new URL(req.url);
  const branch = url.searchParams.get('branch') ?? '?';
  const body = await req.json().catch(() => ({}));

  return sseResponse({
    signal: req.signal,
    setup: async (sink) => {
      const send = (s: string) => sink.eventRaw('line', s);
      send(`[demo button] called for branch=${branch} harness=${body.harness} runId=${body.runId}`);
      await new Promise((r) => setTimeout(r, 300));
      send(`[demo button] received button name = ${body.button}`);
      await new Promise((r) => setTimeout(r, 300));
      send(`[demo button] env keys = ${Object.keys(body.env ?? {}).join(', ') || '(none)'}`);
      await new Promise((r) => setTimeout(r, 300));
      send(`[demo button] simulating work…`);
      await new Promise((r) => setTimeout(r, 800));
      send(`[demo button] done ✓`);
      sink.close();
    },
  });
}
