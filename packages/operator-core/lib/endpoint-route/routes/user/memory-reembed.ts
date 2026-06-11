/**
 * POST /api/user/memory/reembed
 *
 * One-shot re-embed of every memory in the source mode's collection
 * into the target mode's collection. Triggered by /settings/user/memory
 * when the user switches memoryEmbedderMode and wants to bring old
 * memories forward. ~30-60s for OpenAI, ~2-5min for local on a 500-mem
 * collection.
 *
 * Ported from app/api/user/memory/reembed/route.ts. `auth: 'loopback'` (auth-tier Wave 1),
 * `timeoutSec: 600` to match the Next maxDuration.
 */
import { getSessionUser } from '../../../auth';
import { reembedMemories } from '../../../memory/reembed';
import { defineTool } from '@papercusp/agent-mcp';

const VALID_MODES = ['openai', 'local'] as const;
type Mode = (typeof VALID_MODES)[number];

function isMode(v: unknown): v is Mode {
  return typeof v === 'string' && (VALID_MODES as readonly string[]).includes(v);
}

export default defineTool({
  method: 'POST',
  path: '/user/memory/reembed',
  auth: 'loopback',
  timeoutSec: 600,
  async handler(req) {
    const user = await getSessionUser(req.headers);
    if (!user) return Response.json({ error: 'unauthenticated' }, { status: 401 });

    let body: { from?: unknown; to?: unknown };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return Response.json({ error: 'invalid_json' }, { status: 400 });
    }
    if (!isMode(body.from) || !isMode(body.to)) {
      return Response.json({ error: 'invalid_mode' }, { status: 400 });
    }
    if (body.from === body.to) {
      return Response.json({ error: 'same_mode_noop' }, { status: 400 });
    }

    try {
      const result = await reembedMemories(body.from, body.to);
      return Response.json({ ok: true, ...result });
    } catch (err) {
      return Response.json(
        { error: 'reembed_failed', message: (err as Error).message },
        { status: 500 },
      );
    }
  },
});
