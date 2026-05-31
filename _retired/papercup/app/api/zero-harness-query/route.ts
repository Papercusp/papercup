/**
 * Zero query endpoint for the harness DB.
 *
 * `zero-cache-harness` calls this route to resolve a named query (e.g.
 * "projects.all") into a ZQL expression it can run against the SQLite
 * replica. Without this endpoint, useQuery returns 0 rows because
 * zero-cache has no idea what queries the client is allowed to run.
 *
 * Mirrors the pattern in apps/shop-api/src/zero/zero.controller.ts but
 * lives here as a plain Next.js route handler (no NestJS overhead).
 */
import { NextResponse } from 'next/server';

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

import { schema, queries } from '@papercusp/zero-harness';

export async function POST(req: Request) {
  const body = await req.json();
  const result = await handleQueryRequest(
    (name: string, args: any) => {
      const query = mustGetQuery(queries, name);
      return query.fn({ args, ctx: {} });
    },
    schema,
    body,
  );
  return NextResponse.json(result);
}
