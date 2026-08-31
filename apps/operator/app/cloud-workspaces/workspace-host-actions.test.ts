import { afterEach, describe, expect, it, vi } from "vitest";
import {
  workspaceHostActionRest,
  type WorkspaceHostActionArgs,
} from "./workspace-host-actions";
import { hostedBrowserApiMarker } from "../../lib/hosted-browser-api";

const lifecycleRequest: WorkspaceHostActionArgs = {
  action: "stop",
  workspaceId: "host-1",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("workspaceHostActionRest response contract", () => {
  it("accepts a literal boolean success envelope", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ ok: true, message: "accepted" }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(workspaceHostActionRest(lifecycleRequest)).resolves.toEqual({
      ok: true,
      message: "accepted",
    });
  });

  it.each([
    ["a string", { ok: "true", message: "accepted" }],
    ["a number", { ok: 1, message: "accepted" }],
    ["a null value", { ok: null, message: "accepted" }],
    ["an omitted flag", { message: "accepted" }],
  ])(
    "rejects a success envelope with %s instead of boolean true",
    async (_label, body) => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(body)));

      await expect(workspaceHostActionRest(lifecycleRequest)).rejects.toThrow(
        "Workspace-host action failed (200)",
      );
    },
  );

  it("preserves a structured API error when the boolean flag is false", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse({ ok: false, error: "connection is not ready" }, 409),
        ),
    );

    await expect(workspaceHostActionRest(lifecycleRequest)).rejects.toThrow(
      "connection is not ready",
    );
  });

  it("uses the authenticated hosted mutation endpoint when the shell advertises it", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ ok: true, message: "accepted" }));
    vi.stubGlobal("window", {
      __PAPERCUSP_HOSTED_BROWSER__: hostedBrowserApiMarker("control-plane"),
      __PAPERCUSP_HOSTED_BROWSER_API__: hostedBrowserApiMarker("control-plane"),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      workspaceHostActionRest(lifecycleRequest),
    ).resolves.toMatchObject({ ok: true });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/hosted/browser/workspace-hosts/action",
      expect.objectContaining({ method: "POST", credentials: "include" }),
    );
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(init.headers).get("x-papercusp-workspace")).toBe(
      "control-plane",
    );
  });

  it("falls back explicitly to the local endpoint when the hosted marker is invalid", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ ok: true, message: "accepted" }));
    vi.stubGlobal("window", {
      __PAPERCUSP_HOSTED_BROWSER__: {
        version: 1,
        restEndpoint: "https://evil.example",
      },
    });
    vi.stubGlobal("fetch", fetchMock);

    await workspaceHostActionRest(lifecycleRequest);

    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/workspace-hosts/action");
  });
});
