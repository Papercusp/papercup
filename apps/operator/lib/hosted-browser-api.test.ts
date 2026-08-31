import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HOSTED_BROWSER_API_ALIAS_GLOBAL,
  HOSTED_BROWSER_API_GLOBAL,
  HOSTED_BROWSER_API_MARKER_VERSION,
  HOSTED_BROWSER_REST_ENDPOINT,
  HOSTED_BROWSER_SSE_ENDPOINT,
  HOSTED_WORKSPACE_HOST_ENDPOINTS,
  LOCAL_BROWSER_REST_ENDPOINT,
  LOCAL_WORKSPACE_HOST_ENDPOINTS,
  hostedBrowserApiMarker,
  readHostedBrowserApiMarker,
  resolveBrowserApiTransport,
} from "./hosted-browser-api";

const marker = hostedBrowserApiMarker("control-plane");

afterEach(() => {
  vi.unstubAllGlobals();
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
