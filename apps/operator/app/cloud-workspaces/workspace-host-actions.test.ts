import { afterEach, describe, expect, it, vi } from "vitest";
import {
  workspaceHostActionRest,
  type WorkspaceHostActionArgs,
} from "./workspace-host-actions";

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
});
