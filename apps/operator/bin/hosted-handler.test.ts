import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { serve } from "@hono/node-server";
import { WebSocket } from "ws";
import type { AssembledHostedControlPlane } from "@papercusp/operator-core/lib/endpoint-route/hosted-control-plane";
import { HostedWorkspaceConnectorGateway } from "@papercusp/operator-core/lib/endpoint-route/hosted-workspace-connector";
import { createHostedHandler, readAttachRequest } from "./hosted-handler";

describe("readAttachRequest", () => {
  const read = (query: string) => readAttachRequest(new Request(`https://h.example/api/hosted/connectors/socket${query}`));
  it("reads the D-418 operator-http relay kind", () => {
    expect(read("?kind=operator-http")).toEqual({ kind: "operator-http" });
  });
  it("keeps an absent or unknown kind a PTY", () => {
    expect(read("")).toEqual({});
    expect(read("?kind=operator-admin")).toEqual({});
  });
  it("still reads desktop attachments", () => {
    expect(read("?kind=desktop&desktopSessionId=s1&desktopMode=takeover"))
      .toEqual({ kind: "desktop", desktopSessionId: "s1", desktopMode: "takeover" });
  });
});

const servers: Array<ReturnType<typeof serve>> = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))); });

function fixture(connectorGateway?: HostedWorkspaceConnectorGateway) {
  const api = new Hono().basePath("/api");
  api.get("/health", () => Response.json({ ok: true }));
  const plane = {
    app: api,
    mounted: [],
    components: connectorGateway ? { connectorGateway } : {},
  } as unknown as AssembledHostedControlPlane;
  const spa = new Hono();
  spa.get(
    "*",
    () =>
      new Response("<html>hosted-spa</html>", {
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
  );
  return createHostedHandler(plane, spa);
}

describe("hosted handler", () => {
  it("serves the hosted API and existing SPA from one origin", async () => {
    const hosted = fixture();
    const health = await hosted.handler(
      new Request("https://app.papercusp.com/api/health"),
    );
    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toEqual({ ok: true });

    const shell = await hosted.handler(
      new Request("https://app.papercusp.com/cloud-workspaces"),
    );
    expect(shell.status).toBe(200);
    await expect(shell.text()).resolves.toContain("hosted-spa");
  });

  it.each([
    ["POST", "/api/auth/login"],
    ["GET", "/api/agent-mcp/tools"],
    ["GET", "/api/files/read"],
    ["GET", "/api/pty"],
    ["GET", "/api/provision/status"],
    ["GET", "/internal/docs/secret"],
    ["GET", "/docs/operator"],
    ["GET", "/wiki"],
    ["GET", "/drizzle-studio"],
  ])("does not mount the local %s %s surface", async (method, pathname) => {
    const response = await fixture().handler(
      new Request(`https://app.papercusp.com${pathname}`, { method }),
    );
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("hosted-spa");
  });

  it("keeps an unknown API path out of the SPA fallback", async () => {
    const response = await fixture().handler(
      new Request("https://app.papercusp.com/api/not-mounted"),
    );
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("hosted-spa");
  });

  it("authenticates and binds a native WebSocket on the real HTTP upgrade transport", async () => {
    const binding = {
      controlPlaneWorkspaceId: "control",
      organizationId: "org-1",
      customerWorkspaceId: "workspace-1",
      hostId: "host-1",
      routeLabel: "alpha",
      generation: 4,
      transport: "websocket" as const,
      state: "active" as const,
    };
    const gateway = new HostedWorkspaceConnectorGateway({
      authenticate: async () => binding,
    } as never);
    const hosted = fixture(gateway);
    const server = serve({ fetch: hosted.handler, port: 0, hostname: "127.0.0.1" });
    servers.push(server);
    server.on("upgrade", (request, socket, head) => {
      void hosted.upgrade(request, socket, head).then((handled) => { if (!handled) socket.destroy(); });
    });
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind TCP");

    const bearer = `hc_${"A".repeat(43)}`;
    const websocket = new WebSocket(`ws://127.0.0.1:${address.port}/api/hosted/connectors/socket`, {
      headers: { authorization: `Bearer ${bearer}`, host: "alpha.workspaces.papercusp.com" },
    });
    const message = await new Promise<string>((resolve, reject) => {
      websocket.once("message", (value) => resolve(value.toString()));
      websocket.once("error", reject);
    });
    expect(JSON.parse(message)).toEqual(expect.objectContaining({
      type: "bound",
      role: "connector",
      protocol: "papercusp-hosted-workspace.v1",
      binding,
    }));
    await new Promise<void>((resolve) => {
      websocket.once("close", resolve);
      websocket.close();
    });
  });
});
