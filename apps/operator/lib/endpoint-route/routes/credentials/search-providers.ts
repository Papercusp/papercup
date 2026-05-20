/**
 * GET / POST /api/credentials/search-providers
 *
 * GET  — masked view of configured search-provider keys.
 * POST — write env-var values; body `{ values: { ENV_VAR: string|null } }`.
 *
 * Ported from app/api/credentials/search-providers/route.ts.
 * `auth: 'public'` preserves original behavior.
 */
import { readMaskedView, writeSearchProviderCredentials } from '@/lib/search-provider-credentials';
import { defineRoute } from '../../define-route';

export default [
  defineRoute({
    method: 'GET',
    path: '/credentials/search-providers',
    auth: 'public',
    async handler() {
      return Response.json(await readMaskedView());
    },
  }),
  defineRoute({
    method: 'POST',
    path: '/credentials/search-providers',
    auth: 'public',
    async handler(req) {
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return Response.json({ error: 'invalid JSON body' }, { status: 400 });
      }
      const values = (body as { values?: Record<string, string | null> } | null)?.values;
      if (!values || typeof values !== 'object') {
        return Response.json(
          { error: 'expected { values: { ENV_VAR_NAME: string | null, ... } }' },
          { status: 400 },
        );
      }
      const cleaned: Record<string, string | null> = {};
      for (const [k, v] of Object.entries(values)) {
        if (!/^[A-Z][A-Z0-9_]*$/.test(k)) continue;
        if (v === null) cleaned[k] = null;
        else if (typeof v === 'string') cleaned[k] = v;
      }
      await writeSearchProviderCredentials(cleaned);
      return Response.json(await readMaskedView());
    },
  }),
];
