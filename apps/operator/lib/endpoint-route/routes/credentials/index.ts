/**
 * GET / POST /api/credentials
 *
 * GET  — masked view of stored API credentials.
 * POST — set/clear credential fields (non-empty string sets, empty
 *        clears, absent leaves alone).
 *
 * Ported from app/api/credentials/route.ts. `auth: 'public'` preserves
 * the original (un-authed) behavior — see the R2-R6 report's decisions
 * log: tightening credential routes to a trusted principal is a
 * recommended follow-up, deliberately not folded into the mechanical port.
 */
import { readCredentials, writeCredentials, maskCredentials } from '@/lib/credentials';
import { defineRoute } from '../../define-route';

export default [
  defineRoute({
    method: 'GET',
    path: '/credentials',
    auth: 'public',
    async handler() {
      return Response.json(maskCredentials(await readCredentials()));
    },
  }),
  defineRoute({
    method: 'POST',
    path: '/credentials',
    auth: 'public',
    async handler(req) {
      const body = await req.json().catch(() => null);
      if (!body || typeof body !== 'object') {
        return Response.json({ error: 'invalid body' }, { status: 400 });
      }
      const existing = await readCredentials();
      const next = { ...existing };
      for (const k of ['anthropic_api_key', 'openai_api_key', 'github_pat'] as const) {
        if (k in body) {
          const v = (body as Record<string, unknown>)[k];
          if (typeof v === 'string') next[k] = v.trim() || undefined;
        }
      }
      return Response.json(maskCredentials(await writeCredentials(next)));
    },
  }),
];
