// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

const M = vi.hoisted(() => {
  class FakeTerminal {
    cols = 120;
    rows = 32;
    dispose = vi.fn();
    loadAddon = vi.fn();
    open = vi.fn();
    write = vi.fn();
    writeln = vi.fn();
    getSelection = vi.fn(() => "");
    onData = vi.fn();

    constructor() {
      M.terminals.push(this);
    }
  }

  class FakeFitAddon {
    fit = vi.fn();
  }

  class FakeWebLinksAddon {
    constructor(_open: unknown) {}
  }

  class FakeSocket {
    static OPEN = 1;
    static CLOSED = 3;
    readyState = FakeSocket.OPEN;
    listeners = new Map<string, Array<(event: unknown) => void>>();
    send = vi.fn();
    close = vi.fn((code = 1000, reason = "") => {
      this.readyState = FakeSocket.CLOSED;
      this.emit("close", { code, reason });
    });

    constructor(readonly url: string) {
      M.sockets.push(this);
    }

    addEventListener(type: string, handler: (event: unknown) => void) {
      const handlers = this.listeners.get(type) ?? [];
      handlers.push(handler);
      this.listeners.set(type, handlers);
    }

    emit(type: string, event: unknown) {
      for (const handler of this.listeners.get(type) ?? []) handler(event);
    }
  }

  return {
    FakeFitAddon,
    FakeSocket,
    FakeTerminal,
    FakeWebLinksAddon,
    fetch: vi.fn(),
    sockets: [] as FakeSocket[],
    terminals: [] as FakeTerminal[],
  };
});

vi.mock("@xterm/xterm", () => ({ Terminal: M.FakeTerminal }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: M.FakeFitAddon }));
vi.mock("@xterm/addon-web-links", () => ({
  WebLinksAddon: M.FakeWebLinksAddon,
}));

import { HostedWorkspaceSession } from "./HostedWorkspaceSession";

const TICKET = `ht_${"a".repeat(43)}`;

beforeEach(() => {
  M.sockets.length = 0;
  M.terminals.length = 0;
  M.fetch.mockReset().mockImplementation((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/api/hosted/auth/session")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({ ok: true, session: { workspaceId: "ws-1" } }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      );
    }
    return Promise.resolve(
      new Response(JSON.stringify({ ok: true, ticket: TICKET }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  });
  vi.stubGlobal("fetch", M.fetch);
  vi.stubGlobal("WebSocket", M.FakeSocket);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("HostedWorkspaceSession", () => {
  it("round-trips zero-byte read, download, and upload payloads", async () => {
    const originalCreateObjectURL = URL.createObjectURL;
    const originalRevokeObjectURL = URL.revokeObjectURL;
    const createObjectURL = vi.fn((_blob: Blob) => "blob:empty-file");
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: createObjectURL,
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: revokeObjectURL,
    });
    const anchorClick = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => {});

    try {
      render(
        <HostedWorkspaceSession
          hostId="host-1"
          routeLabel="workspace-relay"
          workspaceName="research-control"
        />,
      );

      fireEvent.click(screen.getByRole("button", { name: "Connect" }));
      await waitFor(() => expect(M.sockets).toHaveLength(1));
      const socket = M.sockets[0];
      socket.emit("message", {
        data: JSON.stringify({
          type: "pty.ready",
          role: "controller",
          resumed: false,
        }),
      });
      await waitFor(() => {
        const status = screen.getByText("live", { exact: true }).parentElement;
        expect(status?.textContent).toContain("controller");
      });

      socket.emit("message", {
        data: JSON.stringify({
          type: "file.result",
          requestId: "list-empty-1",
          operation: "list",
          path: ".",
          entries: [{ name: "empty.txt", kind: "file", bytes: 0 }],
        }),
      });
      await waitFor(() =>
        expect(screen.getByRole("button", { name: /empty\.txt/ })).toBeTruthy(),
      );

      fireEvent.click(screen.getByRole("button", { name: /empty\.txt/ }));
      expect(
        JSON.parse(socket.send.mock.calls.at(-1)?.[0] as string),
      ).toMatchObject({
        type: "file.read",
        path: "empty.txt",
      });
      socket.emit("message", {
        data: JSON.stringify({
          type: "file.result",
          requestId: "read-empty-1",
          operation: "read",
          path: "empty.txt",
          bytes: 0,
          encoding: "base64",
          data: "",
        }),
      });
      await waitFor(() =>
        expect(screen.getByText("Read empty.txt.")).toBeTruthy(),
      );

      const pathInput = screen.getByLabelText("Workspace file path");
      fireEvent.change(pathInput, { target: { value: "empty.txt" } });
      fireEvent.click(screen.getByRole("button", { name: /Download/ }));
      expect(
        JSON.parse(socket.send.mock.calls.at(-1)?.[0] as string),
      ).toMatchObject({
        type: "file.download",
        path: "empty.txt",
      });
      socket.emit("message", {
        data: JSON.stringify({
          type: "file.result",
          requestId: "download-empty-1",
          operation: "download",
          path: "empty.txt",
          bytes: 0,
          encoding: "base64",
          data: "",
        }),
      });
      await waitFor(() =>
        expect(screen.getByText("Downloaded empty.txt.")).toBeTruthy(),
      );
      expect(createObjectURL).toHaveBeenCalledOnce();
      expect(createObjectURL.mock.calls[0][0]).toBeInstanceOf(Blob);
      expect((createObjectURL.mock.calls[0][0] as Blob).size).toBe(0);
      expect(anchorClick).toHaveBeenCalledOnce();
      expect(revokeObjectURL).toHaveBeenCalledWith("blob:empty-file");

      fireEvent.change(pathInput, { target: { value: "." } });
      const upload = new File([], "empty-upload.txt", { type: "text/plain" });
      fireEvent.change(screen.getByLabelText("Upload workspace file"), {
        target: { files: [upload] },
      });
      await waitFor(() =>
        expect(screen.getByText("Uploading empty-upload.txt…")).toBeTruthy(),
      );
      expect(
        JSON.parse(socket.send.mock.calls.at(-1)?.[0] as string),
      ).toMatchObject({
        type: "file.upload",
        path: "empty-upload.txt",
        encoding: "base64",
        data: "",
      });
    } finally {
      Object.defineProperty(URL, "createObjectURL", {
        configurable: true,
        value: originalCreateObjectURL,
      });
      Object.defineProperty(URL, "revokeObjectURL", {
        configurable: true,
        value: originalRevokeObjectURL,
      });
      anchorClick.mockRestore();
    }
  });

  it("ignores delayed frames from a superseded socket after reconnect", async () => {
    render(
      <HostedWorkspaceSession
        hostId="host-1"
        routeLabel="workspace-relay"
        workspaceName="research-control"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(M.sockets).toHaveLength(1));
    const firstSocket = M.sockets[0];
    firstSocket.emit("message", {
      data: JSON.stringify({
        type: "pty.ready",
        role: "controller",
        resumed: false,
      }),
    });
    await waitFor(() => {
      const status = screen.getByText("live", { exact: true }).parentElement;
      expect(status?.textContent).toContain("controller");
    });

    fireEvent.click(screen.getByRole("button", { name: "Detach" }));
    fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));
    await waitFor(() => expect(M.sockets).toHaveLength(2));
    const secondSocket = M.sockets[1];
    secondSocket.emit("message", {
      data: JSON.stringify({
        type: "pty.ready",
        role: "controller",
        resumed: true,
      }),
    });
    await waitFor(() => {
      const status = screen.getByText("live", { exact: true }).parentElement;
      expect(status?.textContent).toContain("controller");
    });

    firstSocket.emit("message", {
      data: JSON.stringify({ type: "session.role", role: "observer" }),
    });
    firstSocket.emit("message", {
      data: JSON.stringify({ type: "pty.exit", code: 1, signal: 15 }),
    });
    firstSocket.emit("error", {});
    firstSocket.emit("close", { code: 1006, reason: "stale" });

    const status = screen.getByText("live", { exact: true }).parentElement;
    expect(status?.textContent).toContain("controller");
    expect(screen.queryByText(/stale/)).toBeNull();
  });
});
