import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { AssembledHostedControlPlane } from "@papercusp/operator-core/lib/endpoint-route/hosted-control-plane";
import { createHostedHandler } from "./hosted-handler";

function fixture() {
  const api = new Hono().basePath("/api");
  api.get("/health", () => Response.json({ ok: true }));
  const plane = {
    app: api,
    mounted: [],
    components: {},
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
});
