/** Restricted same-origin HTTP host for the hosted control-plane profile. */

import { Hono } from "hono";
import {
  createHostedRuntime,
  readHostedRuntimeConfiguration,
  type HostedRuntimeDependencies,
} from "@papercusp/operator-core/lib/endpoint-route/hosted-runtime";
import type { AssembledHostedControlPlane } from "@papercusp/operator-core/lib/endpoint-route/hosted-control-plane";
import { createSpaRoutes } from "./host-spa";
import { WebSocketServer } from "ws";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { authenticateHostedConnectorTransport } from "@papercusp/operator-core/lib/endpoint-route/routes/hosted-workspace-connector";

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
  readonly upgrade: (request: IncomingMessage, socket: Duplex, head: Buffer) => Promise<boolean>;
}

export function createHostedHandler(
  plane: AssembledHostedControlPlane,
  spa: Hono,
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

  const websocketServer = new WebSocketServer({ noServer: true });
  const gateway = plane.components.connectorGateway;

  return {
    plane,
    app,
    handler: async (request) => app.fetch(request),
    async upgrade(request, socket, head) {
      if (!gateway || request.url?.split("?")[0] !== "/api/hosted/connectors/socket") return false;
      const host = request.headers.host ?? "app.papercusp.com";
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(",") : value);
      const fetchRequest = new Request(`https://${host}${request.url}`, { headers });
      const binding = await authenticateHostedConnectorTransport(gateway, fetchRequest, "websocket");
      if (!binding) { socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n"); socket.destroy(); return true; }
      websocketServer.handleUpgrade(request, socket, head, (websocket) => {
        const untrack = gateway.track(binding, (reason) => websocket.close(4001, reason));
        websocket.once("close", untrack);
        websocket.send(JSON.stringify({ type: "bound", binding }));
        websocketServer.emit("connection", websocket, request);
      });
      return true;
    },
  };
}

export async function createHostedHandlerFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  dependencies: HostedRuntimeDependencies = {},
): Promise<HostedHandler> {
  const configuration = readHostedRuntimeConfiguration(env);
  const plane = await createHostedRuntime(configuration, dependencies);
  const spa = createSpaRoutes({
    kind: "hosted",
    controlPlaneWorkspaceId: configuration.controlPlaneWorkspaceId,
  });
  return createHostedHandler(plane, spa);
}
