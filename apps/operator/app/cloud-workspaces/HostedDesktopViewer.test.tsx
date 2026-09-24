// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { HostedDesktopViewerMode } from "./hosted-desktop-viewer-protocol";

const H = vi.hoisted(() => {
  class FakeSocket {
    static OPEN = 1;
    static CLOSED = 3;
    static CONNECTING = 0;
    static CLOSING = 2;
    readyState = FakeSocket.OPEN;
    readonly listeners = new Map<string, Array<(event: unknown) => void>>();
    readonly sent: string[] = [];
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

    send(data: string): void {
      this.sent.push(data);
    }

    emit(type: string, event: unknown): void {
      for (const listener of this.listeners.get(type) ?? []) listener(event);
    }
  }

  class FakeRFB {
    static instances: FakeRFB[] = [];
    readonly listeners = new Map<string, () => void>();
    readonly disconnect = vi.fn();
    viewOnly = false;
    scaleViewport = false;
    clipViewport = false;
    resizeSession = true;
    focusOnClick = false;
    background = "";

    constructor(
      readonly element: unknown,
      readonly channel: unknown,
      readonly options: unknown,
    ) {
      FakeRFB.instances.push(this);
    }

    addEventListener(type: string, listener: () => void): void {
      this.listeners.set(type, listener);
    }

    emit(type: string): void {
      this.listeners.get(type)?.();
    }

    // The viewer subclasses noVNC to override this (kasmvnc-rfb.ts) and refuses a
    // class without it; the real override is tested against real noVNC there.
    _sendMouse(): void {}
  }

  return {
    FakeRFB,
    FakeSocket,
    fetch: vi.fn(),
    sockets: [] as FakeSocket[],
  };
});

vi.mock("@novnc/novnc", () => ({ default: H.FakeRFB }));

import { HostedDesktopViewer } from "./HostedDesktopViewer";

const TICKET = `ht_${"a".repeat(43)}`;

beforeEach(() => {
  H.sockets.length = 0;
  H.FakeRFB.instances.length = 0;
  H.fetch.mockReset().mockImplementation(() =>
    Promise.resolve(
      new Response(JSON.stringify({ ok: true, ticket: TICKET }), {
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

async function renderViewer(
  props: Partial<React.ComponentProps<typeof HostedDesktopViewer>> = {},
) {
  const onStateChange = vi.fn();
  const rendered = render(
    <HostedDesktopViewer
      workspaceId="customer-workspace-1"
      hostId="host-1"
      routeLabel="workspace-relay"
      desktopSessionId="desktop-1"
      onStateChange={onStateChange}
      {...props}
    />,
  );
  await waitFor(() => expect(H.sockets).toHaveLength(1));
  await waitFor(() => expect(H.FakeRFB.instances).toHaveLength(1));
  return {
    ...rendered,
    onStateChange,
    socket: H.sockets[0],
    rfb: H.FakeRFB.instances[0],
  };
}

describe("<HostedDesktopViewer>", () => {
  function ControlledViewer({
    initialMode = "watch",
  }: {
    initialMode?: HostedDesktopViewerMode;
  }) {
    const [mode, setMode] = useState(initialMode);
    return (
      <HostedDesktopViewer
        workspaceId="customer-workspace-1"
        hostId="host-1"
        routeLabel="workspace-relay"
        desktopSessionId="desktop-1"
        mode={mode}
        onModeChange={setMode}
      />
    );
  }

  function acceptConnection(index: number, mode: HostedDesktopViewerMode) {
    act(() => {
      H.sockets[index].emit("message", {
        data: JSON.stringify({
          type: "desktop.ready",
          action: mode,
          inputAllowed: mode === "takeover",
        }),
      });
      H.FakeRFB.instances[index].emit("connect");
    });
  }

  it("takes and releases control with fresh scoped connections while preserving the viewer element", async () => {
    render(<ControlledViewer />);
    await waitFor(() => expect(H.FakeRFB.instances).toHaveLength(1));
    const panel = screen.getByRole("region", { name: "Desktop viewer" });
    expect(
      (
        screen.getByRole("button", {
          name: "Take control",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    acceptConnection(0, "watch");
    fireEvent.click(screen.getByRole("button", { name: "Take control" }));
    await waitFor(() => expect(H.FakeRFB.instances).toHaveLength(2));
    expect(H.sockets[0].close).toHaveBeenCalledWith(1000, "viewer_detached");
    expect(H.sockets[1].url).toContain("desktopMode=takeover");
    expect(screen.getByRole("region", { name: "Desktop viewer" })).toBe(panel);
    acceptConnection(1, "takeover");
    expect(panel.getAttribute("data-input-allowed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Release control" }));
    expect(H.FakeRFB.instances[1].viewOnly).toBe(true);
    expect(H.sockets[1].close).toHaveBeenCalledWith(1000, "viewer_detached");
    await waitFor(() => expect(H.FakeRFB.instances).toHaveLength(3));
    expect(H.sockets[2].url).toContain("desktopMode=watch");
    expect(H.FakeRFB.instances[2].viewOnly).toBe(true);
    expect(H.fetch).toHaveBeenCalledTimes(3);
  });

  it("captures Escape before remote input, releases immediately, and restores focus to the control button", async () => {
    render(<ControlledViewer initialMode="takeover" />);
    await waitFor(() => expect(H.FakeRFB.instances).toHaveLength(1));
    acceptConnection(0, "takeover");
    const remoteKey = vi.fn();
    const panel = screen.getByRole("region", { name: "Desktop viewer" });
    panel.addEventListener("keydown", remoteKey);
    fireEvent.keyDown(panel, { key: "Escape" });
    expect(remoteKey).not.toHaveBeenCalled();
    expect(H.FakeRFB.instances[0].viewOnly).toBe(true);
    expect(H.sockets[0].close).toHaveBeenCalledWith(1000, "viewer_detached");
    await waitFor(() => expect(H.FakeRFB.instances).toHaveLength(2));
    expect(H.sockets[1].url).toContain("desktopMode=watch");
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Take control" }),
    );
  });

  it("allows release after a disconnected control stream and explains the connection loss", async () => {
    render(<ControlledViewer initialMode="takeover" />);
    await waitFor(() => expect(H.FakeRFB.instances).toHaveLength(1));
    acceptConnection(0, "takeover");
    act(() => H.sockets[0].emit("close", { code: 1006, reason: "" }));
    expect(
      screen.getByText(/Connection lost. Your workspace may still be running/),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Release control" }));
    await waitFor(() => expect(H.sockets).toHaveLength(2));
    expect(H.sockets[1].url).toContain("desktopMode=watch");
  });

  it("opens a separate desktop socket, honors desktop.ready input policy, and connects noVNC", async () => {
    const { socket, rfb } = await renderViewer({ mode: "takeover" });
    expect(socket.url).toBe(
      `ws://localhost:3000/api/hosted/connectors/socket?ticket=${TICKET}&kind=desktop&desktopSessionId=desktop-1&desktopMode=takeover`,
    );
    expect(rfb.viewOnly).toBe(false);
    expect(rfb.scaleViewport).toBe(true);

    act(() => {
      socket.emit("message", {
        data: JSON.stringify({
          type: "desktop.ready",
          action: "takeover",
          inputAllowed: true,
        }),
      });
      rfb.emit("connect");
    });
    expect(
      screen
        .getByRole("region", { name: /Desktop viewer/ })
        .getAttribute("data-input-allowed"),
    ).toBe("true");
    expect(screen.getByText("connected · takeover")).toBeTruthy();
  });

  it("keeps watch mode view-only even if the relay reports a permissive flag", async () => {
    const { socket, rfb } = await renderViewer({ mode: "watch" });
    act(() => {
      socket.emit("message", {
        data: JSON.stringify({
          type: "desktop.ready",
          action: "watch",
          inputAllowed: true,
        }),
      });
      rfb.emit("connect");
    });
    expect(rfb.viewOnly).toBe(true);
    expect(
      screen
        .getByRole("region", { name: /Desktop viewer/ })
        .getAttribute("data-input-allowed"),
    ).toBe("false");
    expect(screen.getByText(/Watch-only mode/)).toBeTruthy();
  });

  it("reconnects only the selected desktop stream and tears down the old socket", async () => {
    const { socket, rfb } = await renderViewer();
    act(() => {
      socket.emit("message", {
        data: JSON.stringify({
          type: "desktop.ready",
          action: "watch",
          inputAllowed: false,
        }),
      });
      rfb.emit("connect");
    });
    await waitFor(() =>
      expect(screen.getByText("connected · watch-only")).toBeTruthy(),
    );

    act(() => {
      screen.getByRole("button", { name: /Reconnect/ }).click();
    });
    await waitFor(() => expect(H.sockets).toHaveLength(2));
    expect(socket.close).toHaveBeenCalledWith(1000, "viewer_detached");
    expect(H.sockets[1].url).toContain("desktopSessionId=desktop-1");
  });

  it("fails closed on an action mismatch and keeps fullscreen explicitly unavailable", async () => {
    const { socket, rfb, onStateChange } = await renderViewer({
      mode: "takeover",
    });
    act(() => {
      socket.emit("message", {
        data: JSON.stringify({
          type: "desktop.ready",
          action: "watch",
          inputAllowed: false,
        }),
      });
    });
    await waitFor(() =>
      expect(
        screen
          .getByRole("region", { name: /Desktop viewer/ })
          .getAttribute("data-state"),
      ).toBe("error"),
    );
    expect(
      screen
        .getByRole("region", { name: /Desktop viewer/ })
        .getAttribute("data-state"),
    ).toBe("error");
    expect(onStateChange).toHaveBeenCalledWith("error");
    // noVNC owns the raw channel's close callback and reports the same
    // rejection as a disconnect; the protocol error must remain visible.
    act(() => rfb.emit("disconnect"));
    expect(
      screen
        .getByRole("region", { name: /Desktop viewer/ })
        .getAttribute("data-state"),
    ).toBe("error");
    const fullscreen = screen.getByRole("button", { name: /Fullscreen/ });
    expect((fullscreen as HTMLButtonElement).disabled).toBe(true);
  });
});
