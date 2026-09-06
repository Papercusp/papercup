import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";

const PROXY = resolve(__dirname, "../systemd/papercusp-cloud-portal-proxy.mjs");

async function listen(server: Server, port = 0): Promise<number> {
  server.listen(port, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not expose a TCP address");
  return address.port;
}

async function close(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolveClose, reject) => {
    server.close((error) => (error ? reject(error) : resolveClose()));
  });
}

async function reservePort(): Promise<number> {
  const server = createServer();
  const port = await listen(server);
  await close(server);
  return port;
}

const delay = (ms: number) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));

describe("Cloud Portal stable front-door proxy", () => {
  it("holds a safe GET through a bounded backend handoff instead of surfacing 502", async () => {
    const targetPort = await reservePort();
    const upstream = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end("event: ready\ndata: ok\n\n");
    });
    const { createPortalProxy } = await import(`${pathToFileURL(PROXY).href}?get-retry`);
    const proxy: Server = createPortalProxy({ targetPort, retryWindowMs: 1_500, retryDelayMs: 20 });
    const proxyPort = await listen(proxy);

    try {
      const responsePromise = fetch(`http://127.0.0.1:${proxyPort}/api/operator-sync/sse`);
      await delay(100);
      await listen(upstream, targetPort);
      const response = await responsePromise;
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("event: ready");
    } finally {
      await close(proxy);
      await close(upstream);
    }
  });

  it("does not replay a state-changing request when the backend is unavailable", async () => {
    const targetPort = await reservePort();
    const { createPortalProxy } = await import(`${pathToFileURL(PROXY).href}?post-no-retry`);
    const proxy: Server = createPortalProxy({ targetPort, retryWindowMs: 1_000, retryDelayMs: 20 });
    const proxyPort = await listen(proxy);
    const startedAt = Date.now();
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const response = await fetch(`http://127.0.0.1:${proxyPort}/api/write`, {
        method: "POST",
        body: "payload",
      });
      expect(response.status).toBe(502);
      expect(await response.text()).toContain("upstream unavailable");
      expect(Date.now() - startedAt).toBeLessThan(500);
      expect(errorLog).toHaveBeenCalledTimes(1);
    } finally {
      errorLog.mockRestore();
      await close(proxy);
    }
  });
});
