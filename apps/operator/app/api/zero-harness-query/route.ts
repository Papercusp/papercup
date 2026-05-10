/**
 * Zero query endpoint for the harness DB.
 *
 * `zero-cache-harness` calls this route to resolve a named query (e.g.
 * "harnessStatus.byHarness") into a ZQL expression it can run against
 * the SQLite replica. Without this endpoint, every WS query returns 0
 * rows because zero-cache has no idea what queries the client is
 * allowed to run.
 *
 * Why duplicated from apps/papercup/app/api/zero-harness-query:
 * the operator (this app, port 3055/3071) is the actual long-lived
 * server in dev and on the desktop. apps/papercup historically owned
 * this endpoint when it was the primary host, but its port (3061)
 * isn't always running. Pointing zero-cache's ZERO_QUERY_URL at the
 * operator means WS keeps working even when papercup is down.
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

import { schema, queries } from '@restart/zero-harness';

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
