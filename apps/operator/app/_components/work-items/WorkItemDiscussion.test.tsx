// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const H = vi.hoisted(() => ({
  rows: [] as Array<{ id: string }>,
  invalidate: vi.fn(),
  providerTargets: vi.fn(),
  chatProps: vi.fn(),
}));

vi.mock("@papercusp/sync", () => ({
  useSyncQuery: () => ({
    data: H.rows,
    loading: false,
    fetching: false,
    error: null,
    failureCount: 0,
    invalidate: H.invalidate,
  }),
}));

vi.mock("@/lib/use-workspace-id", () => ({
  useWorkspaceId: () => "workspace-1",
}));

const conversation = {
  mode: "passive" as const,
  sub: "idle" as const,
  messages: [{ role: "assistant" as const, content: "Existing scoped turn." }],
  error: null,
  busy: false,
  peerBusy: false,
  historyHydrated: true,
  sendUserMessage: vi.fn(),
  generateIdeas: vi.fn(),
  flipMode: vi.fn(),
  bannerText: "Scoped to this item",
  hasMoreEarlier: true,
  loadingEarlier: false,
  loadEarlier: vi.fn(async () => {}),
  answerChoice: vi.fn(async () => {}),
  conversationId: "conversation-existing",
};

vi.mock("../OperatorConversationProvider", () => ({
  OperatorConversationProvider: ({
    target,
    children,
  }: {
    target: unknown;
    children: React.ReactNode;
  }) => {
    H.providerTargets(target);
    return <div data-testid="scoped-provider">{children}</div>;
  },
  useOperatorConversation: () => conversation,
}));

vi.mock("../OperatorChat", () => ({
  OperatorChat: (props: Record<string, unknown>) => {
    H.chatProps(props);
    return <div data-testid="operator-chat-stub" />;
  },
}));

import WorkItemDiscussion from "./WorkItemDiscussion";

afterEach(() => {
  cleanup();
  H.rows = [];
  H.invalidate.mockReset();
  H.providerTargets.mockReset();
  H.chatProps.mockReset();
  conversation.messages = [
    { role: "assistant" as const, content: "Existing scoped turn." },
  ];
  conversation.historyHydrated = true;
  conversation.busy = false;
  conversation.sendUserMessage.mockReset();
  vi.unstubAllGlobals();
});

describe("WorkItemDiscussion", () => {
  it("cannot flex-shrink the chat host to a border inside WorkItemDetail", () => {
    const css = readFileSync(
      join(__dirname, "work-item-discussion.css"),
      "utf8",
    );
    const rootRule = css.match(/\.wi-discussion\s*\{[^}]*\}/)?.[0] ?? "";
    expect(rootRule).toMatch(/flex:\s*0\s+0\s+auto/);
  });

  it("reuses an existing scoped identity without mutating and forwards the full rich-chat runtime", () => {
    H.rows = [{ id: "conversation-existing" }];
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    render(
      <WorkItemDiscussion
        harnessSlug="papercusp"
        workItemId="WI-42"
        title="Keep this inline"
      />,
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(H.providerTargets).toHaveBeenLastCalledWith({
      kind: "work-item",
      conversationId: "conversation-existing",
    });
    expect(screen.getByTestId("operator-chat-stub")).toBeTruthy();
    expect(H.chatProps).toHaveBeenLastCalledWith(
      expect.objectContaining({
        messages: conversation.messages,
        passive: true,
        onSend: conversation.sendUserMessage,
        onGenerateIdeas: conversation.generateIdeas,
        onLoadEarlier: conversation.loadEarlier,
        onAnswerChoice: conversation.answerChoice,
        conversationId: "conversation-existing",
        workspaceId: "workspace-1",
        harnessSlug: "papercusp",
        emptyStateBody: "Starting a discussion about WI-42…",
        showQuickDraftPrompts: false,
      }),
    );
    expect(conversation.sendUserMessage).not.toHaveBeenCalled();
  });

  it("defers opt-in focus until its inert takeover ancestor is released", async () => {
    H.rows = [{ id: "conversation-existing" }];
    const outside = document.createElement("button");
    const coveredPane = document.createElement("div");
    coveredPane.setAttribute("inert", "");
    document.body.append(outside, coveredPane);
    outside.focus();

    const view = render(
      <WorkItemDiscussion
        harnessSlug="papercusp"
        workItemId="WI-43"
        focusWhenInteractive
      />,
      { container: coveredPane },
    );
    const discussion = screen.getByTestId("work-item-discussion-WI-43");
    expect(discussion.getAttribute("tabindex")).toBe("-1");
    expect(document.activeElement).toBe(outside);

    coveredPane.removeAttribute("inert");
    await waitFor(() => expect(document.activeElement).toBe(discussion));

    view.unmount();
    outside.remove();
    coveredPane.remove();
  });

  it("waits for durable history, then starts a new work-item discussion exactly once without global starters", async () => {
    H.rows = [{ id: "conversation-empty" }];
    conversation.messages = [];
    conversation.historyHydrated = false;
    const props = {
      harnessSlug: "papercusp",
      workItemId: "WI-99",
      title: "  Resolve   this blocker  ",
    };

    const view = render(<WorkItemDiscussion {...props} />);
    expect(conversation.sendUserMessage).not.toHaveBeenCalled();

    conversation.historyHydrated = true;
    view.rerender(<WorkItemDiscussion {...props} />);
    await waitFor(() =>
      expect(conversation.sendUserMessage).toHaveBeenCalledWith(
        "Let's discuss WI-99 — Resolve this blocker. Explain what this work item currently needs from me and help me decide or complete the next concrete step.",
      ),
    );

    view.rerender(<WorkItemDiscussion {...props} />);
    expect(conversation.sendUserMessage).toHaveBeenCalledTimes(1);
    expect(H.chatProps).toHaveBeenLastCalledWith(
      expect.objectContaining({
        emptyStateBody: "Starting a discussion about WI-99…",
        showQuickDraftPrompts: false,
      }),
    );
  });

  it("creates the binding through the idempotent POST when the sync read has no row", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ conversation: { id: "conversation-created" } }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<WorkItemDiscussion harnessSlug="papercusp" workItemId="WI-77" />);

    expect(screen.getByRole("status").textContent).toContain("Opening");
    await screen.findByTestId("operator-chat-stub");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/operator/conversations/work-items/WI-77",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ harness: "papercusp" }),
      }),
    );
    expect(H.providerTargets).toHaveBeenLastCalledWith({
      kind: "work-item",
      conversationId: "conversation-created",
    });
    expect(H.invalidate).toHaveBeenCalledTimes(1);
  });

  it("surfaces creation failure, retries, and exposes a close action", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "not ready" }), {
          status: 503,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ conversation: { id: "conversation-retry" } }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);
    const onClose = vi.fn();

    render(
      <WorkItemDiscussion
        harnessSlug="papercusp"
        workItemId="WI-88"
        onClose={onClose}
      />,
    );

    expect((await screen.findByRole("alert")).textContent).toContain(
      "not ready",
    );
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByTestId("operator-chat-stub");
    expect(fetchMock).toHaveBeenCalledTimes(2);

    fireEvent.click(
      screen.getByRole("button", { name: "Close discussion for WI-88" }),
    );
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });
});
