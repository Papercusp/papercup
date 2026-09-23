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
import { HOSTED_WORKSPACE_MAX_WHOLE_FILE_BYTES } from "./hosted-workspace-session-protocol";

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

/** Deterministic body bytes, so a wrong slice boundary cannot round-trip. */
function fakeBytes(length: number): Uint8Array {
  const body = new Uint8Array(length);
  for (let index = 0; index < length; index += 1) body[index] = index % 251;
  return body;
}

/**
 * A `File` double. The component reads only `name` and `arrayBuffer()`, and a
 * real jsdom `File` would make this test depend on Blob's stream support rather
 * than on the upload logic under test.
 */
function fakeFile(name: string, length: number): File {
  const body = fakeBytes(length);
  return {
    name,
    arrayBuffer: async () => body.buffer.slice(0, length),
  } as unknown as File;
}

async function connected() {
  fireEvent.click(screen.getByRole("button", { name: "Connect" }));
  await waitFor(() => expect(M.sockets.length).toBeGreaterThan(0));
  return M.sockets[M.sockets.length - 1];
}

/**
 * Host handshake. Omitting `limits` is how an older, non-chunking host looks.
 *
 * Awaits the rendered controller role before returning: `upload()` closes over
 * `role` and returns early while it is still null, so firing a file change
 * before React has re-rendered silently does nothing at all.
 */
async function ready(
  socket: { emit: (type: string, event: unknown) => void },
  limits?: { maxFileBytes: number; maxUploadChunkBytes: number },
) {
  socket.emit("message", {
    data: JSON.stringify({
      type: "pty.ready",
      role: "controller",
      resumed: false,
      ...(limits ? { limits } : {}),
    }),
  });
  await waitFor(() => {
    const status = screen.getByText("live", { exact: true }).parentElement;
    expect(status?.textContent).toContain("controller");
  });
}

describe("HostedWorkspaceSession", () => {
  it("surfaces relay send failures instead of claiming downloads or uploads started", async () => {
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

    fireEvent.change(screen.getByLabelText("Workspace file path"), {
      target: { value: "offline.txt" },
    });
    socket.send.mockClear();
    socket.readyState = M.FakeSocket.CLOSED;

    fireEvent.click(screen.getByRole("button", { name: /Download/ }));
    expect(
      screen.getByText(
        "Workspace relay unavailable; reconnect before downloading.",
      ),
    ).toBeTruthy();
    expect(socket.send).not.toHaveBeenCalled();

    const upload = new File([], "offline-upload.txt", { type: "text/plain" });
    fireEvent.change(screen.getByLabelText("Upload workspace file"), {
      target: { files: [upload] },
    });
    await waitFor(() =>
      expect(
        screen.getByText(
          "Workspace relay unavailable; reconnect before uploading.",
        ),
      ).toBeTruthy(),
    );
    expect(socket.send).not.toHaveBeenCalled();
    expect(
      screen.queryByText("Uploading offline.txt/offline-upload.txt…"),
    ).toBeNull();
  });

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

  /*
   * The relay's message listener is registered ONCE inside connect(), so every
   * frame is handled by whatever `handleMessage` existed at connect time. Any
   * state that handler reads through its closure — `path` in particular — is
   * frozen at its connect-time value unless it is mirrored into a ref. These
   * two pin the consequence rather than the mechanism: what the operator sees
   * after acting inside a subdirectory.
   */
  it("re-lists the directory the operator is in after an upload, not the root", async () => {
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

    /* Navigate out of the root, exactly as the file toolbar does. */
    fireEvent.change(screen.getByLabelText("Workspace file path"), {
      target: { value: "logs" },
    });
    socket.send.mockClear();

    /*
     * An upload result takes the catch-all branch of the file-result handler,
     * whose job is to refresh the listing. It must refresh the directory the
     * upload went into.
     */
    socket.emit("message", {
      data: JSON.stringify({
        type: "file.result",
        requestId: "upload-1",
        operation: "upload",
        path: "logs/notes.txt",
        bytes: 0,
      }),
    });

    await waitFor(() => expect(socket.send).toHaveBeenCalled());
    expect(
      JSON.parse(socket.send.mock.calls.at(-1)?.[0] as string),
    ).toMatchObject({ type: "file.list", path: "logs" });
  });

  it("keeps the operator in the directory they navigated to after an upload", async () => {
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

    const pathInput = screen.getByLabelText("Workspace file path");
    fireEvent.change(pathInput, { target: { value: "logs" } });
    socket.send.mockClear();

    socket.emit("message", {
      data: JSON.stringify({
        type: "file.result",
        requestId: "upload-2",
        operation: "upload",
        path: "logs/notes.txt",
        bytes: 0,
      }),
    });

    /*
     * Wait for the refresh to actually be issued FIRST. Asserting the input
     * directly would race: waitFor succeeds on its first attempt, which can run
     * before the buggy setPath(".") has flushed — so it passes while the defect
     * is present. Sequencing on the send makes the check deterministic, because
     * listFiles only calls setPath once the frame has gone out.
     */
    await waitFor(() => expect(socket.send).toHaveBeenCalled());
    expect((pathInput as HTMLInputElement).value).toBe("logs");
  });

  it("keeps the last confirmed directory after a failed list", async () => {
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

    const pathInput = screen.getByLabelText("Workspace file path");
    fireEvent.change(pathInput, { target: { value: "missing" } });
    socket.send.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "List" }));

    const listRequest = JSON.parse(
      socket.send.mock.calls.at(-1)?.[0] as string,
    ) as { requestId: string; path: string };
    expect(listRequest).toMatchObject({ type: "file.list", path: "missing" });

    socket.emit("message", {
      data: JSON.stringify({
        type: "operation.error",
        requestId: listRequest.requestId,
        operation: "list",
        code: "path_not_found",
      }),
    });

    await waitFor(() =>
      expect(screen.getByText("list failed: path_not_found")).toBeTruthy(),
    );
    expect((pathInput as HTMLInputElement).value).toBe(".");
  });

  it("starts the workspace desktop over the PTY channel only as the controller (D-405)", async () => {
    const onDesktopBridgeChange = vi.fn();
    const onDesktopStarted = vi.fn();
    const onDesktopQueryStateChange = vi.fn();
    render(
      <HostedWorkspaceSession
        hostId="host-1"
        routeLabel="workspace-relay"
        workspaceName="research-control"
        onDesktopBridgeChange={onDesktopBridgeChange}
        onDesktopStarted={onDesktopStarted}
        onDesktopQueryStateChange={onDesktopQueryStateChange}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(M.sockets).toHaveLength(1));
    const socket = M.sockets[0];
    socket.emit("message", {
      data: JSON.stringify({ type: "pty.ready", role: "observer", resumed: false }),
    });
    await waitFor(() => expect(onDesktopBridgeChange).toHaveBeenCalled());
    const bridge = onDesktopBridgeChange.mock.calls.at(-1)?.[0] as {
      requestStart: () => boolean;
    };
    const sentTypes = () =>
      socket.send.mock.calls.map(
        (call) => (JSON.parse(String(call[0])) as { type: string }).type,
      );

    // An observer never asks: the host would refuse it, and watching must not start a desktop.
    expect(bridge.requestStart()).toBe(false);
    expect(sentTypes()).not.toContain("desktop.start");

    socket.emit("message", {
      data: JSON.stringify({ type: "session.role", role: "controller" }),
    });
    await waitFor(() => expect(bridge.requestStart()).toBe(true));
    const startRequest = JSON.parse(
      socket.send.mock.calls.at(-1)?.[0] as string,
    ) as { type: string; requestId: string };
    expect(startRequest.type).toBe("desktop.start");
    expect(onDesktopQueryStateChange).toHaveBeenCalledWith("loading", "start");

    socket.emit("message", {
      data: JSON.stringify({
        type: "desktop.start.result",
        requestId: startRequest.requestId,
        desktop: { desktopSessionId: "desktop-new", state: "ready", displayNumber: 110 },
      }),
    });
    await waitFor(() =>
      expect(onDesktopStarted).toHaveBeenCalledWith({
        desktopSessionId: "desktop-new",
        state: "ready",
        displayNumber: 110,
      }),
    );
    expect(onDesktopQueryStateChange).toHaveBeenCalledWith("ready", "start");

    socket.emit("message", {
      data: JSON.stringify({
        type: "operation.error",
        requestId: "desktop-start-2",
        operation: "desktop.start",
        code: "desktop_start_failed",
      }),
    });
    await waitFor(() =>
      expect(onDesktopQueryStateChange).toHaveBeenCalledWith(
        "error",
        "start",
        "desktop_start_failed",
      ),
    );
  });

  it("uses the authenticated PTY channel for desktop roster and thumbnail discovery", async () => {
    const onWorkspaceIdChange = vi.fn();
    const onDesktopBridgeChange = vi.fn();
    const onDesktopRosterChange = vi.fn();
    const onDesktopThumbnailChange = vi.fn();
    render(
      <HostedWorkspaceSession
        hostId="host-1"
        routeLabel="workspace-relay"
        workspaceName="research-control"
        onWorkspaceIdChange={onWorkspaceIdChange}
        onDesktopBridgeChange={onDesktopBridgeChange}
        onDesktopRosterChange={onDesktopRosterChange}
        onDesktopThumbnailChange={onDesktopThumbnailChange}
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

    await waitFor(() =>
      expect(onWorkspaceIdChange).toHaveBeenCalledWith("ws-1"),
    );
    await waitFor(() => {
      const requests = socket.send.mock.calls.map((call) =>
        JSON.parse(String(call[0])),
      );
      expect(
        requests.some((request) => request.type === "desktop.roster"),
      ).toBe(true);
    });
    expect(onDesktopBridgeChange).toHaveBeenCalledWith(
      expect.objectContaining({
        requestRoster: expect.any(Function),
        requestThumbnail: expect.any(Function),
      }),
    );

    socket.emit("message", {
      data: JSON.stringify({
        type: "desktop.roster.result",
        requestId: "roster-1",
        desktops: [
          {
            desktopSessionId: "desktop-1",
            state: "ready",
            displayNumber: 2,
          },
        ],
      }),
    });
    await waitFor(() =>
      expect(onDesktopRosterChange).toHaveBeenCalledWith([
        {
          desktopSessionId: "desktop-1",
          state: "ready",
          displayNumber: 2,
        },
      ]),
    );

    const bridge = onDesktopBridgeChange.mock.calls.at(-1)?.[0] as {
      requestThumbnail: (desktopSessionId: string) => boolean;
    };
    expect(bridge.requestThumbnail("desktop-1")).toBe(true);
    const thumbnailRequest = JSON.parse(
      socket.send.mock.calls.at(-1)?.[0] as string,
    ) as { requestId: string };
    expect(thumbnailRequest).toMatchObject({
      type: "desktop.thumbnail",
      desktopSessionId: "desktop-1",
    });
    socket.emit("message", {
      data: JSON.stringify({
        type: "desktop.thumbnail.result",
        requestId: thumbnailRequest.requestId,
        desktopSessionId: "desktop-1",
        data: "AQI=",
        bytes: 2,
      }),
    });
    await waitFor(() =>
      expect(onDesktopThumbnailChange).toHaveBeenCalledWith({
        desktopSessionId: "desktop-1",
        data: "AQI=",
        bytes: 2,
      }),
    );
  });

  it("refuses an oversized upload to a host that never advertised chunking, instead of sending the frame that kills the session", async () => {
    render(
      <HostedWorkspaceSession
        hostId="host-1"
        routeLabel="workspace-relay"
        workspaceName="research-control"
      />,
    );
    const socket = await connected();
    /* No `limits` — an older host. The client must fall back to whole-file AND
     * decline anything too big for one frame. */
    await ready(socket);

    socket.send.mockClear();
    fireEvent.change(screen.getByLabelText("Upload workspace file"), {
      target: { files: [fakeFile("big.bin", HOSTED_WORKSPACE_MAX_WHOLE_FILE_BYTES + 1)] },
    });

    await waitFor(() =>
      expect(screen.getByText(/accepts at most/)).toBeTruthy(),
    );
    /* THE ASSERTION THIS TEST EXISTS FOR. The relay answers an over-cap frame by
     * CLOSING the socket, which takes the user's terminal down with the upload,
     * so "we sent it and showed an error" is not an acceptable outcome — the
     * frame must never leave the client. */
    expect(socket.send).not.toHaveBeenCalled();
  });

  it("chunks an upload against a chunk-capable host and paces each chunk on its ack", async () => {
    render(
      <HostedWorkspaceSession
        hostId="host-1"
        routeLabel="workspace-relay"
        workspaceName="research-control"
      />,
    );
    const socket = await connected();
    await ready(socket, { maxFileBytes: 1024, maxUploadChunkBytes: 4 });

    socket.send.mockClear();
    fireEvent.change(screen.getByLabelText("Upload workspace file"), {
      target: { files: [fakeFile("payload.bin", 10)] },
    });

    const uploads = () =>
      socket.send.mock.calls
        .map((call) => JSON.parse(call[0] as string) as Record<string, unknown>)
        .filter((frame) => frame.type === "file.upload");

    /* BACKPRESSURE: exactly one chunk is in flight before its ack. Without this
     * the client would push all three frames into the socket at once, which is
     * the head-of-line blocking chunking was introduced to remove. */
    await waitFor(() => expect(uploads()).toHaveLength(1));
    expect(uploads()).toHaveLength(1);

    const ack = (chunks: number) =>
      socket.emit("message", {
        data: JSON.stringify({
          type: "file.progress",
          requestId: (uploads()[0].requestId as string),
          uploadId: (uploads()[0].chunk as { uploadId: string }).uploadId,
          received: chunks * 4,
          chunks,
          count: 3,
        }),
      });

    ack(1);
    await waitFor(() => expect(uploads()).toHaveLength(2));
    ack(2);
    await waitFor(() => expect(uploads()).toHaveLength(3));

    const frames = uploads();
    expect(frames.map((frame) => (frame.chunk as { index: number }).index)).toEqual([0, 1, 2]);
    expect(
      frames.every((frame) => (frame.chunk as { count: number }).count === 3),
    ).toBe(true);
    /* Every chunk carries the SAME uploadId and requestId: the host keys its
     * accumulator on the former, and the browser matches the result on the latter. */
    expect(new Set(frames.map((frame) => (frame.chunk as { uploadId: string }).uploadId)).size).toBe(1);
    expect(new Set(frames.map((frame) => frame.requestId)).size).toBe(1);

    /* And the bytes survive the split — reassembled here exactly as the host
     * reassembles them, so a wrong slice boundary fails rather than round-trips. */
    const reassembled = Buffer.concat(
      frames.map((frame) => Buffer.from(frame.data as string, "base64")),
    );
    expect(reassembled).toEqual(Buffer.from(fakeBytes(10)));
  });

  it("stops a chunked upload when the relay drops mid-sequence, without stranding the armed ack", async () => {
    render(
      <HostedWorkspaceSession
        hostId="host-1"
        routeLabel="workspace-relay"
        workspaceName="research-control"
      />,
    );
    const socket = await connected();
    await ready(socket, { maxFileBytes: 1024, maxUploadChunkBytes: 4 });

    socket.send.mockClear();
    /* The socket goes away between chunks — the ordinary reconnect case, and
     * the path where an armed ack timer would otherwise outlive the upload and
     * reject with nobody awaiting it. */
    socket.readyState = 3;
    fireEvent.change(screen.getByLabelText("Upload workspace file"), {
      target: { files: [fakeFile("payload.bin", 10)] },
    });

    await waitFor(() =>
      expect(screen.getByText(/relay unavailable/i)).toBeTruthy(),
    );
    expect(socket.send).not.toHaveBeenCalled();
  });
});
