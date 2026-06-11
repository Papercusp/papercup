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
import { readCredentials, writeCredentials, maskCredentials } from '../../../credentials';
import { requireAllowedOriginOr403 } from '../../cors';
import { defineTool } from '@papercusp/agent-mcp';

export default [
  defineTool({
    method: 'GET',
    path: '/credentials',
    // unverified-loopback: the desktop webview is cookie-less (EI-338) and
    // resolves as bare loopback; without it the API-keys settings page 403s.
    // Remote exposure stays blocked at boot (PAPERCUSP_BIND_HOST guard).
    auth: { trust: ['verified', 'trusted', 'unverified-loopback'] },
    async handler() {
      return Response.json(maskCredentials(await readCredentials()));
    },
  }),
  defineTool({
    method: 'POST',
    path: '/credentials',
    // unverified-loopback: the desktop webview is cookie-less (EI-338) and
    // resolves as bare loopback; without it the API-keys settings page 403s.
    // The cross-origin CSRF backstop the trust tier used to provide is restored
    // by requireAllowedOriginOr403 below (a foreign page can't write creds).
    auth: { trust: ['verified', 'trusted', 'unverified-loopback'] },
    async handler(req) {
      const csrf = requireAllowedOriginOr403(req);
      if (csrf) return csrf;
      const body = await req.json().catch(() => null);
      if (!body || typeof body !== 'object') {
        return Response.json({ error: 'invalid body' }, { status: 400 });
      }
      const existing = await readCredentials();
      const next = { ...existing };
      for (const k of ['anthropic_api_key', 'openai_api_key', 'zeroentropy_api_key', 'github_pat'] as const) {
        if (k in body) {
          const v = (body as Record<string, unknown>)[k];
          if (typeof v === 'string') next[k] = v.trim() || undefined;
        }
      }
      return Response.json(maskCredentials(await writeCredentials(next)));
    },
  }),
];
