/**
 * Demo endpoint backing the @scope/test-buttons plugin's buttons.
 * The substrate POSTs `{ harness, branch, button, runId, env }` here.
 * We echo back lines so the user can see the round-trip in their xterm.
 */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: Request) {
  const url = new URL(req.url);
  const branch = url.searchParams.get('branch') ?? '?';
  const body = await req.json().catch(() => ({}));

  // Stream a few lines so the user sees the SSE path light up.
  const stream = new ReadableStream({
    async start(c) {
      const enc = new TextEncoder();
      const send = (s: string) => c.enqueue(enc.encode(`data: ${s}\n\n`));
      send(`[demo button] called for branch=${branch} harness=${body.harness} runId=${body.runId}`);
      await new Promise((r) => setTimeout(r, 300));
      send(`[demo button] received button name = ${body.button}`);
      await new Promise((r) => setTimeout(r, 300));
      send(`[demo button] env keys = ${Object.keys(body.env ?? {}).join(', ') || '(none)'}`);
      await new Promise((r) => setTimeout(r, 300));
      send(`[demo button] simulating work…`);
      await new Promise((r) => setTimeout(r, 800));
      send(`[demo button] done ✓`);
      c.close();
    },
  });
  return new Response(stream, {
    headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
  });
}
