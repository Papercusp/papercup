import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HOSTED_BROWSER_API_ALIAS_GLOBAL,
  HOSTED_BROWSER_API_GLOBAL,
  HOSTED_BROWSER_API_MARKER_VERSION,
  HOSTED_BROWSER_REST_ENDPOINT,
  HOSTED_BROWSER_SSE_ENDPOINT,
  HOSTED_WORKSPACE_SELECTION_ENDPOINT,
  HOSTED_WORKSPACE_HOST_ENDPOINTS,
  LOCAL_BROWSER_REST_ENDPOINT,
  LOCAL_WORKSPACE_HOST_ENDPOINTS,
  hostedBrowserApiMarker,
  bootstrapHostedWorkspaceSelection,
  readHostedBrowserApiMarker,
  resolveBrowserApiTransport,
} from "./hosted-browser-api";

const marker = hostedBrowserApiMarker("control-plane");

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("hosted workspace selection bootstrap", () => {
  it("does nothing for the local operator", async () => {
    vi.stubGlobal("window", {});
    const fetcher = vi.fn();

    await expect(bootstrapHostedWorkspaceSelection(fetcher)).resolves.toBe("not-hosted");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("selects the server-derived existing workspace before hosted sync starts", async () => {
    vi.stubGlobal("window", { [HOSTED_BROWSER_API_GLOBAL]: marker });
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ ok: true, workspaceId: "ws-1" }), { status: 200 }));

    await expect(bootstrapHostedWorkspaceSelection(fetcher)).resolves.toBe("selected");
    expect(fetcher).toHaveBeenCalledWith(HOSTED_WORKSPACE_SELECTION_ENDPOINT, {
      method: "POST",
      credentials: "same-origin",
      headers: { accept: "application/json" },
    });
  });

  it.each([
    [404, "no_workspace", "no-workspace"],
    [409, "workspace_already_selected", "already-selected"],
  ] as const)("treats %s %s as a non-blocking bootstrap state", async (status, error, result) => {
    vi.stubGlobal("window", { [HOSTED_BROWSER_API_GLOBAL]: marker });
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ ok: false, error }), { status }));

    await expect(bootstrapHostedWorkspaceSelection(fetcher)).resolves.toBe(result);
  });

  it("fails open for transport and unexpected server failures so the shell can render", async () => {
    vi.stubGlobal("window", { [HOSTED_BROWSER_API_GLOBAL]: marker });
    const fetcher = vi.fn(async () => { throw new Error("offline"); });

    await expect(bootstrapHostedWorkspaceSelection(fetcher)).resolves.toBe("unavailable");
  });
});

describe("hosted browser API marker", () => {
  it("builds the stable server/client contract and trims the workspace id", () => {
    expect(hostedBrowserApiMarker("  control-plane  ")).toEqual({
      version: HOSTED_BROWSER_API_MARKER_VERSION,
      controlPlaneWorkspaceId: "control-plane",
      restEndpoint: HOSTED_BROWSER_REST_ENDPOINT,
      sseEndpoint: HOSTED_BROWSER_SSE_ENDPOINT,
      workspaceHostEndpoints: HOSTED_WORKSPACE_HOST_ENDPOINTS,
    });
    expect(() => hostedBrowserApiMarker("   ")).toThrow(
      "hosted_browser_marker_requires_a_control_plane_workspace_id",
    );
  });

  it("uses the explicit local transport when no hosted marker is present", () => {
    vi.stubGlobal("window", {});
    expect(readHostedBrowserApiMarker()).toBeNull();
    expect(resolveBrowserApiTransport()).toEqual({
      mode: "local",
      restEndpoint: LOCAL_BROWSER_REST_ENDPOINT,
      workspaceHostEndpoints: LOCAL_WORKSPACE_HOST_ENDPOINTS,
    });
  });

  it("accepts the primary marker and its compatibility alias", () => {
    vi.stubGlobal("window", {
      [HOSTED_BROWSER_API_GLOBAL]: marker,
      [HOSTED_BROWSER_API_ALIAS_GLOBAL]: marker,
    });
    expect(readHostedBrowserApiMarker()).toEqual(marker);
    expect(resolveBrowserApiTransport()).toMatchObject({
      mode: "hosted",
      restEndpoint: HOSTED_BROWSER_REST_ENDPOINT,
      sseEndpoint: HOSTED_BROWSER_SSE_ENDPOINT,
      controlPlaneWorkspaceId: "control-plane",
    });
  });

  it.each([
    ["wrong version", { ...marker, version: 99 }],
    [
      "absolute REST URL",
      { ...marker, restEndpoint: "https://evil.example/rest" },
    ],
    ["wrong SSE path", { ...marker, sseEndpoint: "/api/zero-harness/sse" }],
    [
      "wrong mutation path",
      {
        ...marker,
        workspaceHostEndpoints: {
          ...marker.workspaceHostEndpoints,
          action: "/api/workspace-hosts/action",
        },
      },
    ],
  ])(
    "fails closed to the local transport for a malformed marker (%s)",
    (_label, malformed) => {
      vi.stubGlobal("window", { [HOSTED_BROWSER_API_GLOBAL]: malformed });
      expect(readHostedBrowserApiMarker()).toBeNull();
      expect(resolveBrowserApiTransport().mode).toBe("local");
    },
  );

  it("rejects disagreement between the primary marker and alias", () => {
    vi.stubGlobal("window", {
      [HOSTED_BROWSER_API_GLOBAL]: marker,
      [HOSTED_BROWSER_API_ALIAS_GLOBAL]: {
        ...marker,
        controlPlaneWorkspaceId: "other",
      },
    });
    expect(readHostedBrowserApiMarker()).toBeNull();
  });

  it("returns null during server rendering without touching browser globals", () => {
    vi.stubGlobal("window", undefined);
    expect(readHostedBrowserApiMarker()).toBeNull();
  });
});
