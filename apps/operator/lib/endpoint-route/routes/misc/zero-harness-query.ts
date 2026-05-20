/**
 * POST /api/zero-harness-query — zero-cache-harness named-query resolver.
 *
 * Resolves named queries against the harness DB; ZQL evaluation
 * happens in zero-cache's SQLite replica.
 *
 * Ported from app/api/zero-harness-query/route.ts. `auth: 'public'`.
 */
import { defineRoute } from '../../define-route';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handleQueryRequest } = require('@rocicorp/zero/server') as {
  handleQueryRequest: (
    resolver: (name: string, args: any) => any,
    schema: any,
    request: any,
  ) => Promise<any>;
};

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { mustGetQuery } = require('@rocicorp/zero') as {
  mustGetQuery: (registry: any, name: string) => { fn: (ctx: any) => any };
};

import { schema, queries } from '@restart/zero-harness';

export default defineRoute({
  method: 'POST',
  path: '/zero-harness-query',
  auth: 'public',
  async handler(req) {
    const body = await req.json();
    const result = await handleQueryRequest(
      (name: string, args: any) => {
        const query = mustGetQuery(queries, name);
        return query.fn({ args, ctx: {} });
      },
      schema,
      body,
    );
    return Response.json(result);
  },
});
