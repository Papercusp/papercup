/**
 * POST /api/plugins/host/query — read-only PG query for iframe plugin surfaces.
 * SELECT-only; search_path scoped to plugin_<name>.
 * Ported from app/api/plugins/host/query/route.ts. `auth: 'public'`.
 */
import { defineRoute } from '../../define-route';

interface ReqBody {
  pluginName: string;
  installSlug: string;
  query: string;
}

const SELECT_ONLY = /^\s*select\b/i;

export default defineRoute({
  method: 'POST',
  path: '/plugins/host/query',
  auth: 'public',
  async handler(req) {
    let body: ReqBody;
    try {
      body = (await req.json()) as ReqBody;
    } catch {
      return Response.json({ rows: [], error: 'invalid JSON' }, { status: 400 });
    }
    if (!body.pluginName || !body.installSlug || !body.query) {
      return Response.json(
        { rows: [], error: 'pluginName, installSlug, query required' },
        { status: 400 },
      );
    }
    if (!SELECT_ONLY.test(body.query)) {
      return Response.json(
        { rows: [], error: 'only SELECT queries are permitted via this endpoint' },
        { status: 400 },
      );
    }

    try {
      const { getOrgPg } = await import('@restart/db-org');
      const pg = await getOrgPg();
      const schema = `plugin_${body.pluginName.replace(/[^a-z0-9_]/gi, '_')}`;
      const limited = /\blimit\b/i.test(body.query) ? body.query : `${body.query.replace(/;\s*$/, '')} LIMIT 1000`;
      await pg.query(`SET LOCAL search_path = ${schema}, public`);
      const result = await pg.query(limited);
      return Response.json({ rows: result.rows ?? [] });
    } catch (e: unknown) {
      return Response.json(
        { rows: [], error: e instanceof Error ? e.message : String(e) },
        { status: 500 },
      );
    }
  },
});
