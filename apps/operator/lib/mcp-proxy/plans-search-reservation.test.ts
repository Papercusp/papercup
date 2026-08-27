import { afterEach, describe, expect, it } from "vitest";
import http from "node:http";
import {
  createMcpProxy,
  isReservedControlPlaneCall,
  prepareForward,
  READ_ONLY_TOOLS,
} from "./proxy";

const servers: http.Server[] = [];

afterEach(() => {
  for (const server of servers) server.close();
  servers.length = 0;
});

function track<T extends http.Server>(server: T): T {
  servers.push(server);
  return server;
}

function listen(server: http.Server): Promise<http.Server> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function port(server: http.Server): number {
  return (server.address() as { port: number }).port;
}

function request(
  proxyPort: number,
  body: string,
  path: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port: proxyPort, method: "POST", path },
      (res) => {
        let responseBody = "";
        res.on("data", (chunk) => (responseBody += chunk));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, body: responseBody }),
        );
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

function waitFor(predicate: () => boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const check = (): void => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - startedAt > 2_000) {
        reject(new Error("timed out waiting for proxy fixture"));
        return;
      }
      setTimeout(check, 5);
    };
    check();
  });
}

const plansSearchBody = JSON.stringify({
  jsonrpc: "2.0",
  id: 2,
  method: "tools/call",
  params: {
    name: "plans:search",
    arguments: { query: "mcp proxy" },
  },
});

describe("EI-21552904300168447: plans:search proxy admission", () => {
  it("is classified as a reserved, read-only control-plane call", () => {
    const body = Buffer.from(plansSearchBody);

    expect(isReservedControlPlaneCall(body)).toBe(true);
    expect(READ_ONLY_TOOLS.has("plans:search")).toBe(true);
    expect(
      prepareForward("POST", {}, body, {
        keyingEnabled: true,
        genKey: () => "unused-key",
      }),
    ).toMatchObject({ klass: "readonly", body });
  });

  it("forwards while the ordinary admission partition is saturated", async () => {
    let releaseOrdinary: () => void = () => {};
    const ordinaryGate = new Promise<void>((resolve) => {
      releaseOrdinary = resolve;
    });
    let ordinaryStarted: () => void = () => {};
    const ordinaryStartedGate = new Promise<void>((resolve) => {
      ordinaryStarted = resolve;
    });
    const hits: string[] = [];
    const upstream = track(
      http.createServer((req, res) => {
        const client = new URL(
          req.url ?? "/",
          "http://127.0.0.1",
        ).searchParams.get("client");
        hits.push(client ?? "");
        if (client === "ordinary") {
          ordinaryStarted();
          void ordinaryGate.then(() => res.end('{"result":"ordinary"}'));
          return;
        }
        res.end('{"result":"plan"}');
      }),
    );
    await listen(upstream);

    const proxy = track(
      createMcpProxy({
        listenPort: 0,
        targetHost: "127.0.0.1",
        targetPort: port(upstream),
        retryWindowMs: 1_000,
        maxInFlight: 2,
        controlPlaneReserve: 1,
        log: () => {},
      }),
    );
    await listen(proxy);

    const ordinary = request(
      port(proxy),
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "work_items:list", arguments: {} },
      }),
      "/api/mcp?client=ordinary",
    );
    await ordinaryStartedGate;

    const plan = await request(
      port(proxy),
      plansSearchBody,
      "/api/mcp?client=plan-search",
    );
    expect(plan.status).toBe(200);
    expect(hits).toEqual(["ordinary", "plan-search"]);

    releaseOrdinary();
    expect((await ordinary).status).toBe(200);
  });
});
