/**
 * POST /api/agent-mcp/operator-dismissed
 *
 * Records a card-id as dismissed so the operator parser filters
 * re-emissions during the cooldown window.
 *
 * Ported from app/api/agent-mcp/operator-dismissed/route.ts — R1 pilot,
 * the typed-`input` case. The route had no auth; `auth: 'public'`
 * preserves that. (R5's auth-sensitive batch decides whether
 * dismissing a card should require an operator principal.)
 */
import { z } from 'zod';
import { recordDismissed } from '../../../operator-dismissed-cache';
import { defineTool } from '@papercusp/agent-mcp';

export default defineTool({
  method: 'POST',
  path: '/agent-mcp/operator-dismissed',
  auth: 'public',
  input: z.object({ id: z.string().min(1) }),
  async handler(_req, ctx) {
    await recordDismissed(ctx.input.id);
    return Response.json({ ok: true });
  },
});
