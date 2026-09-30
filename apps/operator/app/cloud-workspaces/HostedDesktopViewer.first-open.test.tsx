// @vitest-environment jsdom

/*
 * WI-10004214: the first desktop a page opens used to hang on "Opening your
 * desktop…" until a full browser reload. The host answered in ~90ms (the
 * broker audited desktop.ready at 15:36:16.256 for a 15:36:15.951 ticket), but
 * the viewer only constructs noVNC after `await import("@novnc/novnc")`. On a
 * cold page that chunk is still downloading when KasmVNC's version greeting
 * arrives, and the relay channel dropped it; noVNC then waits for a greeting
 * that already came. This file holds the import open, as a cold chunk does.
 */

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { buildDesktopDataRelay } from "./hosted-desktop-viewer-protocol";

const H = vi.hoisted(() => {
  class FakeSocket {
    static OPEN = 1;
    static CLOSED = 3;
    static CONNECTING = 0;
    static CLOSING = 2;
    readyState = FakeSocket.OPEN;
    readonly listeners = new Map<string, Array<(event: unknown) => void>>();
    close = vi.fn((code = 1000, reason = "") => {
      this.readyState = FakeSocket.CLOSED;
      this.emit("close", { code, reason });
    });

    constructor(readonly url: string) {
      H.sockets.push(this);
    }

    addEventListener(type: string, listener: (event: unknown) => void): void {
      const current = this.listeners.get(type) ?? [];
      current.push(listener);
      this.listeners.set(type, current);
    }

    send(): void {}

    emit(type: string, event: unknown): void {
      for (const listener of this.listeners.get(type) ?? []) listener(event);
    }
  }

  type RawChannel = {
    readyState: number;
    onmessage: ((event: { data: ArrayBuffer }) => void) | null;
    onopen: (() => void) | null;
  };

  /** Attaches to the channel the way noVNC 1.7's RFB + Websock.attach() do. */
  class AttachingRFB {
    static instances: AttachingRFB[] = [];
    readonly listeners = new Map<string, () => void>();
    readonly disconnect = vi.fn();
    /** What reached the handshake, or "early" for bytes delivered before it began. */
    readonly received: string[] = [];
    handshake: "" | "ProtocolVersion" = "";
    viewOnly = false;
    scaleViewport = false;
    clipViewport = false;
    resizeSession = true;
    focusOnClick = false;
    background = "";

    constructor(_target: unknown, channel: RawChannel, _options: unknown) {
      AttachingRFB.instances.push(this);
      channel.onmessage = ({ data }) => {
        if (this.handshake !== "ProtocolVersion") {
          this.received.push("early");
          return;
        }
        this.received.push(new TextDecoder().decode(data));
        this.listeners.get("connect")?.();
      };
      channel.onopen = () => {
        this.handshake = "ProtocolVersion";
      };
      // rfb.js _connect(): an already-open channel starts the handshake at once.
      if (channel.readyState === 1) this.handshake = "ProtocolVersion";
    }

    addEventListener(type: string, listener: () => void): void {
      this.listeners.set(type, listener);
    }

    _sendMouse(): void {}
  }

  let releaseNoVnc = () => {};
  const noVncLoaded = new Promise<void>((resolve) => {
    releaseNoVnc = resolve;
  });

  return {
    AttachingRFB,
    FakeSocket,
    fetch: vi.fn(),
    sockets: [] as FakeSocket[],
    noVncLoaded,
    releaseNoVnc: () => releaseNoVnc(),
  };
});

vi.mock("@novnc/novnc", async () => {
  await H.noVncLoaded;
  return { default: H.AttachingRFB };
});

import { HostedDesktopViewer } from "./HostedDesktopViewer";

beforeEach(() => {
  H.fetch.mockImplementation(() =>
    Promise.resolve(
      new Response(JSON.stringify({ ok: true, ticket: `ht_${"a".repeat(43)}` }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ),
  );
  vi.stubGlobal("fetch", H.fetch);
  vi.stubGlobal("WebSocket", H.FakeSocket);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("connects when the desktop's greeting arrives before noVNC has loaded", async () => {
  const onStateChange = vi.fn();
  render(
    <HostedDesktopViewer
      workspaceId="customer-workspace-1"
      hostId="host-1"
      routeLabel="workspace-relay"
      desktopSessionId="desktop-1"
      onStateChange={onStateChange}
    />,
  );
  await waitFor(() => expect(H.sockets).toHaveLength(1));
  const socket = H.sockets[0]!;

  // The host answers while noVNC's chunk is still downloading.
  act(() => {
    socket.emit("message", {
      data: JSON.stringify({
        type: "desktop.ready",
        action: "watch",
        inputAllowed: false,
      }),
    });
    socket.emit("message", {
      data: buildDesktopDataRelay(new TextEncoder().encode("RFB 003.008\n")),
    });
  });
  expect(H.AttachingRFB.instances).toHaveLength(0);

  H.releaseNoVnc();
  await waitFor(() => expect(H.AttachingRFB.instances).toHaveLength(1));
  await waitFor(() =>
    expect(H.AttachingRFB.instances[0]!.received).toEqual(["RFB 003.008\n"]),
  );
  await waitFor(() =>
    expect(onStateChange).toHaveBeenLastCalledWith("connected"),
  );
});
