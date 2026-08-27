/** Restricted same-origin HTTP host for the hosted control-plane profile. */

import { Hono } from "hono";
import {
  createHostedRuntime,
  readHostedRuntimeConfiguration,
  type HostedRuntimeDependencies,
} from "@papercusp/operator-core/lib/endpoint-route/hosted-runtime";
import type { AssembledHostedControlPlane } from "@papercusp/operator-core/lib/endpoint-route/hosted-control-plane";
import { spaRoutes } from "./host-spa";

/** Local server-rendered namespaces that must never become SPA-looking 200s. */
export const HOSTED_FORBIDDEN_HOST_PATH_PREFIXES = [
  "/internal/docs",
  "/docs",
  "/wiki",
  "/drizzle-studio",
] as const;

export interface HostedHandler {
  readonly plane: AssembledHostedControlPlane;
  readonly app: Hono;
  readonly handler: (request: Request) => Promise<Response>;
}

export function createHostedHandler(
  plane: AssembledHostedControlPlane,
  spa: Hono = spaRoutes,
): HostedHandler {
  const app = new Hono();

  // `/api/*` terminates at the audited hosted plane. A miss stays a JSON/HTTP
  // 404 and can never fall through to the SPA shell.
  app.all("/api/*", (context) => plane.app.fetch(context.req.raw));

  // These namespaces belong to the local host's docs/page renderers. Explicit
  // 404s make their absence observable instead of returning the SPA shell.
  for (const prefix of HOSTED_FORBIDDEN_HOST_PATH_PREFIXES) {
    app.all(prefix, () => new Response("Not found", { status: 404 }));
    app.all(`${prefix}/*`, () => new Response("Not found", { status: 404 }));
  }

  // The existing operator SPA is served from the same origin, last. No local
  // host-handler, proxy, docs, process, repository, file, or PTY graph is
  // imported into this module.
  app.route("/", spa);

  return {
    plane,
    app,
    handler: async (request) => app.fetch(request),
  };
}

export async function createHostedHandlerFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  dependencies: HostedRuntimeDependencies = {},
): Promise<HostedHandler> {
  const plane = await createHostedRuntime(
    readHostedRuntimeConfiguration(env),
    dependencies,
  );
  return createHostedHandler(plane);
}
