// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const EMPTY_SYNC_DATA: unknown[] = [];
const EMPTY_CARDS: unknown[] = [];
const SYNC = vi.hoisted(() => ({
  turnPage: null as null | { turns: unknown[]; hasMoreEarlier: boolean },
}));

vi.mock("@papercusp/sync", () => ({
  useSyncQuery: (input: { queryName?: string; enabled?: boolean }) => ({
    data:
      input.queryName === "operatorTurns.page" &&
      input.enabled !== false &&
      SYNC.turnPage
        ? [SYNC.turnPage]
        : EMPTY_SYNC_DATA,
  }),
}));

vi.mock("@/lib/use-workspace-id", () => ({
  useWorkspaceId: () => "papercusp-workspace",
}));

vi.mock("@/lib/use-state-snapshots", () => ({
  useStateSnapshots: () => ({ cards: EMPTY_CARDS }),
}));

vi.mock("@papercusp/operator-core/lib/operator-window-sync", () => ({
  adoptableSharedState: () => null,
  broadcastGenerating: vi.fn(),
  installOperatorWindowSync: () => () => {},
  peerGeneratingNow: () => false,
}));

vi.mock("./voice/voice-mode", () => ({
  getVoiceState: () => ({ mode: "off" }),
  speak: vi.fn(),
  subscribeVoiceState: () => () => {},
}));

vi.mock("./voice/voice-prefs-client", () => ({
  loadVoicePrefsClient: () => ({
    audienceMode: "engineer",
    cardAnsweringEnabled: true,
    proactiveTicksEnabled: false,
  }),
  subscribeVoicePrefsClient: () => () => {},
}));

vi.mock("./voice/voice-converse-handler", () => ({
  setVoiceConverseHandler: vi.fn(),
}));

vi.mock("@papercusp/operator-core/lib/operator-shared-state", () => ({
  sharedState: { paused: true },
}));

import {
  OperatorConversationProvider,
  useOperatorConversation,
  type GenerationFn,
} from "./OperatorConversationProvider";

function Probe() {
  const conversation = useOperatorConversation();
  return (
    <>
      <button
        type="button"
        onClick={() => conversation.sendUserMessage("Stream this reply")}
      >
        Send test
      </button>
      <div data-testid="busy">{String(conversation.busy)}</div>
      <div data-testid="history-hydrated">
        {String(conversation.historyHydrated)}
      </div>
      <div data-testid="error">{conversation.error ?? ""}</div>
      <div data-testid="messages">
        {conversation.messages.map((message, index) => (
          <div
            key={`${message.id ?? "none"}-${index}`}
            data-role={message.role}
            data-seq={typeof message.seq === "number" ? message.seq : "none"}
          >
            {message.content}
          </div>
        ))}
      </div>
    </>
  );
}

describe("OperatorConversationProvider streamed say projection", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    SYNC.turnPage = null;
    sessionStorage.clear();
    sessionStorage.setItem(
      "papercusp.operatorMessages",
      JSON.stringify([{ role: "system", content: "Existing conversation" }]),
    );
    let seq = 100;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => ({
        ok: true,
        status: 200,
        json: async () =>
          init?.method === "POST"
            ? {
                conversationId: "conversation-1",
                turn: { id: `turn-${seq}`, seq: seq++ },
              }
            : { turns: [] },
        text: async () => "",
      })),
    );
  });

  it("renders the first safe say delta before completion, then finalizes one assistant row", async () => {
    let releaseFinal!: () => void;
    const waitForFinal = new Promise<void>((resolve) => {
      releaseFinal = resolve;
    });
    const generationFn: GenerationFn = vi.fn(async () => ({
      chunks: (async function* () {
        yield "<say>First useful words";
        await waitForFinal;
        yield " arrive before completion?</say>";
      })(),
    }));

    render(
      <OperatorConversationProvider generationFn={generationFn}>
        <Probe />
      </OperatorConversationProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Send test" }));

    await waitFor(() => {
      expect(screen.getByText("First useful words")).toBeTruthy();
      expect(screen.getByTestId("busy").textContent).toBe("true");
    });
    expect(screen.getAllByText("First useful words")).toHaveLength(1);

    releaseFinal();

    await waitFor(() => {
      expect(
        screen.getByText("First useful words arrive before completion?"),
      ).toBeTruthy();
      expect(screen.getByTestId("busy").textContent).toBe("false");
    });
    expect(
      screen.getAllByText("First useful words arrive before completion?"),
    ).toHaveLength(1);
    expect(
      screen
        .getByTestId("messages")
        .querySelectorAll('[data-role="assistant"]'),
    ).toHaveLength(1);
  });

  it("backfills the persisted seq onto in-session messages so a streamed chat:ask_choice card is answerable without a reload (P-011)", async () => {
    const generationFn: GenerationFn = vi.fn(async () => ({
      chunks: (async function* () {
        yield "<say>Pick one of these.</say>";
      })(),
    }));

    render(
      <OperatorConversationProvider generationFn={generationFn}>
        <Probe />
      </OperatorConversationProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Send test" }));

    // Both the optimistic user turn and the streamed assistant turn must
    // end up with the server-assigned seq — OperatorChat's onAnswer gate
    // (`typeof msg.seq !== 'number'`) silently drops card clicks on a
    // seq-less message.
    await waitFor(() => {
      const rows = [
        ...screen.getByTestId("messages").querySelectorAll("[data-role]"),
      ];
      const user = rows.filter((r) => r.getAttribute("data-role") === "user");
      const assistant = rows.filter(
        (r) => r.getAttribute("data-role") === "assistant",
      );
      expect(user).toHaveLength(1);
      expect(assistant).toHaveLength(1);
      expect(Number(user[0].getAttribute("data-seq"))).toBeGreaterThanOrEqual(
        100,
      );
      expect(
        Number(assistant[0].getAttribute("data-seq")),
      ).toBeGreaterThanOrEqual(100);
    });
  });

  it("removes an uncommitted streamed row when the stream errors", async () => {
    let failStream!: () => void;
    const waitToFail = new Promise<void>((resolve) => {
      failStream = resolve;
    });
    const generationFn: GenerationFn = vi.fn(async () => ({
      chunks: (async function* () {
        yield "<say>Temporary partial";
        await waitToFail;
        throw new Error("provider unavailable");
      })(),
    }));

    render(
      <OperatorConversationProvider generationFn={generationFn}>
        <Probe />
      </OperatorConversationProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Send test" }));
    await screen.findByText("Temporary partial");

    failStream();

    await waitFor(() => {
      expect(screen.queryByText("Temporary partial")).toBeNull();
      expect(screen.getByTestId("error").textContent).toBe(
        "provider unavailable",
      );
      expect(screen.getByTestId("busy").textContent).toBe("false");
    });
    expect(
      screen
        .getByTestId("messages")
        .querySelectorAll('[data-role="assistant"]'),
    ).toHaveLength(0);
  });

  it("removes the old partial when a newer user turn aborts its generation", async () => {
    let calls = 0;
    const generationFn: GenerationFn = vi.fn(async (request) => {
      calls += 1;
      if (calls === 1) {
        return {
          chunks: (async function* () {
            yield "<say>Old partial";
            await new Promise<void>((resolve) => {
              request.signal.addEventListener("abort", () => resolve(), {
                once: true,
              });
            });
          })(),
        };
      }
      return {
        chunks: (async function* () {
          yield "<say>Replacement response?</say>";
        })(),
      };
    });

    render(
      <OperatorConversationProvider generationFn={generationFn}>
        <Probe />
      </OperatorConversationProvider>,
    );

    const send = screen.getByRole("button", { name: "Send test" });
    fireEvent.click(send);
    await screen.findByText("Old partial");

    fireEvent.click(send);

    await waitFor(() => {
      expect(screen.queryByText("Old partial")).toBeNull();
      expect(screen.getByText("Replacement response?")).toBeTruthy();
      expect(screen.getByTestId("busy").textContent).toBe("false");
    });
    expect(
      screen
        .getByTestId("messages")
        .querySelectorAll('[data-role="assistant"]'),
    ).toHaveLength(1);
  });

  it("fails closed before optimistic mutation when a scoped id has not resolved", async () => {
    const generationFn: GenerationFn = vi.fn(async () => ({
      chunks: (async function* () {
        yield "<say>must not run</say>";
      })(),
    }));

    render(
      <OperatorConversationProvider
        generationFn={generationFn}
        target={{ kind: "work-item", conversationId: null }}
      >
        <Probe />
      </OperatorConversationProvider>,
    );

    // Scoped runtimes do not hydrate the global sessionStorage paint cache.
    expect(screen.queryByText("Existing conversation")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Send test" }));
    await waitFor(() => {
      expect(screen.getByTestId("error").textContent).toMatch(
        /still resolving.*No message was sent/i,
      );
    });
    expect(generationFn).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(screen.getByTestId("messages").children).toHaveLength(0);
  });

  it("marks a scoped conversation history hydrated only after its persisted turn window resolves", async () => {
    SYNC.turnPage = { turns: [], hasMoreEarlier: false };

    render(
      <OperatorConversationProvider
        target={{ kind: "work-item", conversationId: "work-item-empty-99" }}
      >
        <Probe />
      </OperatorConversationProvider>,
    );

    await waitFor(() =>
      expect(screen.getByTestId("history-hydrated").textContent).toBe("true"),
    );
    expect(screen.getByTestId("messages").children).toHaveLength(0);
  });

  it("uses only the explicit scoped id for history, writes, and generation", async () => {
    const generationFn: GenerationFn = vi.fn(async () => ({
      chunks: (async function* () {
        yield "<say>Scoped reply.</say>";
      })(),
    }));

    render(
      <OperatorConversationProvider
        generationFn={generationFn}
        target={{
          kind: "work-item",
          conversationId: "work-item-conversation-42",
        }}
      >
        <Probe />
      </OperatorConversationProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Send test" }));

    await screen.findByText("Scoped reply.");
    await waitFor(() => expect(generationFn).toHaveBeenCalledTimes(1));
    expect(vi.mocked(generationFn).mock.calls[0][0]).toMatchObject({
      conversationId: "work-item-conversation-42",
      modality: "text",
      mayAskActive: false,
    });

    const urls = vi.mocked(fetch).mock.calls.map(([input]) => String(input));
    expect(urls.length).toBeGreaterThanOrEqual(3);
    expect(
      urls.every((url) =>
        url.includes(
          "/api/operator/conversations/work-item-conversation-42/turns",
        ),
      ),
    ).toBe(true);
    expect(urls.some((url) => url.includes("/active/"))).toBe(false);

    // No scoped turn may overwrite the root/global paint cache.
    expect(
      JSON.parse(sessionStorage.getItem("papercusp.operatorMessages") ?? "[]"),
    ).toEqual([{ role: "system", content: "Existing conversation" }]);
  });
});
